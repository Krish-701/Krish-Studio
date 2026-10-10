import type { AgentKind } from "@prisma/client";
import { db } from "../db";
import { publish } from "../events";
import { chat, llmConfig, ToolsUnsupported, type ChatMessage, type ToolCall, type ToolDef } from "../llm";
import { memoryPrompt, writeMemory } from "../memory";
import * as svc from "../services";
import { enqueue } from "../queue";
import { AGENTS } from "./definitions";
import { runTool, toolDefs, type ToolCtx } from "./tools";

type Kind = Exclude<AgentKind, "USER">;

interface RunOpts {
  projectId: string;
  agent: Kind;
  input: string;
  /** Persist as the project's chat conversation (Director chat). */
  conversation?: boolean;
  depth?: number;
  signal?: AbortSignal;
}

const MAX_STEPS = 12;

async function history(projectId: string): Promise<ChatMessage[]> {
  const rows = await db.agentMessage.findMany({
    where: { projectId, role: { in: ["user", "assistant"] } },
    orderBy: { createdAt: "desc" },
    take: 24,
  });
  return rows.reverse().map((r) => ({
    role: r.role as "user" | "assistant",
    content: r.agent === "DIRECTOR" || r.agent === "USER" ? r.content : `[${AGENTS[r.agent as Kind]?.name ?? r.agent} agent report] ${r.content}`,
    // Director turns carry their reasoning_details back to the model unmodified.
    ...(r.agent === "DIRECTOR" ? storedReasoning(r.reasoning) : {}),
  }));
}

/**
 * reasoning_details are stored as their exact JSON text: Postgres jsonb would reorder keys,
 * and the provider expects the blocks back unmodified.
 */
function storedReasoning(v: unknown): { reasoning_details?: unknown[] } {
  try {
    const parsed = typeof v === "string" ? JSON.parse(v) : v;
    return Array.isArray(parsed) && parsed.length ? { reasoning_details: parsed } : {};
  } catch {
    return {};
  }
}

/**
 * Fallback for models without native tool calling: tools are described in the prompt and the model
 * answers with ```tool blocks, which are parsed into ordinary tool calls.
 */
function promptedToolsBlock(tools: ToolDef[]) {
  const list = tools.map((t) => `- ${t.function.name}: ${t.function.description} Parameters: ${JSON.stringify((t.function.parameters as { properties?: unknown }).properties ?? {})}`).join("\n");
  return `\n\nTOOLS. You can call these tools:\n${list}\n\nTo call tools, reply with one or more blocks exactly like this and nothing else:\n\`\`\`tool\n{"name": "tool_name", "arguments": {"param": "value"}}\n\`\`\`\nYou will get the results back, then continue. When you are finished, reply to the user normally with no tool blocks.`;
}

function parsePromptedCalls(text: string, step: number): { calls: ToolCall[]; rest: string } {
  const calls: ToolCall[] = [];
  const rest = text.replace(/```(?:tool|json)?\s*(\{[\s\S]*?\})\s*```/g, (whole, json: string) => {
    try {
      const v = JSON.parse(json);
      if (typeof v.name !== "string") return whole;
      calls.push({ id: `p${step}_${calls.length}`, type: "function", function: { name: v.name, arguments: JSON.stringify(v.arguments ?? {}) } });
      return "";
    } catch {
      return whole;
    }
  });
  return { calls, rest: rest.trim() };
}

/** Runs one agent to completion with tool calling. Returns its final text. */
export async function runAgent(opts: RunOpts): Promise<string> {
  const { projectId, agent, input, depth = 0 } = opts;
  const def = AGENTS[agent];
  const overview = await svc.projectOverview(projectId).catch(() => null);

  if (!(await llmConfig(agent))) {
    return offlineAgent(projectId, input, opts.conversation);
  }

  const cfg = await llmConfig(agent);
  const tools = toolDefs(def.tools);
  // Use prompted tools when validation showed the model has no native tool calling.
  let prompted = cfg?.caps?.tools === false;
  const system = `${def.system}\n\n${await memoryPrompt(projectId)}\n\nCurrent project snapshot:\n${JSON.stringify(overview).slice(0, 6000)}`;
  const messages: ChatMessage[] = [
    { role: "system", content: prompted ? system + promptedToolsBlock(tools) : system },
    ...(opts.conversation ? await history(projectId) : []),
    { role: "user", content: input },
  ];

  if (opts.conversation) await db.agentMessage.create({ data: { projectId, agent: "USER", role: "user", content: input } });

  const ctx: ToolCtx = {
    projectId,
    agent,
    depth,
    spawn: async (sub, task) => {
      publish(projectId, { type: "agent", agent: sub, status: "thinking", detail: task.slice(0, 120) });
      const report = await runAgent({ projectId, agent: sub, input: task, depth: depth + 1, signal: opts.signal });
      await db.agentMessage.create({ data: { projectId, agent: sub, role: "assistant", content: report } });
      publish(projectId, { type: "chat", messageId: "sub", agent: sub, done: true });
      return report;
    },
  };

  let final = "";
  let finalReasoning: unknown[] | undefined;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (opts.signal?.aborted) break;
    publish(projectId, { type: "agent", agent, status: "thinking" });
    const streamId = `${agent}-${Date.now()}-${step}`;
    let reply: ChatMessage;
    try {
      reply = await chat(messages, {
        agent,
        tools: prompted ? undefined : tools,
        signal: opts.signal,
        // Prompted-tool replies contain tool blocks, so they aren't streamed to the chat.
        onDelta: opts.conversation && !prompted ? (d) => publish(projectId, { type: "chat", messageId: streamId, agent, delta: d }) : undefined,
        onReasoning: (r) => publish(projectId, { type: "agent", agent, status: "thinking", detail: r.slice(-120) }),
      });
    } catch (e) {
      if (!(e instanceof ToolsUnsupported) || prompted) throw e;
      prompted = true;
      messages[0] = { role: "system", content: system + promptedToolsBlock(tools) };
      step--;
      continue;
    }
    if (prompted) {
      const text = typeof reply.content === "string" ? reply.content : "";
      const { calls, rest } = parsePromptedCalls(text, step);
      messages.push({ ...reply, tool_calls: undefined });
      if (!calls.length) {
        final = rest;
        finalReasoning = reply.reasoning_details;
        if (opts.conversation && final) publish(projectId, { type: "chat", messageId: streamId, agent, delta: final });
        break;
      }
      const results: string[] = [];
      for (const call of calls) {
        publish(projectId, { type: "agent", agent, status: "acting", detail: call.function.name });
        const result = await runTool(call.function.name, call.function.arguments, ctx, def.tools);
        if (opts.conversation) await logTool(projectId, agent, call, result, streamId);
        results.push(`Result of ${call.function.name}: ${JSON.stringify(result).slice(0, 12000)}`);
      }
      messages.push({ role: "user", content: results.join("\n\n") });
      continue;
    }
    messages.push(reply);
    if (!reply.tool_calls?.length) {
      final = typeof reply.content === "string" ? reply.content : "";
      finalReasoning = reply.reasoning_details;
      break;
    }
    for (const call of reply.tool_calls) {
      publish(projectId, { type: "agent", agent, status: "acting", detail: call.function.name });
      const result = await runTool(call.function.name, call.function.arguments, ctx, def.tools);
      if (opts.conversation) await logTool(projectId, agent, call, result, streamId);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 12000) });
    }
  }
  publish(projectId, { type: "agent", agent, status: "idle" });
  if (!final) final = "Done.";
  if (opts.conversation) {
    await db.agentMessage.create({ data: { projectId, agent, role: "assistant", content: final, reasoning: finalReasoning?.length ? JSON.stringify(finalReasoning) : undefined } });
    publish(projectId, { type: "chat", messageId: "final", agent, done: true });
  }
  return final;
}

async function logTool(projectId: string, agent: Kind, call: ToolCall, result: unknown, streamId: string) {
  await db.agentMessage.create({
    data: { projectId, agent, role: "tool", content: call.function.name, toolCalls: { args: safeJson(call.function.arguments), result: truncate(result) } as never },
  });
  publish(projectId, { type: "chat", messageId: streamId, agent, done: true });
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function truncate(v: unknown) {
  const s = JSON.stringify(v);
  return s.length > 3000 ? { truncated: s.slice(0, 3000) } : v;
}

/**
 * Without an LLM configured the Director still understands a handful of direct commands,
 * so the studio stays operable offline.
 */
async function offlineAgent(projectId: string, input: string, persist?: boolean) {
  const t = input.toLowerCase();
  let out: string;
  const remember = input.match(/^\s*(?:remember|note|memory)\s*[:,-]?\s*(.+)$/is);
  if (remember) {
    const e = await writeMemory(projectId, { key: remember[1].split(/\s+/).slice(0, 6).join(" "), content: remember[1] }, "DIRECTOR");
    out = `Saved to project memory as “${e.key}”. Every agent will see it.`;
  } else if (/retry/.test(t)) out = `Retrying ${await svc.retryFailed(projectId)} failed job(s).`;
  else if (/(video|clip|animate)/.test(t)) out = `Queued ${(await svc.queueVideos(projectId, "missing")).length} clip(s).`;
  else if (/(frame|image|storyboard|generate)/.test(t)) out = `Queued ${(await svc.queueImages(projectId, "missing")).length} frame(s).`;
  else if (/(voice|dialogue|tts)/.test(t)) {
    const shots = await db.shot.findMany({ where: { projectId, dialogue: { not: null } } });
    for (const s of shots) await svc.queueVoiceover(projectId, s.id).catch(() => {});
    out = `Queued voiceover for ${shots.length} line(s).`;
  } else if (/export|render|mp4/.test(t)) {
    await enqueue({ projectId, type: "EXPORT_MP4", maxAttempts: 1 });
    out = "Exporting the film to MP4.";
  } else if (/status|progress/.test(t)) {
    const o = await svc.projectOverview(projectId);
    out = `${o.totalShots} shots · frames ${JSON.stringify(o.frames)} · clips ${JSON.stringify(o.clips)}`;
  } else {
    out =
      "I'm running in offline mode because no AI model is configured. Add an OpenAI-compatible base URL, key and model in Settings to chat freely. " +
      "Meanwhile I understand: “remember …”, “generate frames”, “generate videos”, “voiceover”, “retry failed”, “status”, “export”.";
  }
  if (persist) {
    await db.agentMessage.create({ data: { projectId, agent: "USER", role: "user", content: input } });
    await db.agentMessage.create({ data: { projectId, agent: "DIRECTOR", role: "assistant", content: out } });
    publish(projectId, { type: "chat", messageId: "final", agent: "DIRECTOR", done: true });
  }
  return out;
}

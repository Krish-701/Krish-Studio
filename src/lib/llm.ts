import { db } from "./db";
import { getSettings, type LlmCaps } from "./settings";

/**
 * OpenAI-compatible chat client. Works with OpenAI, Anthropic's OpenAI-compatible endpoint,
 * OpenRouter, Gemini's OpenAI endpoint, xAI, Groq, Together, Ollama, LM Studio, vLLM...
 * Base URL / key / model come from Settings and can be changed at any time.
 *
 * Reasoning models (OpenRouter `reasoning: { enabled: true }`): the assistant message's
 * `reasoning_details` is captured (streamed or not) and sent back unmodified on the next call,
 * so the model continues its reasoning across tool calls and conversation turns.
 */
export type ChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** Provider reasoning blocks (OpenRouter). Pass back exactly as received. */
  reasoning_details?: unknown[];
  /** Plain-text reasoning summary, for display only (never sent back). */
  reasoning?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export class LlmNotConfigured extends Error {
  constructor() {
    super("The AI assistant isn't configured yet. Add an OpenAI-compatible base URL, API key and model in Settings.");
  }
}

/** The provider/model refused tool definitions (no tool-calling endpoint). */
export class ToolsUnsupported extends Error {}
/** The model can't take image input. */
export class VisionUnsupported extends Error {}

export async function llmConfig(agent?: string) {
  const s = await getSettings();
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(s.llmBaseUrl);
  if (!s.llmBaseUrl || (!s.llmApiKey && !isLocal)) return null;
  const model = (agent && s.agentModels?.[agent]) || s.llmModel;
  const baseUrl = s.llmBaseUrl.replace(/\/$/, "");
  // Capabilities only apply to the model they were measured on.
  const caps = s.llmCaps && s.llmCaps.model === s.llmModel && s.llmCaps.baseUrl === baseUrl ? s.llmCaps : null;
  return {
    baseUrl,
    apiKey: s.llmApiKey,
    model,
    reasoning: s.llmReasoning,
    visionModel: s.visionModel || "",
    openrouter: /openrouter\.ai/.test(baseUrl),
    caps: model === s.llmModel ? caps : null,
  };
}

export async function isLlmConfigured() {
  return !!(await llmConfig());
}

/**
 * Which model to use for an image check, or null when nothing configured can see images.
 * Uses the vision model from Settings if set, else the agent's model unless validation showed it has no vision.
 */
export async function visionModelFor(agent?: string): Promise<string | null> {
  const cfg = await llmConfig(agent);
  if (!cfg) return null;
  if (cfg.visionModel) return cfg.visionModel;
  if (cfg.caps && cfg.caps.vision === false) return null;
  return cfg.model;
}

interface ChatOpts {
  agent?: string;
  /** Override the model (e.g. the vision model). */
  model?: string;
  tools?: ToolDef[];
  temperature?: number;
  json?: boolean;
  /** Override the reasoning setting for this call. */
  reasoning?: boolean;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onReasoning?: (text: string) => void;
}

/** Messages as the provider should see them: no display-only fields, reasoning_details only when reasoning is on. */
function wireMessages(messages: ChatMessage[], keepReasoning: boolean) {
  return messages.map((m) => {
    const { reasoning: _r, reasoning_details, ...rest } = m;
    void _r;
    return keepReasoning && reasoning_details?.length ? { ...rest, reasoning_details } : rest;
  });
}

/** Some models put chain-of-thought inline as <think>…</think>; keep it out of the answer. */
export function stripThink(text: string) {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").replace(/^[\s\S]*?<\/think>\s*/, "");
}

/**
 * Merges streamed reasoning_details fragments. OpenRouter streams each block in pieces that share
 * an index and type; text-like fields are concatenated, everything else keeps its latest non-null value.
 */
function mergeReasoning(into: Record<string, unknown>[], parts: Record<string, unknown>[]) {
  for (const p of parts) {
    const last = into[into.length - 1];
    const same = last && last.type === p.type && (p.index === undefined || last.index === p.index);
    if (!same) {
      into.push({ ...p });
      continue;
    }
    for (const [k, v] of Object.entries(p)) {
      if (v === null || v === undefined) continue;
      if ((k === "text" || k === "summary" || k === "data") && typeof v === "string" && typeof last[k] === "string") last[k] = (last[k] as string) + v;
      else last[k] = v;
    }
  }
}

/** One chat completion (streamed when onDelta is given). Returns the assistant message. */
export async function chat(messages: ChatMessage[], opts: ChatOpts = {}): Promise<ChatMessage> {
  const cfg = await llmConfig(opts.agent);
  if (!cfg) throw new LlmNotConfigured();
  const reasoning = opts.reasoning ?? cfg.reasoning;
  // OpenRouter calls always stream ("stream": true), so long reasoning turns never hit idle timeouts.
  const stream = !!(opts.onDelta || opts.onReasoning || cfg.openrouter || process.env.LLM_STREAM === "1");
  const body: Record<string, unknown> = {
    model: opts.model || cfg.model,
    messages: wireMessages(messages, reasoning),
    temperature: opts.temperature ?? 0.4,
    stream,
  };
  if (reasoning) body.reasoning = { enabled: true };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }
  if (opts.json) body.response_format = { type: "json_object" };

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      ...(cfg.openrouter ? { "HTTP-Referer": process.env.APP_URL || "http://localhost:3000", "X-Title": "Krish Studio" } : {}),
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 || res.status === 404 || res.status === 422) {
      // Some providers reject response_format or the reasoning flag; retry once without it.
      if (opts.json && /response_format|json/i.test(text)) return chat(messages, { ...opts, json: false });
      if (reasoning && /reasoning/i.test(text)) {
        // First drop stored reasoning_details (e.g. from another model); only then turn reasoning off.
        if (messages.some((m) => m.reasoning_details?.length)) {
          console.warn("[llm] provider rejected passed-back reasoning_details, retrying without them:", text.slice(0, 200));
          return chat(messages.map(({ reasoning_details: _d, ...m }) => (void _d, m)), opts);
        }
        console.warn("[llm] provider rejected the reasoning flag, retrying without reasoning:", text.slice(0, 200));
        return chat(messages, { ...opts, reasoning: false });
      }
      if (opts.tools?.length && /tool|function/i.test(text)) throw new ToolsUnsupported(text.slice(0, 300));
      if (messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")) && /image|vision|modalit/i.test(text)) {
        throw new VisionUnsupported(text.slice(0, 300));
      }
    }
    throw new Error(`LLM ${res.status}: ${text.slice(0, 400)}`);
  }

  if (!stream) {
    const data = await res.json();
    if (data.error) throw new Error(`LLM error: ${JSON.stringify(data.error).slice(0, 400)}`);
    const msg = data.choices?.[0]?.message ?? {};
    return {
      role: "assistant",
      content: stripThink(msg.content ?? ""),
      tool_calls: msg.tool_calls?.length ? msg.tool_calls : undefined,
      reasoning_details: msg.reasoning_details?.length ? msg.reasoning_details : undefined,
      reasoning: msg.reasoning || undefined,
    };
  }

  // Streaming: accumulate content, reasoning and tool call deltas.
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoningText = "";
  const details: Record<string, unknown>[] = [];
  const calls: ToolCall[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      let json: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.error) throw new Error(`LLM error: ${JSON.stringify(json.error).slice(0, 400)}`);
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.reasoning) {
        reasoningText += delta.reasoning;
        opts.onReasoning?.(delta.reasoning);
      }
      if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length) mergeReasoning(details, delta.reasoning_details);
      if (delta.content) {
        content += delta.content;
        opts.onDelta?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? 0;
        calls[i] ??= { id: tc.id ?? `call_${i}`, type: "function", function: { name: "", arguments: "" } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name += tc.function.name;
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
      }
    }
  }
  const tool_calls = calls.filter(Boolean);
  return {
    role: "assistant",
    content: stripThink(content),
    tool_calls: tool_calls.length ? tool_calls : undefined,
    reasoning_details: details.length ? details : undefined,
    reasoning: reasoningText || undefined,
  };
}

/** Pulls the first JSON object out of a reply (tolerates code fences, prose and think tags). */
export function extractJson<T>(raw: string): T {
  const text = stripThink(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("Model did not return JSON");
  return JSON.parse(text.slice(start, end + 1)) as T;
}

/** Asks for a JSON object and parses it. Retries once with a stricter instruction if the reply isn't JSON. */
export async function chatJson<T = unknown>(messages: ChatMessage[], opts: Omit<ChatOpts, "json" | "onDelta"> = {}): Promise<T> {
  const msg = await chat(messages, { ...opts, json: true, temperature: opts.temperature ?? 0.2 });
  const text = typeof msg.content === "string" ? msg.content : "";
  try {
    return extractJson<T>(text);
  } catch {
    const again = await chat(
      [...messages, { role: "assistant", content: text }, { role: "user", content: "Reply again with only the JSON object, no other text." }],
      { ...opts, json: true, temperature: 0 },
    );
    return extractJson<T>(typeof again.content === "string" ? again.content : "");
  }
}

export async function testLlm() {
  const msg = await chat([{ role: "user", content: "Reply with the single word: ready" }], { temperature: 0 });
  return typeof msg.content === "string" ? msg.content : "";
}

// A 32×32 solid red PNG, used to check whether the model can see images.
const RED_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGO4IyJCU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAJ3LED3QqzauAAAAAElFTkSuQmCC";

export interface ValidationCheck {
  id: "connect" | "reasoning" | "reasoning_roundtrip" | "tools" | "json" | "vision" | "catalog";
  label: string;
  ok: boolean;
  detail: string;
  ms?: number;
}

/**
 * Runs the main model through everything the studio uses: a plain reply, reasoning (and passing
 * reasoning_details back), a tool-calling round trip, JSON output and image input. The result is saved
 * in Settings so agents pick the right fallbacks (prompted tools, rule-based checks).
 */
export async function validateLlm(): Promise<{ caps: LlmCaps; checks: ValidationCheck[] }> {
  const cfg = await llmConfig();
  if (!cfg) throw new LlmNotConfigured();
  const checks: ValidationCheck[] = [];
  const run = async (id: ValidationCheck["id"], label: string, fn: () => Promise<{ ok: boolean; detail: string }>) => {
    const t = Date.now();
    try {
      const r = await fn();
      checks.push({ id, label, ...r, ms: Date.now() - t });
      return r.ok;
    } catch (e) {
      checks.push({ id, label, ok: false, detail: (e as Error).message.slice(0, 300), ms: Date.now() - t });
      return false;
    }
  };

  let meta: { vision?: boolean; tools?: boolean; reasoning?: boolean } = {};
  {
    // OpenRouter's /models lists input modalities and supported parameters; other providers may list less.
    await run("catalog", "Model listing", async () => {
      const r = await fetch(`${cfg.baseUrl}/models`, { headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {} });
      if (!r.ok) return { ok: !cfg.openrouter, detail: `Listing not available (HTTP ${r.status})` };
      const list = ((await r.json()).data ?? []) as { id: string; architecture?: { input_modalities?: string[] }; supported_parameters?: string[]; context_length?: number }[];
      const m = list.find((x) => x.id === cfg.model);
      if (!m) return cfg.openrouter ? { ok: false, detail: `${cfg.model} is not in OpenRouter's model list. Check the spelling.` } : { ok: true, detail: "Model not listed; capabilities are tested directly below." };
      const params = m.supported_parameters ?? [];
      meta = { vision: m.architecture?.input_modalities?.includes("image"), tools: params.includes("tools"), reasoning: params.includes("reasoning") };
      return {
        ok: true,
        detail: `Found · inputs: ${(m.architecture?.input_modalities ?? ["text"]).join(", ")} · ${m.context_length ?? "?"} tokens context · tools ${meta.tools ? "yes" : "no"} · reasoning ${meta.reasoning ? "yes" : "no"}`,
      };
    });
  }

  let first: ChatMessage | null = null;
  const connected = await run("connect", "Connects and replies", async () => {
    first = await chat([{ role: "user", content: "How many r's are in the word 'strawberry'? Answer with just the number." }], { temperature: 0, reasoning: cfg.reasoning });
    const text = String(first.content ?? "").trim();
    return { ok: !!text, detail: `Replied “${text.slice(0, 60)}”${/3/.test(text) ? "" : " (expected 3)"}` };
  });
  if (!connected) {
    const caps: LlmCaps = { model: cfg.model, baseUrl: cfg.baseUrl, tools: false, vision: false, json: false, reasoning: false, checkedAt: new Date().toISOString(), checks };
    await saveCaps(caps);
    return { caps, checks };
  }

  let reasoningOk = false;
  if (cfg.reasoning) {
    reasoningOk = await run("reasoning", "Returns reasoning_details", async () => {
      const f = first as ChatMessage | null;
      const n = f?.reasoning_details?.length ?? 0;
      return n
        ? { ok: true, detail: `${n} reasoning block(s) received` }
        : { ok: false, detail: "No reasoning_details came back. The model may not support reasoning; agents will work without it." };
    });
    if (reasoningOk) {
      await run("reasoning_roundtrip", "Continues reasoning when details are passed back", async () => {
        const f = first as unknown as ChatMessage;
        const second = await chat(
          [
            { role: "user", content: "How many r's are in the word 'strawberry'? Answer with just the number." },
            { role: "assistant", content: f.content, reasoning_details: f.reasoning_details },
            { role: "user", content: "Are you sure? Think carefully. Answer with just the number." },
          ],
          { temperature: 0 },
        );
        const text = String(second.content ?? "").trim();
        return { ok: !!text, detail: `Second turn replied “${text.slice(0, 60)}” with reasoning_details passed back unmodified` };
      });
    }
  }

  const toolsOk = await run("tools", "Tool calling (call → result → answer)", async () => {
    const tools: ToolDef[] = [
      {
        type: "function",
        function: {
          name: "count_shots",
          description: "Returns how many shots a scene has.",
          parameters: { type: "object", properties: { scene: { type: "number", description: "Scene number" } }, required: ["scene"] },
        },
      },
    ];
    const msgs: ChatMessage[] = [
      { role: "system", content: "You are a film studio assistant. Use tools to answer." },
      { role: "user", content: "How many shots does scene 2 have? Use the tool." },
    ];
    const a = await chat(msgs, { tools, temperature: 0 });
    const call = a.tool_calls?.[0];
    if (!call) return { ok: false, detail: `Model answered without calling the tool: “${String(a.content).slice(0, 80)}”` };
    const args = JSON.parse(call.function.arguments || "{}");
    msgs.push(a, { role: "tool", tool_call_id: call.id, content: JSON.stringify({ scene: args.scene, shots: 7 }) });
    const b = await chat(msgs, { tools, temperature: 0 });
    const text = String(b.content ?? "");
    return {
      ok: /7|seven/i.test(text),
      detail: `Called ${call.function.name}(${call.function.arguments}) then answered “${text.slice(0, 60)}”${a.reasoning_details ? " · reasoning carried through the tool call" : ""}`,
    };
  });

  const jsonOk = await run("json", "JSON output", async () => {
    const r = await chatJson<{ shots: unknown[] }>([{ role: "user", content: 'Return JSON {"shots":[{"title":string}]} with two shot titles for a lighthouse scene.' }], { temperature: 0 });
    return { ok: Array.isArray(r.shots), detail: `Parsed ${Array.isArray(r.shots) ? r.shots.length : 0} shots` };
  });

  const visionModel = cfg.visionModel || cfg.model;
  const visionOk = await run("vision", `Image input (${visionModel})`, async () => {
    if (meta.vision === false && !cfg.visionModel) {
      return { ok: false, detail: `${cfg.model} is text-only. Consistency and mood checks will use rule-based checks; set a vision model in Settings to let agents look at frames.` };
    }
    const r = await chat(
      [{ role: "user", content: [{ type: "text", text: "What single colour fills this image? One word." }, { type: "image_url", image_url: { url: RED_PNG } }] }],
      { temperature: 0, model: visionModel, reasoning: false },
    );
    const text = String(r.content ?? "");
    return { ok: /red/i.test(text), detail: `Saw “${text.slice(0, 40)}” (expected red)` };
  });

  const caps: LlmCaps = {
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    tools: toolsOk,
    // `vision` describes the main model; visionModelOk says whether image checks can run.
    vision: cfg.visionModel ? (meta.vision ?? false) : visionOk,
    visionModelOk: visionOk,
    json: jsonOk,
    reasoning: reasoningOk,
    checkedAt: new Date().toISOString(),
    checks,
  };
  await saveCaps(caps);
  return { caps, checks };
}

async function saveCaps(caps: LlmCaps) {
  await db.appSettings.update({ where: { id: "global" }, data: { llmCaps: caps as never } });
}

/** Shows the model a picture and returns what it says about it (checks image input end to end). */
export async function describeImage(imageUrl: string, question = "Describe this image in one short sentence.") {
  const model = await visionModelFor();
  if (!model) throw new Error("The AI model can't take images (set a vision model in Settings).");
  const msg = await chat([{ role: "user", content: [{ type: "text", text: question }, { type: "image_url", image_url: { url: imageUrl } }] }], { model, temperature: 0, reasoning: false });
  return stripThink(typeof msg.content === "string" ? msg.content : "").trim();
}

/** The red test square: can the model see images at all? */
export async function testVision() {
  return describeImage(RED_PNG, "What colour is this image? Answer with one word.");
}

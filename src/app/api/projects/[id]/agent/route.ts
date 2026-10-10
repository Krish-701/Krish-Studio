import { db } from "@/lib/db";
import { fail, ok, route, type Params } from "@/lib/api";
import { runAgent } from "@/lib/agents/runner";
import { enqueue } from "@/lib/queue";
import { errorMessage } from "@/lib/utils";
import { publish } from "@/lib/events";

export const maxDuration = 300;

export const GET = route(async (_: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const messages = await db.agentMessage.findMany({ where: { projectId: id }, orderBy: { createdAt: "asc" }, take: 300 });
  return ok(messages);
});

/**
 * POST { message, agent? } → chat with the Director (or address a sub-agent directly).
 * POST { action: "check", agent, shotId? } → run an automatic sub-agent check.
 * Tokens stream over the project's SSE channel; the response returns the final text.
 */
export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const b = await req.json();
  if (b.action === "check") {
    const shots = b.shotId ? [b.shotId] : (await db.shot.findMany({ where: { projectId: id, imageAssetId: { not: null } }, select: { id: true } })).map((s) => s.id);
    if (b.agent === "MONITOR") await enqueue({ projectId: id, type: "AGENT_CHECK", input: { agent: "MONITOR" }, maxAttempts: 1 });
    else for (const s of shots) await enqueue({ projectId: id, type: "AGENT_CHECK", shotId: s, input: { agent: b.agent }, maxAttempts: 1 });
    return ok({ queued: shots.length });
  }
  if (b.action === "clear") {
    await db.agentMessage.deleteMany({ where: { projectId: id } });
    return ok({ ok: true });
  }
  const message = String(b.message || "").trim();
  if (!message) return fail("Empty message");
  const agent = ["DIRECTOR", "CONSISTENCY", "MOOD", "MONITOR", "AUDIO"].includes(b.agent) ? b.agent : "DIRECTOR";
  try {
    if (agent === "DIRECTOR") return ok({ reply: await runAgent({ projectId: id, agent, input: message, conversation: true, signal: req.signal }) });
    // Talking to a sub-agent directly: log the exchange in the chat.
    await db.agentMessage.create({ data: { projectId: id, agent: "USER", role: "user", content: `@${agent.toLowerCase()} ${message}` } });
    const reply = await runAgent({ projectId: id, agent, input: message, signal: req.signal });
    await db.agentMessage.create({ data: { projectId: id, agent, role: "assistant", content: reply } });
    publish(id, { type: "chat", messageId: "final", agent, done: true });
    return ok({ reply });
  } catch (e) {
    const msg = errorMessage(e);
    await db.agentMessage.create({ data: { projectId: id, agent: "DIRECTOR", role: "assistant", content: `⚠️ ${msg}` } });
    publish(id, { type: "chat", messageId: "final", agent: "DIRECTOR", done: true });
    publish(id, { type: "agent", agent, status: "idle" });
    return fail(msg, 502);
  }
});

import { db } from "../db";
import { publish } from "../events";
import { chat, isLlmConfigured, stripThink } from "../llm";
import { jobWords, logActivity, shortError } from "../activity";
import { writeWorkspace } from "../workspace";

/**
 * Frequent progress summaries by the Director: after jobs finish and after agent turns, if the last
 * summary is older than SUMMARY_EVERY_MS and enough has happened since, the Director posts a short
 * plain-language update in its chat and in the activity log.
 */
export const SUMMARY_EVERY_MS = Math.max(0.1, Number(process.env.SUMMARY_INTERVAL_MIN) || 5) * 60_000;
const MIN_NEW_ENTRIES = 3;

const g = globalThis as unknown as { __summaryLocks?: Set<string> };
const locks = (g.__summaryLocks ??= new Set());

/** Posts a summary when one is due. `force` skips the interval / activity checks. Returns the text, or null. */
export async function maybeSummarize(projectId: string, opts: { force?: boolean } = {}): Promise<string | null> {
  if (locks.has(projectId)) return null;
  locks.add(projectId);
  try {
    const last = await db.activityLog.findFirst({ where: { projectId, kind: "summary" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    if (!opts.force && last && Date.now() - last.createdAt.getTime() < SUMMARY_EVERY_MS) return null;
    const since = last?.createdAt ?? new Date(0);
    const entries = await db.activityLog.findMany({
      where: { projectId, createdAt: { gt: since }, kind: { not: "summary" } },
      orderBy: { createdAt: "desc" },
      take: 60,
    });
    if (!opts.force && entries.length < MIN_NEW_ENTRIES) return null;

    const project = await db.project.findUnique({ where: { id: projectId }, select: { title: true, stage: true, setupDone: true } });
    if (!project) return null;
    const jobs = await db.job.groupBy({
      by: ["type", "status"],
      where: { projectId, OR: [{ status: { in: ["QUEUED", "RUNNING"] } }, { updatedAt: { gt: since } }] },
      _count: true,
    });
    const counts: Record<string, Record<string, number>> = {};
    for (const j of jobs) (counts[j.status] ??= {})[jobWords(j.type)] = j._count;
    const totalShots = await db.shot.count({ where: { projectId } });
    const framed = await db.shot.count({ where: { projectId, imageAssetId: { not: null } } });
    const clipped = await db.shot.count({ where: { projectId, videoAssetId: { not: null } } });
    const facts = { title: project.title, stage: project.stage, shots: { total: totalShots, withFrame: framed, withClip: clipped }, jobs: counts };

    let text: string | null = null;
    if (await isLlmConfigured()) {
      try {
        const lines = entries
          .slice()
          .reverse()
          .map((e) => `${e.createdAt.toISOString().slice(11, 19)} [${e.kind}/${e.level}] ${e.actor ?? ""}: ${e.message}`)
          .join("\n");
        const reply = await chat(
          [
            {
              role: "system",
              content:
                "You are the DIRECTOR of an AI film studio, writing a short progress update for the film's owner. " +
                "Write 2-4 plain sentences, no lists, no markdown, no IDs: what got done, what is running now, what failed (and why, briefly), and what you will do next. Use shot numbers like #4.",
            },
            { role: "user", content: `Project facts: ${JSON.stringify(facts)}\n\nActivity since the last update (oldest first):\n${lines.slice(-8000)}` },
          ],
          { agent: "DIRECTOR", reasoning: false, signal: AbortSignal.timeout(60_000) },
        );
        text = stripThink(typeof reply.content === "string" ? reply.content : "").trim() || null;
      } catch (e) {
        console.warn("[summary] LLM summary failed, using rule-based:", (e as Error).message);
      }
    }
    if (!text) text = ruleBased(facts, entries);

    // Another process may have posted one meanwhile (separate worker); keep only one.
    const raced = await db.activityLog.findFirst({ where: { projectId, kind: "summary", createdAt: { gt: since } }, select: { id: true } });
    if (raced && !opts.force) return null;

    await db.agentMessage.create({ data: { projectId, agent: "DIRECTOR", role: "summary", content: text, toolCalls: { meta: "summary", facts } as never } });
    publish(projectId, { type: "chat", messageId: "summary", agent: "DIRECTOR", done: true });
    await logActivity(projectId, { kind: "summary", level: "info", actor: "Director", message: text, data: facts });
    writeWorkspace(projectId).catch(() => {});
    return text;
  } catch (e) {
    console.warn("[summary] failed:", (e as Error).message);
    return null;
  } finally {
    locks.delete(projectId);
  }
}

type Facts = { stage: string; shots: { total: number; withFrame: number; withClip: number }; jobs: Record<string, Record<string, number>> };

const list = (m: Record<string, number> | undefined) =>
  Object.entries(m ?? {})
    .map(([k, n]) => `${n} ${k.toLowerCase()}${n > 1 && !/s$/.test(k) ? "s" : ""}`)
    .join(", ");

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function ruleBased(f: Facts, entries: { kind: string; level: string; message: string }[]): string {
  const out: string[] = [];
  const done = list(f.jobs.SUCCEEDED);
  out.push(done ? `Since the last update I finished ${done}.` : "No renders finished since the last update.");
  const running = list(f.jobs.RUNNING);
  const queued = list(f.jobs.QUEUED);
  if (running || queued) out.push(`${running ? `Running now: ${running}.` : ""}${queued ? ` Waiting in the queue: ${queued}.` : ""}`.trim());
  const failed = list(f.jobs.FAILED);
  const lastErr = entries.find((e) => e.level === "error");
  if (failed) out.push(`Failed: ${failed}${lastErr ? ` (latest: ${shortError(lastErr.message, 140)})` : ""}.`);
  const { total, withFrame, withClip } = f.shots;
  const next = failed
    ? "Next I'll look at the failures and retry the ones that look transient."
    : running || queued
      ? "Next I'll keep the queue moving and check each new result."
      : total === 0
        ? "Next step: write or paste the script so I can break it into shots."
        : withFrame < total
          ? `Next I'll board the remaining ${plural(total - withFrame, "shot")} (of ${total}).`
          : withClip < total
            ? `${total === 1 ? "The frame is" : `All ${total} frames are`} in; next I'll animate ${plural(total - withClip, "shot")} without a clip.`
            : "Every shot has a frame and a clip; next is audio, review and export.";
  out.push(next);
  return out.join(" ");
}

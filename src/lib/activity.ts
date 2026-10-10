import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { publish, type LogEntry } from "./events";

/**
 * Project activity log: a human-readable feed of what the worker, the agents and the user did.
 * Shown live in the studio's Log tab and used by the Director's progress summaries.
 */
export interface ActivityInput {
  kind: LogEntry["kind"];
  level?: LogEntry["level"];
  actor?: string | null;
  message: string;
  data?: unknown;
  jobId?: string | null;
  shotId?: string | null;
}

export function toLogEntry(r: { id: string; createdAt: Date; kind: string; level: string; actor: string | null; message: string; data: unknown; jobId: string | null; shotId: string | null }): LogEntry {
  return { ...r, createdAt: r.createdAt.toISOString(), kind: r.kind as LogEntry["kind"], level: r.level as LogEntry["level"] };
}

/** Writes one log row and streams it to the UI. Never throws. */
export async function logActivity(projectId: string, entry: ActivityInput): Promise<LogEntry | null> {
  try {
    const row = await db.activityLog.create({
      data: {
        projectId,
        kind: entry.kind,
        level: entry.level ?? "info",
        actor: entry.actor ?? null,
        message: entry.message.slice(0, 2000),
        data: entry.data === undefined ? undefined : (JSON.parse(JSON.stringify(entry.data)) as Prisma.InputJsonValue),
        jobId: entry.jobId ?? null,
        shotId: entry.shotId ?? null,
      },
    });
    const e = toLogEntry(row);
    publish(projectId, { type: "log", entry: e });
    return e;
  } catch (err) {
    console.warn("[activity] could not log:", (err as Error).message);
    return null;
  }
}

/** One readable line from a (possibly multi-line, Prisma-style) error message. */
export function shortError(msg: string, max = 300): string {
  const lines = msg.split("\n").map((l) => l.trim()).filter(Boolean);
  // Prisma errors: "Invalid `db.x()` invocation in … → code … <actual reason>" — the reason is last.
  const one = lines.length > 1 && /^Invalid `/.test(lines[0]) ? lines[lines.length - 1] : lines.join(" ");
  return one.length > max ? one.slice(0, max) + "…" : one;
}

/** Job type → plain words. */
export const JOB_WORDS: Record<string, string> = {
  PARSE_SCRIPT: "Script breakdown",
  IMAGE: "Frame",
  VIDEO: "Clip",
  UPSCALE: "Upscale",
  INPAINT: "Frame edit",
  TTS: "Voiceover",
  MUSIC: "Music cue",
  SFX: "Sound effect",
  EXPORT_MP4: "Film export",
  EXPORT_PDF: "Storyboard PDF",
  EXPORT_PACKAGE: "Project package",
  AGENT_CHECK: "Agent check",
  WRITE_OUTLINE: "Film outline",
  WRITE_SEQUENCE: "Sequence writing",
  DESIGN_SHEET: "Design sheet",
  CONTACT_SHEET: "Contact sheet",
  MULTISHOT_VIDEO: "Multi-shot clip",
  EXTEND_VIDEO: "Clip extension",
  LIPSYNC: "Lip sync",
  STORY_SCORE: "Story score",
  AUTOPILOT: "Autopilot run",
};

export const jobWords = (type: string) => JOB_WORDS[type] ?? type.toLowerCase().replace(/_/g, " ");

/** Short one-line summary of tool arguments, e.g. `shots=[1,2,3] mode=missing`. */
export function argsSummary(raw: unknown, max = 140): string {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return raw.slice(0, max);
    }
  }
  if (!v || typeof v !== "object") return String(v ?? "").slice(0, max);
  const parts = Object.entries(v as Record<string, unknown>).map(([k, x]) => {
    const s = typeof x === "string" ? (x.length > 40 ? `"${x.slice(0, 40)}…"` : `"${x}"`) : Array.isArray(x) ? `[${x.slice(0, 6).join(",")}${x.length > 6 ? ",…" : ""}]` : typeof x === "object" && x ? "{…}" : String(x);
    return `${k}=${s}`;
  });
  const out = parts.join(" ");
  return out.length > max ? out.slice(0, max) + "…" : out;
}

import { promises as fs } from "fs";
import path from "path";
import { db } from "../db";
import { publish } from "../events";
import { ffmpeg, tmpDir } from "../ffmpeg";
import { chatJson, visionModelFor, type ChatContentPart } from "../llm";
import { memoryPrompt } from "../memory";
import { effectiveStyle, shotCharacters, styleText } from "../prompt-builder";
import { localPath } from "../storage";
import type { AgentKind } from "@prisma/client";

/**
 * Automatic sub-agent checks run after each generation (when "auto agents" is on).
 * With a vision-capable model they compare the frame against character reference images and the style lock;
 * without one they still run rule-based checks.
 */

async function thumbDataUrl(key: string | null | undefined): Promise<string | null> {
  if (!key) return null;
  try {
    const src = await localPath(key);
    const dir = await tmpDir();
    const out = path.join(dir, "t.jpg");
    await ffmpeg(["-i", src, "-vf", "scale='min(512,iw)':-2", "-frames:v", "1", "-q:v", "5", out]);
    const b64 = (await fs.readFile(out)).toString("base64");
    await fs.rm(dir, { recursive: true, force: true });
    return `data:image/jpeg;base64,${b64}`;
  } catch {
    return null;
  }
}

async function addFinding(projectId: string, shotId: string | null, agent: AgentKind, severity: string, message: string, suggestion?: string, fixPrompt?: string) {
  // Avoid duplicate open findings with the same message.
  const dup = await db.agentFinding.findFirst({ where: { projectId, shotId, agent, message, resolved: false } });
  if (dup) return dup;
  const f = await db.agentFinding.create({
    data: { projectId, shotId, agent, severity, message, suggestion, fix: fixPrompt ? { action: "regenerate_image", prompt: fixPrompt } : undefined },
  });
  publish(projectId, { type: "finding", finding: f as never });
  return f;
}

/** Clears earlier open findings for a shot from an agent (a fresh generation supersedes them). */
async function clearOld(shotId: string, agent: AgentKind) {
  await db.agentFinding.updateMany({ where: { shotId, agent, resolved: false }, data: { resolved: true } });
}

interface VisionVerdict {
  score: number;
  issues: { severity: "info" | "warn" | "error"; message: string; suggestion?: string; fixPrompt?: string }[];
}

export async function consistencyCheck(shotId: string) {
  const shot = await db.shot.findUnique({ where: { id: shotId }, include: { characters: true, project: true } });
  if (!shot?.imageAssetId) return;
  const frame = await db.asset.findUnique({ where: { id: shot.imageAssetId } });
  const chars = await shotCharacters(shot);
  publish(shot.projectId, { type: "agent", agent: "CONSISTENCY", status: "thinking", detail: `Checking shot #${shot.order + 1}` });
  await clearOld(shotId, "CONSISTENCY");

  for (const c of chars) {
    if (c.references.length) {
      await db.agentFinding.updateMany({ where: { projectId: shot.projectId, shotId: null, agent: "CONSISTENCY", resolved: false, message: { startsWith: `${c.name} has no reference images` } }, data: { resolved: true } });
    } else {
      await addFinding(shot.projectId, null, "CONSISTENCY", "warn", `${c.name} has no reference images, so their look can drift between shots.`, `Upload front, side and 3/4 reference images for ${c.name} in Characters.`);
    }
  }
  if ((frame?.meta as Record<string, unknown>)?.preview) {
    await addFinding(shot.projectId, null, "MONITOR", "info", "Frames are coming from the offline preview renderer, not Magnific.", "Add your Magnific MCP access token in Settings, then regenerate.");
  }

  // Needs a model that can see images; text-only models fall back to the rule-based checks above.
  const visionModel = await visionModelFor("CONSISTENCY");
  const withRefs = chars.filter((c) => c.references.length);
  if (visionModel && withRefs.length && frame && !(frame.meta as Record<string, unknown>)?.preview) {
    try {
      const content: ChatContentPart[] = [
        { type: "text", text: `Shot #${shot.order + 1} prompt:\n${shot.prompt || shot.description}\n\nCompare the GENERATED FRAME (first image) with each character's reference images. Return JSON {"score":0-100,"issues":[{"severity":"info|warn|error","message":"...","suggestion":"...","fixPrompt":"full corrected image prompt"}]}. Only report real, visible mismatches (face, hair, age, build, skin tone, wardrobe, props). Empty issues if consistent.` },
      ];
      const f = await thumbDataUrl(frame.storageKey);
      if (!f) return;
      content.push({ type: "image_url", image_url: { url: f } });
      for (const c of withRefs) {
        content.push({ type: "text", text: `Reference for ${c.name}: ${c.description}` });
        for (const r of c.references.slice(0, 2)) {
          const d = await thumbDataUrl(r.storageKey);
          if (d) content.push({ type: "image_url", image_url: { url: d } });
        }
      }
      const v = await chatJson<VisionVerdict>(
        [{ role: "system", content: `You are the Character Consistency agent of a film studio. You compare frames to character reference sheets.\n\n${await memoryPrompt(shot.projectId, 2000)}` }, { role: "user", content }],
        { agent: "CONSISTENCY", model: visionModel, reasoning: false },
      );
      await db.asset.update({ where: { id: frame.id }, data: { meta: { ...(frame.meta as object), consistencyScore: v.score } } });
      for (const i of v.issues ?? []) await addFinding(shot.projectId, shotId, "CONSISTENCY", i.severity || "warn", i.message, i.suggestion, i.fixPrompt);
      publish(shot.projectId, { type: "shot", shotId, patch: { consistencyScore: v.score } });
    } catch (e) {
      console.warn("[consistency] vision check skipped:", (e as Error).message);
    }
  }
  publish(shot.projectId, { type: "agent", agent: "CONSISTENCY", status: "idle" });
}

export async function moodCheck(shotId: string) {
  const shot = await db.shot.findUnique({ where: { id: shotId }, include: { project: true } });
  if (!shot?.imageAssetId) return;
  const style = effectiveStyle(shot.project, shot);
  await clearOld(shotId, "MOOD");
  if (!style.enabled) {
    const open = await db.agentFinding.findFirst({ where: { projectId: shot.projectId, agent: "MOOD", shotId: null, resolved: false } });
    if (!open) await addFinding(shot.projectId, null, "MOOD", "warn", "No style lock is set, so look and colour may vary from shot to shot.", "Open Style and lock a look, or ask the Director to define one from your references.");
    return;
  }
  const visionModel = await visionModelFor("MOOD");
  const frame = await db.asset.findUnique({ where: { id: shot.imageAssetId } });
  if (!visionModel || !frame || (frame.meta as Record<string, unknown>)?.preview) return;
  publish(shot.projectId, { type: "agent", agent: "MOOD", status: "thinking", detail: `Checking shot #${shot.order + 1}` });
  try {
    const img = await thumbDataUrl(frame.storageKey);
    if (!img) return;
    const v = await chatJson<VisionVerdict>(
      [
        { role: "system", content: `You are the Mood & Tone agent of a film studio. You judge whether a frame matches the locked visual style.\n\n${await memoryPrompt(shot.projectId, 2000)}` },
        {
          role: "user",
          content: [
            { type: "text", text: `Locked style: ${styleText(style)}\nReturn JSON {"score":0-100,"issues":[{"severity","message","suggestion","fixPrompt"}]}. Report only clear drifts in palette, lighting, era, texture or tone.` },
            { type: "image_url", image_url: { url: img } },
          ],
        },
      ],
      { agent: "MOOD", model: visionModel, reasoning: false },
    );
    for (const i of v.issues ?? []) await addFinding(shot.projectId, shotId, "MOOD", i.severity || "warn", i.message, i.suggestion, i.fixPrompt);
  } catch (e) {
    console.warn("[mood] check skipped:", (e as Error).message);
  } finally {
    publish(shot.projectId, { type: "agent", agent: "MOOD", status: "idle" });
  }
}

/** Monitor agent sweep: stuck jobs, repeated failures. */
export async function monitorSweep(projectId: string) {
  const stuck = await db.job.findMany({ where: { projectId, status: "RUNNING", updatedAt: { lt: new Date(Date.now() - 20 * 60_000) } } });
  for (const j of stuck) {
    await db.job.update({ where: { id: j.id }, data: { status: "FAILED", error: "No progress for 20 minutes (worker restarted or provider stalled)." } });
    await addFinding(projectId, j.shotId, "MONITOR", "error", `A ${j.type.toLowerCase()} job stalled and was stopped.`, "Use Retry on the shot.");
  }
  const failed = await db.job.findMany({ where: { projectId, status: "FAILED", attempts: { gte: 3 } }, take: 20 });
  for (const j of failed) {
    const msg = j.error ?? "";
    const why = /moderat|safety|policy/i.test(msg)
      ? "The provider's content filter rejected the prompt."
      : /credit|balance|insufficient/i.test(msg)
        ? "Your Magnific account is out of credits."
        : /unauthori|401|403|token/i.test(msg)
          ? "The Magnific token was rejected."
          : /duration|resolution|aspect/i.test(msg)
            ? "The chosen model doesn't support these settings."
            : null;
    if (why) await addFinding(projectId, j.shotId, "MONITOR", "error", why, msg.slice(0, 200));
  }
}

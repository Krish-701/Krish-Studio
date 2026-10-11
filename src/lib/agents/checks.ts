import { promises as fs } from "fs";
import path from "path";
import { db } from "../db";
import { publish } from "../events";
import { ffmpeg, tmpDir } from "../ffmpeg";
import { chatJson, visionModelFor, type ChatContentPart } from "../llm";
import { memoryPrompt } from "../memory";
import { effectiveStyle, shotCharacters, shotElements, styleText } from "../prompt-builder";
import { localPath } from "../storage";
import type { AgentKind } from "@prisma/client";
import { logActivity } from "../activity";
import { AGENTS } from "./definitions";

/**
 * Automatic sub-agent checks run after each generation (when "auto agents" is on).
 * With a vision-capable model (Qwen Omni and other multimodal models) they compare the frame against the asset library —
 * character sheets, the set plate, the colour & mood board — and the style lock; without one they still run rule-based checks.
 * libraryCheck runs once after each design sheet to confirm the sheet itself matches its description.
 */

const isPreview = (a: { meta: unknown } | null | undefined) => !!(a?.meta as Record<string, unknown> | null)?.preview;

/** The best single reference image of a library item: its sheet / board first, then the first cut reference. */
function libraryImage<T extends { role: string; kind: string; meta: unknown }>(refs: T[]) {
  const imgs = refs.filter((a) => a.kind === "IMAGE");
  return imgs.find((a) => a.role === "MOODBOARD") ?? imgs.find((a) => a.role === "CHARACTER_SHEET") ?? imgs.find((a) => a.role === "ELEMENT_REF") ?? imgs[0] ?? null;
}

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
  const shot = shotId ? await db.shot.findUnique({ where: { id: shotId }, select: { order: true } }).catch(() => null) : null;
  await logActivity(projectId, {
    kind: "agent",
    level: severity === "error" ? "error" : "warn",
    actor: AGENTS[agent as keyof typeof AGENTS]?.name ?? agent,
    message: `${shot ? `Shot #${shot.order + 1}: ` : ""}${message}`,
    data: { findingId: f.id, severity, suggestion, fixPrompt },
    shotId,
  });
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
  const shot = await db.shot.findUnique({ where: { id: shotId }, include: { characters: true, elements: true, scene: true, project: true } });
  if (!shot?.imageAssetId) return;
  const frame = await db.asset.findUnique({ where: { id: shot.imageAssetId } });
  const chars = await shotCharacters(shot);
  const { location } = await shotElements(shot);
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
  const plate = location ? libraryImage(location.references) : null;
  if (visionModel && (withRefs.length || plate) && frame && !isPreview(frame)) {
    try {
      const content: ChatContentPart[] = [
        { type: "text", text: `Shot #${shot.order + 1} prompt:\n${shot.prompt || shot.description}\n\nCompare the GENERATED FRAME (first image) with the asset library images that follow: each character's design sheet / references${plate ? " and the film set plate" : ""}. Return JSON {"score":0-100,"issues":[{"severity":"info|warn|error","message":"...","suggestion":"...","fixPrompt":"full corrected image prompt"}]}. Only report real, visible mismatches (face, hair, age, build, skin tone, wardrobe, props, set layout). Empty issues if consistent.` },
      ];
      const f = await thumbDataUrl(frame.storageKey);
      if (!f) return;
      content.push({ type: "image_url", image_url: { url: f } });
      for (const c of withRefs) {
        content.push({ type: "text", text: `Reference for ${c.name}: ${c.description}` });
        // The turnaround sheet shows every angle in one image; then the best single angle.
        const sheet = c.references.find((r) => r.role === "CHARACTER_SHEET" || r.id === c.sheetAssetId);
        const picks = [sheet, ...c.references.filter((r) => r.role === "CHARACTER_REF")].filter((r, i, arr): r is NonNullable<typeof r> => !!r && arr.indexOf(r) === i).slice(0, 2);
        for (const r of picks) {
          const d = await thumbDataUrl(r.storageKey);
          if (d) content.push({ type: "image_url", image_url: { url: d } });
        }
      }
      if (plate && location) {
        const d = await thumbDataUrl(plate.storageKey);
        if (d) content.push({ type: "text", text: `Film set "${location.name}": ${location.description}` }, { type: "image_url", image_url: { url: d } });
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
  const shot = await db.shot.findUnique({ where: { id: shotId }, include: { characters: true, elements: true, scene: true, project: true } });
  if (!shot?.imageAssetId) return;
  const style = effectiveStyle(shot.project, shot);
  await clearOld(shotId, "MOOD");
  const { mood } = await shotElements(shot);
  const board = mood ? libraryImage(mood.references) : null;
  if (!style.enabled && !mood) {
    const open = await db.agentFinding.findFirst({ where: { projectId: shot.projectId, agent: "MOOD", shotId: null, resolved: false } });
    if (!open) await addFinding(shot.projectId, null, "MOOD", "warn", "No style lock is set, so look and colour may vary from shot to shot.", "Open Style and lock a look, or ask the Director to define one from your references.");
    return;
  }
  const visionModel = await visionModelFor("MOOD");
  const frame = await db.asset.findUnique({ where: { id: shot.imageAssetId } });
  if (!visionModel || !frame || isPreview(frame)) return;
  publish(shot.projectId, { type: "agent", agent: "MOOD", status: "thinking", detail: `Checking shot #${shot.order + 1}` });
  try {
    const img = await thumbDataUrl(frame.storageKey);
    if (!img) return;
    const boardImg = board && !isPreview(board) ? await thumbDataUrl(board.storageKey) : null;
    const look = [styleText(style), mood?.description && `Colour & mood board "${mood.name}": ${mood.description}`].filter(Boolean).join("\n");
    const v = await chatJson<VisionVerdict>(
      [
        { role: "system", content: `You are the Mood & Tone agent of a film studio. You judge whether a frame matches the locked visual style.\n\n${await memoryPrompt(shot.projectId, 2000)}` },
        {
          role: "user",
          content: [
            { type: "text", text: `Locked look:\n${look}\nThe first image is the frame${boardImg ? "; the second is the film's colour & mood board (palette, lighting, texture)" : ""}. Return JSON {"score":0-100,"issues":[{"severity","message","suggestion","fixPrompt"}]}. Report only clear drifts in palette, lighting, era, texture or tone.` },
            { type: "image_url", image_url: { url: img } },
            ...(boardImg ? [{ type: "image_url" as const, image_url: { url: boardImg } }] : []),
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

const SHEET_ASK: Record<string, string> = {
  character: "This should be a character turnaround: the SAME person in four full-body views (front, three-quarter, side, back), identical face, hair, build and wardrobe, matching the description.",
  wardrobe: "This should be one full-body image of the character wearing the described look.",
  location: "These should be four views of the SAME film set (2×2 grid), consistent architecture and props, no people, matching the description.",
  environment: "These should be four views of the SAME environment / atmosphere (2×2 grid), consistent geography and colour, no people, matching the description.",
  prop: "This should be one clear product shot of the described prop on a neutral background.",
  mood: "This should be a colour & mood board: palette swatches, lighting and texture samples, no people, matching the described look.",
};

/**
 * One vision call after a design sheet: does the sheet match its description? Logs a finding when it doesn't.
 * Skipped for offline previews and when no configured model can see images.
 */
export async function libraryCheck(projectId: string, item: { name: string; kind: string; description: string; assetId: string }) {
  try {
    const asset = await db.asset.findUnique({ where: { id: item.assetId } });
    if (!asset || isPreview(asset)) return null;
    const agent: AgentKind = item.kind === "character" || item.kind === "wardrobe" ? "CONSISTENCY" : "MOOD";
    const visionModel = await visionModelFor(agent);
    if (!visionModel) return null;
    const img = await thumbDataUrl(asset.storageKey);
    if (!img) return null;
    const v = await chatJson<{ ok: boolean; score?: number; problems?: string[] }>(
      [
        { role: "system", content: "You are the asset librarian of a film studio. You check reference sheets before they are used for every frame of the film. Be strict but only about visible problems." },
        {
          role: "user",
          content: [
            { type: "text", text: `${SHEET_ASK[item.kind] ?? SHEET_ASK.prop}\nName: ${item.name}\nDescription: ${item.description || "(none)"}\nReturn JSON {"ok":true|false,"score":0-100,"problems":["..."]}.` },
            { type: "image_url", image_url: { url: img } },
          ],
        },
      ],
      { agent, model: visionModel, reasoning: false },
    );
    await db.asset.update({ where: { id: asset.id }, data: { meta: { ...((asset.meta as object) ?? {}), libraryCheck: { ok: !!v.ok, score: v.score ?? null } } } });
    if (!v.ok || (v.score ?? 100) < 60) {
      await addFinding(projectId, null, agent, "warn", `Asset library: the ${item.kind} sheet for ${item.name} doesn't match its description${v.problems?.length ? ` (${v.problems.slice(0, 3).join("; ")})` : ""}.`, `Open Assets and press Redo on ${item.name}, or sharpen its description first.`);
    }
    return v;
  } catch (e) {
    console.warn("[library] sheet check skipped:", (e as Error).message);
    return null;
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

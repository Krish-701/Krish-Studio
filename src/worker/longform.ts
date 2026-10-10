import { promises as fs } from "fs";
import path from "path";
import type { Job, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { publish } from "@/lib/events";
import { enqueue } from "@/lib/queue";
import { ffmpeg, tmpDir } from "@/lib/ffmpeg";
import { generate, providersFor } from "@/lib/generation/router";
import type { GenContext, ImageRequest } from "@/lib/generation/types";
import type { MagnificProvider } from "@/lib/generation/magnific";
import { buildContactSheetRequest, buildMultishotRequest, characterRefList, effectiveStyle, styleText } from "@/lib/prompt-builder";
import { gridFor, splitGrid, toRef } from "@/lib/media";
import { DEFAULT_IMAGE_MODEL } from "@/lib/generation/catalog";
import { localPath, newKey, putFile } from "@/lib/storage";
import { upsertShotVideoClip } from "@/lib/timeline";
import { writeOutline, writeSequence } from "@/lib/script/writer";
import { durationOf, persist } from "./store";

/**
 * Jobs for long-form production: writing (outline, sequences), design sheets for cast and sets,
 * contact sheets per scene, multi-shot scene clips and clip extension.
 * Returns undefined for job types it doesn't handle.
 */
export async function runLongform(job: Job, ctx: GenContext): Promise<unknown> {
  const input = (job.input ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (job.type) {
    case "WRITE_OUTLINE": {
      const outline = await writeOutline(job.projectId, ctx.onProgress);
      const seqs = await db.sequence.findMany({ where: { projectId: job.projectId }, orderBy: { index: "asc" } });
      // "Write my film": board every sequence right after the outline.
      if (input.writeAll) for (const s of seqs) await enqueue({ projectId: job.projectId, type: "WRITE_SEQUENCE", input: { sequenceId: s.id }, maxAttempts: 2 });
      return { acts: outline.acts?.length ?? 0, sequences: seqs.length };
    }

    case "WRITE_SEQUENCE":
      return writeSequence(input.sequenceId, ctx.onProgress);

    case "DESIGN_SHEET":
      return designSheet(job, input, ctx);

    case "CONTACT_SHEET":
      return contactSheet(job, input, ctx);

    case "MULTISHOT_VIDEO": {
      const req = await buildMultishotRequest(input.shotIds, { model: input.model });
      await ctx.onProgress(3, `${req.multiPrompt?.length ?? 0} shots in one call · ${req.references?.length ?? 0} references`);
      const res = await generate("video", ctx, (p) => p.video?.(req, ctx), job.provider);
      await ctx.onProgress(90, "Cutting the scene into shots");
      const stored = await persist(job.projectId, "clips", res);
      const total = await durationOf(stored.key, res.durationSec ?? req.durationSec);
      const whole = await db.asset.create({
        data: {
          projectId: job.projectId, kind: "VIDEO", role: "SHOT_VIDEO", name: req.label, storageKey: stored.key, url: stored.url, mimeType: stored.mime, durationSec: total, providerRef: res.providerRef,
          meta: { multishot: true, shotIds: req.shotIds, model: req.model ?? "auto", provider: res.providerName, preview: !!res.meta?.preview } as Prisma.InputJsonValue,
        },
      });
      // Split by the requested shot lengths, scaled to the clip the model actually returned.
      const wanted = req.multiPrompt!.map((m) => m.durationSec);
      const scale = total / wanted.reduce((a, b) => a + b, 0);
      const dir = await tmpDir();
      try {
        let t = 0;
        for (const [i, shotId] of req.shotIds.entries()) {
          const len = wanted[i] * scale;
          const out = path.join(dir, `s${i}.mp4`);
          await ffmpeg(["-ss", t.toFixed(3), "-t", len.toFixed(3), "-i", await localPath(stored.key), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-movflags", "+faststart", out]);
          t += len;
          const key = newKey(job.projectId, "clips", "video/mp4");
          const part = await putFile(key, await fs.readFile(out), "video/mp4");
          const dur = await durationOf(part.key, len);
          const asset = await db.asset.create({
            data: {
              projectId: job.projectId, shotId, kind: "VIDEO", role: "SHOT_VIDEO", storageKey: part.key, url: part.url, mimeType: "video/mp4", durationSec: dur,
              meta: { fromMultishot: whole.id, model: req.model ?? "auto", provider: res.providerName, mode: "multishot", preview: !!res.meta?.preview } as Prisma.InputJsonValue,
            },
          });
          await db.shot.update({ where: { id: shotId }, data: { videoAssetId: asset.id, videoStatus: "DONE" } });
          await upsertShotVideoClip(job.projectId, shotId, asset.id, dur);
          publish(job.projectId, { type: "shot", shotId, patch: { videoAssetId: asset.id, videoUrl: asset.url, videoStatus: "DONE" } });
        }
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
      publish(job.projectId, { type: "refresh", scope: "timeline" });
      return { assetId: whole.id, shots: req.shotIds.length, durationSec: total, provider: res.providerName };
    }

    case "LIPSYNC": {
      // Re-sync the shot's clip to its latest voiceover.
      const shot = await db.shot.findUniqueOrThrow({ where: { id: job.shotId! } });
      if (!shot.videoAssetId) throw new Error("Make the clip first, then lip sync it.");
      const voice = await db.asset.findFirst({ where: { shotId: shot.id, role: "VOICEOVER" }, orderBy: { createdAt: "desc" } });
      if (!voice) throw new Error("Generate this shot's voice first (it has no voiceover yet).");
      const clip = await db.asset.findUniqueOrThrow({ where: { id: shot.videoAssetId } });
      const speaker = shot.speaker ? await db.character.findFirst({ where: { projectId: job.projectId, name: { equals: shot.speaker, mode: "insensitive" } } }) : null;
      const res = await generate("video", ctx, (p) => p.lipsync?.({ video: toRef(clip, "Clip"), audio: { ...toRef(voice, "Dialogue"), media: "audio" }, voiceId: speaker?.voiceId ?? null }, ctx), job.provider);
      const stored = await persist(job.projectId, "clips", res);
      const dur = await durationOf(stored.key, clip.durationSec ?? shot.durationSec);
      const asset = await db.asset.create({
        data: { projectId: job.projectId, shotId: shot.id, kind: "VIDEO", role: "SHOT_VIDEO", storageKey: stored.key, url: stored.url, mimeType: "video/mp4", durationSec: dur, providerRef: res.providerRef, meta: { mode: "lipsync", from: clip.id, voice: voice.id, provider: res.providerName, preview: !!res.meta?.preview } },
      });
      await db.shot.update({ where: { id: shot.id }, data: { videoAssetId: asset.id, videoStatus: "DONE" } });
      await upsertShotVideoClip(job.projectId, shot.id, asset.id, dur);
      publish(job.projectId, { type: "shot", shotId: shot.id, patch: { videoAssetId: asset.id, videoStatus: "DONE" } });
      publish(job.projectId, { type: "refresh", scope: "timeline" });
      return { assetId: asset.id, durationSec: dur };
    }

    case "EXTEND_VIDEO": {
      // Continue the previous shot's clip into this shot (no cut in time).
      const shot = await db.shot.findUniqueOrThrow({ where: { id: job.shotId! } });
      const prev = await db.shot.findFirst({ where: { projectId: job.projectId, order: { lt: shot.order } }, orderBy: { order: "desc" } });
      const srcId = input.sourceAssetId ?? prev?.videoAssetId;
      if (!srcId && prev) {
        // Wait while the previous shot's clip is still being made.
        const pending = await db.job.findFirst({
          where: { projectId: job.projectId, status: { in: ["QUEUED", "RUNNING"] }, OR: [{ shotId: prev.id, type: { in: ["VIDEO", "EXTEND_VIDEO"] } }, { type: "MULTISHOT_VIDEO" }] },
        });
        if (pending) return { __deferred: 15_000, step: `Waiting for shot #${prev.order + 1}` };
      }
      if (!srcId) throw new Error("Nothing to extend: the previous shot has no clip yet.");
      const src = await db.asset.findUniqueOrThrow({ where: { id: srcId } });
      const srcDur = src.durationSec ?? 0;
      const res = await generate("video", ctx, (p) => p.extend?.({ video: toRef(src, "Clip to extend"), prompt: input.prompt || `${shot.description} ${shot.motionPrompt}`.trim(), durationSec: shot.durationSec, withSound: shot.withSound }, ctx), job.provider);
      const stored = await persist(job.projectId, "clips", res);
      let key = stored.key;
      let dur = await durationOf(key, shot.durationSec);
      // Some extenders return source + new footage; keep only the new part.
      if (dur > shot.durationSec + 1 && srcDur > 0) {
        const dir = await tmpDir();
        const out = path.join(dir, "tail.mp4");
        await ffmpeg(["-ss", Math.max(0, dur - shot.durationSec).toFixed(3), "-i", await localPath(key), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", out]);
        key = (await putFile(newKey(job.projectId, "clips", "video/mp4"), await fs.readFile(out), "video/mp4")).key;
        await fs.rm(dir, { recursive: true, force: true });
        dur = await durationOf(key, shot.durationSec);
      }
      const url = (await db.asset.create({ data: { projectId: job.projectId, kind: "VIDEO", role: "SHOT_VIDEO", storageKey: key, url: `/api/files/${key}`, mimeType: "video/mp4", durationSec: dur, providerRef: res.providerRef, meta: { mode: "extend", extendedFrom: src.id, provider: res.providerName, preview: !!res.meta?.preview } } })).id;
      await db.shot.update({ where: { id: shot.id }, data: { videoAssetId: url, videoStatus: "DONE" } });
      await upsertShotVideoClip(job.projectId, shot.id, url, dur);
      publish(job.projectId, { type: "shot", shotId: shot.id, patch: { videoAssetId: url, videoStatus: "DONE" } });
      publish(job.projectId, { type: "refresh", scope: "timeline" });
      return { assetId: url, durationSec: dur };
    }
  }
  return undefined;
}

const TURNAROUND = ["front", "three_quarter", "side", "back"] as const;

/**
 * Design sheets:
 *  - character turnaround: front / three-quarter / side / back in one image, cut into four angle references
 *  - wardrobe look: the character in a named costume (or at another age)
 *  - set plate: a 2×2 of the location (wide, reverse, detail, alternate angle) cut into four references
 *  - prop: the object on a neutral background
 * The user's own photos are kept as the strongest references and passed into the sheet.
 */
async function designSheet(job: Job, input: Record<string, any>, ctx: GenContext) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const project = await db.project.findUniqueOrThrow({ where: { id: job.projectId } });
  const style = effectiveStyle(project, { styleOverride: null } as never);
  const look = styleText(style);
  const sheetModel = input.model || (project.defaults as Record<string, string> | null)?.image || DEFAULT_IMAGE_MODEL;

  if (input.characterId) {
    const c = await db.character.findUniqueOrThrow({ where: { id: input.characterId }, include: { references: true } });
    const own = characterRefList({ ...c, references: c.references.filter((a) => !(a.meta as Record<string, unknown>)?.fromSheet) }).slice(0, 4);
    const wardrobe = input.kind === "wardrobe";
    const req: ImageRequest = wardrobe
      ? {
          prompt: `Full-body character reference of ${c.name}: ${c.description}. Wearing their "${input.look}" look: ${input.lookDescription ?? input.look}. Same face, hair and build as the references. Plain neutral studio background, even light. ${look}`,
          aspectRatio: "3:4",
          model: sheetModel,
          references: own.map((r) => ({ ...r, type: "character" })),
          label: `${c.name} · ${input.look}`,
        }
      : {
          prompt: `Character design sheet (turnaround) of ${c.name}: ${c.description}. Four full-body views side by side of the same person — front, three-quarter, side profile, back — identical face, hair, build and wardrobe in every view, neutral light grey studio background, even soft light, no text. ${look}`,
          aspectRatio: "21:9",
          model: sheetModel,
          references: own.map((r) => ({ ...r, type: "character" })),
          label: `${c.name} · design sheet`,
          grid: { cols: 4, rows: 1, labels: TURNAROUND.map((a) => `${c.name} — ${a.replace("_", "-")} view`) },
        };
    const res = await generate("image", ctx, (p) => p.image?.(req, ctx), job.provider);
    await ctx.onProgress(85, wardrobe ? "Saving look" : "Cutting the sheet into angle references");
    const stored = await persist(job.projectId, "characters", res);
    if (wardrobe) {
      const a = await db.asset.create({
        data: { projectId: job.projectId, characterId: c.id, kind: "IMAGE", role: "WARDROBE_REF", name: input.look, storageKey: stored.key, url: stored.url, mimeType: stored.mime, providerRef: res.providerRef, meta: { look: input.look, description: input.lookDescription ?? "", preview: !!res.meta?.preview } },
      });
      publish(job.projectId, { type: "refresh", scope: "characters" });
      return { assetId: a.id };
    }
    const sheet = await db.asset.create({
      data: { projectId: job.projectId, characterId: c.id, kind: "IMAGE", role: "CHARACTER_SHEET", name: `${c.name} design sheet`, storageKey: stored.key, url: stored.url, mimeType: stored.mime, providerRef: res.providerRef, meta: { preview: !!res.meta?.preview } },
    });
    // Replace earlier sheet-derived angles; keep the user's own photos.
    await db.asset.deleteMany({ where: { characterId: c.id, OR: [{ role: "CHARACTER_SHEET", id: { not: sheet.id } }, { role: "CHARACTER_REF", meta: { path: ["fromSheet"], equals: true } }] } });
    const tiles = await splitGrid(stored.key, 4, 1);
    for (const [i, buf] of tiles.entries()) {
      const hasOwn = c.references.some((a) => a.role === "CHARACTER_REF" && a.angle === TURNAROUND[i] && !(a.meta as Record<string, unknown>)?.fromSheet);
      if (hasOwn) continue;
      const t = await putFile(newKey(job.projectId, "characters", "image/png"), buf, "image/png");
      await db.asset.create({ data: { projectId: job.projectId, characterId: c.id, kind: "IMAGE", role: "CHARACTER_REF", angle: TURNAROUND[i], storageKey: t.key, url: t.url, mimeType: "image/png", meta: { fromSheet: sheet.id } } });
    }
    await db.character.update({ where: { id: c.id }, data: { sheetAssetId: sheet.id } });
    await registerLibrary(job, ctx, "character", c.id, !!res.meta?.preview);
    publish(job.projectId, { type: "refresh", scope: "characters" });
    return { assetId: sheet.id, angles: tiles.length };
  }

  const el = await db.element.findUniqueOrThrow({ where: { id: input.elementId }, include: { references: true } });
  const own = el.references.filter((a) => a.kind === "IMAGE" && !(a.meta as Record<string, unknown>)?.fromSheet).slice(0, 4).map((a) => toRef(a, el.name));
  const isSet = el.kind === "location";
  const views = ["establishing wide", "reverse angle", "detail of the space", "alternate angle"];
  const req: ImageRequest = isSet
    ? {
        prompt: `Location reference plates for the film set "${el.name}": ${el.description}. A 2×2 grid of four views of the same place — ${views.join(", ")} — identical architecture, props and lighting, no people, no text, thin black gutters. ${look}`,
        aspectRatio: project.aspectRatio === "9:16" ? "9:16" : "16:9",
        model: sheetModel,
        references: own,
        label: `${el.name} · set`,
        grid: { cols: 2, rows: 2, labels: views.map((v) => `${el.name} — ${v}`) },
      }
    : {
        prompt: `Product reference of the prop "${el.name}": ${el.description}. Centred on a plain neutral background, even studio light, no text. ${look}`,
        aspectRatio: "1:1",
        model: sheetModel,
        references: own,
        label: `${el.name} · prop`,
      };
  const res = await generate("image", ctx, (p) => p.image?.(req, ctx), job.provider);
  const stored = await persist(job.projectId, "elements", res);
  await db.asset.deleteMany({ where: { elementId: el.id, meta: { path: ["fromSheet"], equals: true } } });
  if (isSet) {
    const sheet = await db.asset.create({ data: { projectId: job.projectId, elementId: el.id, kind: "IMAGE", role: "CONTACT_SHEET", name: `${el.name} plates`, storageKey: stored.key, url: stored.url, mimeType: stored.mime, meta: { fromSheet: true, preview: !!res.meta?.preview } } });
    const tiles = await splitGrid(stored.key, 2, 2);
    for (const [i, buf] of tiles.entries()) {
      const t = await putFile(newKey(job.projectId, "elements", "image/png"), buf, "image/png");
      await db.asset.create({ data: { projectId: job.projectId, elementId: el.id, kind: "IMAGE", role: "ELEMENT_REF", name: views[i], storageKey: t.key, url: t.url, mimeType: "image/png", meta: { fromSheet: sheet.id } } });
    }
  } else {
    await db.asset.create({ data: { projectId: job.projectId, elementId: el.id, kind: "IMAGE", role: "ELEMENT_REF", name: el.name, storageKey: stored.key, url: stored.url, mimeType: stored.mime, providerRef: res.providerRef, meta: { fromSheet: true, preview: !!res.meta?.preview } } });
  }
  await registerLibrary(job, ctx, isSet ? "locations" : "product", el.id, !!res.meta?.preview);
  publish(job.projectId, { type: "refresh", scope: "characters" });
  return { ok: true };
}

/**
 * Registers a character / set / prop as a Magnific library asset so video and image calls can pass it by id
 * (custom_model_id) and prompts can @mention it. Best effort: generation still works without it.
 */
async function registerLibrary(job: Job, ctx: GenContext, type: "character" | "product" | "locations", id: string, preview: boolean) {
  if (preview) return;
  const mag = (await providersFor("image")).find((p) => "createLibrary" in p && !p.unavailable?.()) as MagnificProvider | undefined;
  if (!mag) return;
  try {
    if (type === "character") {
      const c = await db.character.findUniqueOrThrow({ where: { id }, include: { references: true } });
      const refs = characterRefList(c).slice(0, 6);
      if (!refs.length) return;
      const libId = await mag.createLibrary({ type, name: c.handle || c.name, description: c.description, images: refs }, ctx);
      await db.character.update({ where: { id }, data: { providerRef: libId } });
    } else {
      const e = await db.element.findUniqueOrThrow({ where: { id }, include: { references: true } });
      const refs = e.references.filter((a) => a.kind === "IMAGE" && a.role === "ELEMENT_REF").slice(0, 6).map((a) => toRef(a, e.name));
      if (!refs.length) return;
      const libId = await mag.createLibrary({ type, name: e.handle || e.name, description: e.description, images: refs }, ctx);
      await db.element.update({ where: { id }, data: { providerRef: libId } });
    }
  } catch (err) {
    console.warn("[library] register failed:", (err as Error).message);
  }
}

/** Draws up to 9 shots of a scene as one contact sheet, then cuts it into a frame per shot. */
async function contactSheet(job: Job, input: Record<string, any>, ctx: GenContext) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const shotIds: string[] = input.shotIds;
  const { cols, rows } = gridFor(shotIds.length);
  const { req, plan } = await buildContactSheetRequest(shotIds, cols, rows, { model: input.model });
  await ctx.onProgress(3, `Contact sheet ${cols}×${rows} · ${plan.refs.length} references`);
  const res = await generate("image", ctx, (p) => p.image?.(req, ctx), job.provider);
  await ctx.onProgress(85, "Cutting the sheet into frames");
  const stored = await persist(job.projectId, "sheets", res);
  const first = await db.shot.findUniqueOrThrow({ where: { id: shotIds[0] } });
  const sheet = await db.asset.create({
    data: {
      projectId: job.projectId, kind: "IMAGE", role: "CONTACT_SHEET", name: req.label, storageKey: stored.key, url: stored.url, mimeType: stored.mime, providerRef: res.providerRef,
      meta: { sceneId: first.sceneId, shotIds, cols, rows, model: req.model, provider: res.providerName, refs: plan.refs.length, preview: !!res.meta?.preview } as Prisma.InputJsonValue,
    },
  });
  const tiles = await splitGrid(stored.key, cols, rows);
  for (const [i, shotId] of shotIds.entries()) {
    if (!tiles[i]) break;
    const t = await putFile(newKey(job.projectId, "frames", "image/png"), tiles[i], "image/png");
    const asset = await db.asset.create({
      data: {
        projectId: job.projectId, shotId, kind: "IMAGE", role: "SHOT_IMAGE", storageKey: t.key, url: t.url, mimeType: "image/png",
        meta: { fromContactSheet: sheet.id, model: req.model, provider: res.providerName, preview: !!res.meta?.preview } as Prisma.InputJsonValue,
      },
    });
    await db.shot.update({ where: { id: shotId }, data: { imageAssetId: asset.id, imageStatus: "DONE", approved: false } });
    publish(job.projectId, { type: "shot", shotId, patch: { imageAssetId: asset.id, imageUrl: asset.url, imageStatus: "DONE", approved: false } });
  }
  publish(job.projectId, { type: "refresh", scope: "shots" });
  return { assetId: sheet.id, frames: Math.min(tiles.length, shotIds.length) };
}

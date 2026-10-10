import type { Job, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { publish } from "@/lib/events";
import { requeue } from "@/lib/queue";
import { generate } from "@/lib/generation/router";
import type { GenContext, GenResult } from "@/lib/generation/types";
import { buildImageRequest, buildVideoRequest } from "@/lib/prompt-builder";
import { localPath, newKey, putFile, storeFromUrl } from "@/lib/storage";
import { probeDuration } from "@/lib/ffmpeg";
import { relayoutVideoTrack, shotStartTime, upsertShotVideoClip } from "@/lib/timeline";
import { parseScript } from "@/lib/script/parse";
import { applyParsedScript } from "@/lib/services";
import { exportMp4 } from "@/lib/export/mp4";
import { exportStoryboardPdf } from "@/lib/export/pdf";
import { consistencyCheck, moodCheck, monitorSweep } from "@/lib/agents/checks";
import { getSettings } from "@/lib/settings";
import { McpToolError } from "@/lib/mcp/client";
import { errorMessage } from "@/lib/utils";

/**
 * Executes one Job row. Progress is written to the DB (throttled) and streamed over the event bus.
 */
export async function processJob(jobId: string) {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job || job.status === "CANCELED" || job.status === "SUCCEEDED") return;

  await db.job.update({ where: { id: jobId }, data: { status: "RUNNING", attempts: { increment: 1 }, step: "Starting", progress: 1, error: null } });
  emit(job, { status: "RUNNING", progress: 1, step: "Starting" });
  setShotStatus(job, "GENERATING");

  let lastWrite = 0;
  const ctx: GenContext = {
    projectId: job.projectId,
    onProgress: async (pct, step) => {
      emit(job, { status: "RUNNING", progress: pct, step });
      if (Date.now() - lastWrite > 1500) {
        lastWrite = Date.now();
        const cur = await db.job.update({ where: { id: jobId }, data: { progress: pct, step } });
        if (cur.status === "CANCELED") throw new Error("Canceled");
      }
    },
    onRefUploaded: async (assetId, providerRef) => {
      await db.asset.update({ where: { id: assetId }, data: { providerRef } }).catch(() => {});
    },
  };

  try {
    const output = await run(job, ctx);
    const fresh = await db.job.findUnique({ where: { id: jobId } });
    if (fresh?.status === "CANCELED") return;
    await db.job.update({ where: { id: jobId }, data: { status: "SUCCEEDED", progress: 100, step: "Done", output: (output ?? {}) as Prisma.InputJsonValue } });
    emit(job, { status: "SUCCEEDED", progress: 100, step: "Done" });
  } catch (e) {
    const msg = errorMessage(e);
    const fresh = await db.job.findUnique({ where: { id: jobId } });
    if (!fresh || fresh.status === "CANCELED") return;
    const retryable = !(e instanceof McpToolError) || e.retryable;
    if (retryable && fresh.attempts < fresh.maxAttempts && msg !== "Canceled") {
      const delay = 5000 * 2 ** (fresh.attempts - 1);
      console.warn(`[job ${jobId}] attempt ${fresh.attempts} failed, retrying in ${delay}ms: ${msg}`);
      await db.job.update({ where: { id: jobId }, data: { error: msg } });
      await requeue(jobId, delay);
      setShotStatus(job, "QUEUED");
      return;
    }
    console.error(`[job ${jobId}] failed:`, msg);
    await db.job.update({ where: { id: jobId }, data: { status: "FAILED", error: msg, step: "Failed" } });
    emit(job, { status: "FAILED", progress: fresh.progress, step: "Failed", error: msg });
    setShotStatus(job, "FAILED");
    monitorSweep(job.projectId).catch(() => {});
  }
}

function emit(job: Job, p: { status: string; progress: number; step: string; error?: string }) {
  publish(job.projectId, { type: "job", job: { id: job.id, shotId: job.shotId, type: job.type, error: p.error ?? null, ...p } });
}

function setShotStatus(job: Job, status: "QUEUED" | "GENERATING" | "DONE" | "FAILED") {
  if (!job.shotId) return;
  const field = job.type === "IMAGE" || job.type === "UPSCALE" || job.type === "INPAINT" ? "imageStatus" : job.type === "VIDEO" ? "videoStatus" : job.type === "TTS" ? "audioStatus" : null;
  if (!field) return;
  db.shot
    .update({ where: { id: job.shotId }, data: { [field]: status } })
    .then(() => publish(job.projectId, { type: "shot", shotId: job.shotId!, patch: { [field]: status } }))
    .catch(() => {});
}

async function persist(projectId: string, folder: string, res: GenResult) {
  if (res.buffer) {
    const key = newKey(projectId, folder, res.mime);
    const stored = await putFile(key, res.buffer, res.mime);
    return { ...stored, mime: res.mime };
  }
  if (!res.url) throw new Error("Generation returned no media");
  return storeFromUrl(projectId, folder, res.url, res.mime);
}

async function durationOf(key: string, fallback?: number) {
  return (await probeDuration(await localPath(key))) ?? fallback ?? 4;
}

async function autoAgents(fn: () => Promise<void>) {
  const s = await getSettings();
  if (s.autoAgents) fn().catch((e) => console.warn("[agents]", e.message));
}

async function run(job: Job, ctx: GenContext): Promise<unknown> {
  const input = (job.input ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (job.type) {
    case "PARSE_SCRIPT": {
      await ctx.onProgress(5, "Reading script");
      const parsed = await parseScript(input.text, ctx.onProgress);
      await ctx.onProgress(92, `Creating ${parsed.scenes.length} scenes`);
      await applyParsedScript(job.projectId, parsed, input.replace !== false);
      return { scenes: parsed.scenes.length, shots: parsed.scenes.reduce((n, s) => n + s.shots.length, 0), characters: parsed.characters.length, method: parsed.method };
    }

    case "IMAGE": {
      const { req, characters } = await buildImageRequest(job.shotId!);
      await ctx.onProgress(3, `Locking ${characters.length} character(s) · ${req.references.length} ref image(s)`);
      const res = await generate("image", ctx, (p) => p.image?.(req, ctx), job.provider);
      await ctx.onProgress(96, "Saving frame");
      const stored = await persist(job.projectId, "frames", res);
      const asset = await db.asset.create({
        data: {
          projectId: job.projectId, shotId: job.shotId, kind: "IMAGE", role: "SHOT_IMAGE", storageKey: stored.key, url: stored.url, mimeType: stored.mime,
          providerRef: res.providerRef,
          meta: { prompt: req.prompt, model: req.model ?? "auto", provider: res.providerName, characters: characters.map((c) => c.name), refs: req.references.length, preview: !!res.meta?.preview, fallbackFrom: res.fallbackFrom ?? null } as Prisma.InputJsonValue,
        },
      });
      await db.shot.update({ where: { id: job.shotId! }, data: { imageAssetId: asset.id, imageStatus: "DONE", approved: false } });
      publish(job.projectId, { type: "shot", shotId: job.shotId!, patch: { imageAssetId: asset.id, imageUrl: asset.url, imageStatus: "DONE", approved: false } });
      autoAgents(async () => {
        await consistencyCheck(job.shotId!);
        await moodCheck(job.shotId!);
      });
      return { assetId: asset.id, url: asset.url, provider: res.providerName };
    }

    case "VIDEO": {
      const shot = await db.shot.findUniqueOrThrow({ where: { id: job.shotId! } });
      const mode = input.mode === "t2v" || !shot.imageAssetId ? "t2v" : "i2v";
      const req = await buildVideoRequest(job.shotId!, mode);
      await ctx.onProgress(3, mode === "i2v" ? "Animating approved frame" : "Text-to-video with character refs");
      const res = await generate("video", ctx, (p) => p.video?.(req, ctx), job.provider);
      await ctx.onProgress(96, "Saving clip");
      const stored = await persist(job.projectId, "clips", res);
      const dur = await durationOf(stored.key, res.durationSec ?? req.durationSec);
      const asset = await db.asset.create({
        data: {
          projectId: job.projectId, shotId: job.shotId, kind: "VIDEO", role: "SHOT_VIDEO", storageKey: stored.key, url: stored.url, mimeType: stored.mime, durationSec: dur,
          providerRef: res.providerRef, meta: { prompt: req.prompt, model: req.model ?? "auto", provider: res.providerName, mode, preview: !!res.meta?.preview } as Prisma.InputJsonValue,
        },
      });
      await db.shot.update({ where: { id: job.shotId! }, data: { videoAssetId: asset.id, videoStatus: "DONE" } });
      await upsertShotVideoClip(job.projectId, job.shotId!, asset.id, dur);
      publish(job.projectId, { type: "shot", shotId: job.shotId!, patch: { videoAssetId: asset.id, videoUrl: asset.url, videoStatus: "DONE" } });
      publish(job.projectId, { type: "refresh", scope: "timeline" });
      return { assetId: asset.id, url: asset.url, durationSec: dur, provider: res.providerName };
    }

    case "TTS": {
      const res = await generate("tts", ctx, (p) => p.tts?.({ text: input.text, voiceId: input.voiceId }, ctx));
      const stored = await persist(job.projectId, "voice", res);
      const dur = await durationOf(stored.key, res.durationSec);
      const asset = await db.asset.create({
        data: { projectId: job.projectId, shotId: job.shotId, kind: "AUDIO", role: "VOICEOVER", name: String(input.text).slice(0, 60), storageKey: stored.key, url: stored.url, mimeType: stored.mime, durationSec: dur, meta: { provider: res.providerName, text: input.text } },
      });
      if (job.shotId) {
        await db.timelineClip.deleteMany({ where: { projectId: job.projectId, shotId: job.shotId, track: "VOICE" } });
        const start = await shotStartTime(job.projectId, job.shotId);
        await db.timelineClip.create({ data: { projectId: job.projectId, shotId: job.shotId, assetId: asset.id, track: "VOICE", start: start + 0.2, inPoint: 0, outPoint: dur, label: asset.name } });
        await db.shot.update({ where: { id: job.shotId }, data: { audioStatus: "DONE" } });
        publish(job.projectId, { type: "shot", shotId: job.shotId, patch: { audioStatus: "DONE" } });
        // Make sure the shot is long enough for its line.
        const shot = await db.shot.findUnique({ where: { id: job.shotId } });
        if (shot && dur + 0.4 > shot.durationSec) await db.shot.update({ where: { id: shot.id }, data: { durationSec: Math.ceil(dur + 0.5) } });
      }
      publish(job.projectId, { type: "refresh", scope: "timeline" });
      return { assetId: asset.id, durationSec: dur };
    }

    case "MUSIC":
    case "SFX": {
      const cap = job.type === "MUSIC" ? "music" : "sfx";
      const req = { prompt: input.prompt, durationSec: Number(input.durationSec) || (cap === "music" ? 30 : 3) };
      const res = await generate(cap, ctx, (p) => (cap === "music" ? p.music?.(req, ctx) : p.sfx?.(req, ctx)));
      const stored = await persist(job.projectId, cap, res);
      const dur = await durationOf(stored.key, req.durationSec);
      const asset = await db.asset.create({
        data: { projectId: job.projectId, kind: "AUDIO", role: job.type === "MUSIC" ? "MUSIC" : "SFX", name: String(input.prompt).slice(0, 60), storageKey: stored.key, url: stored.url, mimeType: stored.mime, durationSec: dur, meta: { provider: res.providerName, prompt: input.prompt } },
      });
      await db.timelineClip.create({ data: { projectId: job.projectId, assetId: asset.id, track: job.type === "MUSIC" ? "MUSIC" : "SFX", start: Number(input.start) || 0, inPoint: 0, outPoint: dur, label: asset.name, volume: job.type === "MUSIC" ? 0.6 : 1 } });
      publish(job.projectId, { type: "refresh", scope: "timeline" });
      return { assetId: asset.id, durationSec: dur };
    }

    case "UPSCALE":
    case "INPAINT": {
      const src = await db.asset.findUniqueOrThrow({ where: { id: input.assetId } });
      const image = { assetId: src.id, key: src.storageKey, url: src.url, mime: src.mimeType, providerRef: src.providerRef, type: "image" as const };
      let res: GenResult & { providerName: string };
      if (job.type === "UPSCALE") {
        res = await generate("upscale", ctx, (p) => p.upscale?.({ image, scale: input.scale ?? "2x" }, ctx));
      } else {
        const mask = await db.asset.findUniqueOrThrow({ where: { id: input.maskAssetId } });
        res = await generate("inpaint", ctx, (p) =>
          p.inpaint?.({ image, mask: { assetId: mask.id, key: mask.storageKey, url: mask.url, mime: mask.mimeType, providerRef: mask.providerRef, type: "image" }, prompt: input.prompt }, ctx),
        );
      }
      const stored = await persist(job.projectId, "frames", res);
      const asset = await db.asset.create({
        data: { projectId: job.projectId, shotId: src.shotId, kind: "IMAGE", role: "SHOT_IMAGE", storageKey: stored.key, url: stored.url, mimeType: stored.mime, providerRef: res.providerRef, meta: { ...(src.meta as object), editedFrom: src.id, edit: job.type.toLowerCase(), provider: res.providerName } as Prisma.InputJsonValue },
      });
      if (src.shotId) {
        await db.shot.update({ where: { id: src.shotId }, data: { imageAssetId: asset.id, imageStatus: "DONE" } });
        publish(job.projectId, { type: "shot", shotId: src.shotId, patch: { imageAssetId: asset.id, imageUrl: asset.url, imageStatus: "DONE" } });
      }
      return { assetId: asset.id, url: asset.url };
    }

    case "EXPORT_MP4": {
      await relayoutVideoTrack(job.projectId);
      const out = await exportMp4(job.projectId, ctx.onProgress);
      await db.project.update({ where: { id: job.projectId }, data: { stage: "EXPORT" } });
      publish(job.projectId, { type: "refresh", scope: "assets" });
      return out;
    }

    case "EXPORT_PDF": {
      const out = await exportStoryboardPdf(job.projectId, ctx.onProgress);
      publish(job.projectId, { type: "refresh", scope: "assets" });
      return out;
    }

    case "AGENT_CHECK": {
      if (input.agent === "MONITOR") await monitorSweep(job.projectId);
      else if (job.shotId) {
        if (input.agent !== "MOOD") await consistencyCheck(job.shotId);
        if (input.agent !== "CONSISTENCY") await moodCheck(job.shotId);
      }
      return { ok: true };
    }
  }
}

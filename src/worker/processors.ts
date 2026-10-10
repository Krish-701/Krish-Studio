import type { Job, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { publish } from "@/lib/events";
import { requeue } from "@/lib/queue";
import { generate } from "@/lib/generation/router";
import type { GenContext, GenResult } from "@/lib/generation/types";
import { buildImageRequest, buildVideoRequest } from "@/lib/prompt-builder";
import { durationOf, persist } from "./store";
import { runLongform } from "./longform";
import { autoSequences, linkLocations, renumber } from "@/lib/script/writer";
import { relayoutVideoTrack, shotStartTime, upsertShotVideoClip } from "@/lib/timeline";
import { parseScript } from "@/lib/script/parse";
import { applyParsedScript } from "@/lib/services";
import { exportMp4 } from "@/lib/export/mp4";
import { exportStoryboardPdf } from "@/lib/export/pdf";
import { exportPackage } from "@/lib/export/package";
import { consistencyCheck, moodCheck, monitorSweep } from "@/lib/agents/checks";
import { getSettings } from "@/lib/settings";
import { McpToolError } from "@/lib/mcp/client";
import { errorMessage } from "@/lib/utils";
import { jobWords, logActivity, shortError } from "@/lib/activity";
import { maybeSummarize } from "@/lib/agents/summary";
import { runAutopilot } from "./autopilot";
import { improveStory, scoreStory } from "@/lib/script/score";

const deferredJobs = new Set<string>();

/**
 * Executes one Job row. Progress is written to the DB (throttled) and streamed over the event bus.
 */
export async function processJob(jobId: string) {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job || job.status === "CANCELED" || job.status === "SUCCEEDED") return;

  await db.job.update({ where: { id: jobId }, data: { status: "RUNNING", attempts: { increment: 1 }, step: "Starting", progress: 1, error: null } });
  emit(job, { status: "RUNNING", progress: 1, step: "Starting" });
  setShotStatus(job, "GENERATING");
  const what = await jobSubject(job);
  const log = (level: "info" | "warn" | "error" | "success", message: string, data?: unknown) =>
    logActivity(job.projectId, { kind: "job", level, actor: "worker", message, data, jobId: job.id, shotId: job.shotId });
  // A deferred job comes back every few seconds; log its start and wait only once.
  const wasDeferred = deferredJobs.has(jobId);
  if (!wasDeferred) await log("info", `${what} started${job.attempts > 0 ? ` (attempt ${job.attempts + 1})` : ""}`);

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
    const output = await run(job, ctx).finally(() => deferredJobs.delete(jobId));
    const fresh = await db.job.findUnique({ where: { id: jobId } });
    if (fresh?.status === "CANCELED") return;
    const deferred = (output as { __deferred?: number; step?: string } | undefined)?.__deferred;
    if (deferred) {
      // Not a failure: put it back in the queue without spending an attempt.
      await db.job.update({ where: { id: jobId }, data: { status: "QUEUED", attempts: { decrement: 1 }, step: (output as { step?: string }).step ?? "Waiting", progress: 0 } });
      emit(job, { status: "QUEUED", progress: 0, step: (output as { step?: string }).step ?? "Waiting" });
      setShotStatus(job, "QUEUED");
      await requeue(jobId, deferred);
      if (!wasDeferred) await log("info", `${what} deferred: ${(output as { step?: string }).step ?? "waiting"}`);
      deferredJobs.add(jobId);
      return;
    }
    await db.job.update({ where: { id: jobId }, data: { status: "SUCCEEDED", progress: 100, step: "Done", output: (output ?? {}) as Prisma.InputJsonValue } });
    emit(job, { status: "SUCCEEDED", progress: 100, step: "Done" });
    await log("success", await successText(job, what, output), output ?? undefined);
    maybeSummarize(job.projectId).catch(() => {});
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
      await log("warn", `${what} failed (attempt ${fresh.attempts}/${fresh.maxAttempts}), retrying in ${Math.round(delay / 1000)}s: ${shortError(msg, 200)}`, { error: msg });
      return;
    }
    console.error(`[job ${jobId}] failed:`, msg);
    await db.job.update({ where: { id: jobId }, data: { status: "FAILED", error: msg, step: "Failed" } });
    emit(job, { status: "FAILED", progress: fresh.progress, step: "Failed", error: msg });
    setShotStatus(job, "FAILED");
    await log("error", `${what} failed: ${shortError(msg)}`, { error: msg, attempts: fresh.attempts });
    monitorSweep(job.projectId).catch(() => {});
    maybeSummarize(job.projectId).catch(() => {});
  }
}

/** "Frame for shot #4", "Sequence writing (seq 3)", "Film export"… */
async function jobSubject(job: Job) {
  const base = jobWords(job.type);
  try {
    if (job.shotId) {
      const shot = await db.shot.findUnique({ where: { id: job.shotId }, select: { order: true } });
      if (shot) return `${base} for shot #${shot.order + 1}`;
    }
    const input = (job.input ?? {}) as { sequenceId?: string; shotIds?: string[]; agent?: string };
    if (job.type === "WRITE_SEQUENCE" && input.sequenceId) {
      const seq = await db.sequence.findUnique({ where: { id: input.sequenceId }, select: { index: true, title: true } });
      if (seq) return `Writing sequence ${seq.index + 1} “${seq.title}”`;
    }
    if (input.shotIds?.length) return `${base} (${input.shotIds.length} shots)`;
    if (job.type === "AGENT_CHECK" && input.agent) return `${base} (${input.agent.toLowerCase()})`;
  } catch {}
  return base;
}

/** Human summary of a finished job. */
async function successText(job: Job, what: string, output: unknown) {
  const o = (output ?? {}) as Record<string, unknown>;
  const shotNo = what.match(/shot #\d+/)?.[0];
  try {
    switch (job.type) {
      case "IMAGE":
      case "UPSCALE":
      case "INPAINT":
        return shotNo ? `Frame ready for ${shotNo}` : `${what} done`;
      case "VIDEO":
        return `Clip ready for ${shotNo ?? "shot"}${o.durationSec ? ` (${Number(o.durationSec).toFixed(1)}s)` : ""}`;
      case "TTS":
        return `Voiceover ready${shotNo ? ` for ${shotNo}` : ""}${o.durationSec ? ` (${Number(o.durationSec).toFixed(1)}s)` : ""}`;
      case "PARSE_SCRIPT":
        return `Script broken down: ${o.scenes} scenes, ${o.shots} shots, ${o.characters} characters`;
      case "WRITE_OUTLINE":
        return `Outline written: ${o.acts} acts, ${o.sequences} sequences`;
      case "WRITE_SEQUENCE": {
        const seqId = (job.input as { sequenceId?: string })?.sequenceId;
        const seq = seqId ? await db.sequence.findUnique({ where: { id: seqId }, select: { index: true } }) : null;
        const shots = seqId ? await db.shot.count({ where: { scene: { sequenceId: seqId } } }) : 0;
        return `Wrote sequence ${seq ? seq.index + 1 : "?"}: ${o.scenes ?? "?"} scenes, ${shots} shots`;
      }
      case "CONTACT_SHEET":
        return `Contact sheet split into ${o.frames ?? "?"} frames`;
      case "MULTISHOT_VIDEO":
        return `Multi-shot clip ready (${o.shots ?? "?"} shots${o.durationSec ? `, ${Number(o.durationSec).toFixed(1)}s` : ""})`;
      case "DESIGN_SHEET":
        return `Design sheet ready${o.angles ? ` (${o.angles} angles)` : ""}`;
      case "EXPORT_MP4":
        return "Film exported to MP4";
      case "EXPORT_PDF":
        return "Storyboard PDF exported";
      case "EXPORT_PACKAGE":
        return "Project package exported";
      case "STORY_SCORE":
        return `Story scored ${Number(o.score).toFixed(1)}/10${o.rounds ? ` after ${o.rounds} rewrite(s)` : ""}`;
      case "AUTOPILOT":
        return o.done ? "Autopilot finished" : o.needsInput ? `Autopilot waiting for you (story ${Number(o.score).toFixed(1)}/10)` : "Autopilot stopped";
    }
  } catch {}
  return `${what} done`;
}

function emit(job: Job, p: { status: string; progress: number; step: string; error?: string }) {
  publish(job.projectId, { type: "job", job: { id: job.id, shotId: job.shotId, type: job.type, error: p.error ?? null, ...p } });
}

function setShotStatus(job: Job, status: "QUEUED" | "GENERATING" | "DONE" | "FAILED") {
  // Multi-shot and contact-sheet jobs cover several shots.
  const many = (job.input as { shotIds?: string[] })?.shotIds;
  if (!job.shotId && many?.length && (job.type === "MULTISHOT_VIDEO" || job.type === "CONTACT_SHEET")) {
    const field = job.type === "CONTACT_SHEET" ? "imageStatus" : "videoStatus";
    if (status === "DONE") return;
    db.shot
      .updateMany({ where: { id: { in: many } }, data: { [field]: status } })
      .then(() => many.forEach((id) => publish(job.projectId, { type: "shot", shotId: id, patch: { [field]: status } })))
      .catch(() => {});
    return;
  }
  if (!job.shotId) return;
  const field = job.type === "IMAGE" || job.type === "UPSCALE" || job.type === "INPAINT" ? "imageStatus" : job.type === "VIDEO" || job.type === "EXTEND_VIDEO" || job.type === "LIPSYNC" ? "videoStatus" : job.type === "TTS" ? "audioStatus" : null;
  if (!field) return;
  db.shot
    .update({ where: { id: job.shotId }, data: { [field]: status } })
    .then(() => publish(job.projectId, { type: "shot", shotId: job.shotId!, patch: { [field]: status } }))
    .catch(() => {});
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
      // Long scripts get sequences and film sets like a written film.
      await linkLocations(job.projectId);
      await autoSequences(job.projectId);
      await renumber(job.projectId);
      return { scenes: parsed.scenes.length, shots: parsed.scenes.reduce((n, s) => n + s.shots.length, 0), characters: parsed.characters.length, method: parsed.method };
    }

    case "IMAGE": {
      const { req, characters } = await buildImageRequest(job.shotId!, { model: input.model });
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
      // A continuous shot starts from the previous clip's last frame, so it waits for that clip.
      if (shot.continuity === "continuous") {
        const prev = await db.shot.findFirst({ where: { projectId: job.projectId, order: { lt: shot.order } }, orderBy: { order: "desc" } });
        const pending = prev && !prev.videoAssetId && (await db.job.count({ where: { shotId: prev.id, type: { in: ["VIDEO", "MULTISHOT_VIDEO", "EXTEND_VIDEO"] }, status: { in: ["QUEUED", "RUNNING"] } } }));
        if (pending) return { __deferred: 15_000, step: `Waiting for shot #${prev!.order + 1}` };
      }
      const req = await buildVideoRequest(job.shotId!, input.mode, { model: input.model });
      const mode = req.plan.mode;
      await ctx.onProgress(3, mode === "frame" ? `Animating from ${req.plan.start?.label ?? "frame"}` : mode === "reference" ? `Reference mode · ${req.references?.length ?? 0} refs` : "Text to video");
      const res = await generate("video", ctx, (p) => p.video?.(req, ctx), job.provider);
      await ctx.onProgress(96, "Saving clip");
      const stored = await persist(job.projectId, "clips", res);
      const dur = await durationOf(stored.key, res.durationSec ?? req.durationSec);
      const asset = await db.asset.create({
        data: {
          projectId: job.projectId, shotId: job.shotId, kind: "VIDEO", role: "SHOT_VIDEO", storageKey: stored.key, url: stored.url, mimeType: stored.mime, durationSec: dur,
          providerRef: res.providerRef, meta: { prompt: req.prompt, model: req.model ?? "auto", provider: res.providerName, mode, refs: req.references?.length ?? 0, dropped: req.plan.dropped.length, preview: !!res.meta?.preview } as Prisma.InputJsonValue,
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

    case "EXPORT_PACKAGE": {
      const out = await exportPackage(job.projectId, ctx.onProgress, { includeMedia: (input as { includeMedia?: boolean }).includeMedia });
      publish(job.projectId, { type: "refresh", scope: "assets" });
      return out;
    }

    case "WRITE_OUTLINE":
    case "WRITE_SEQUENCE":
    case "DESIGN_SHEET":
    case "CONTACT_SHEET":
    case "MULTISHOT_VIDEO":
    case "EXTEND_VIDEO":
    case "LIPSYNC":
      return runLongform(job, ctx);

    case "AUTOPILOT":
      return runAutopilot(job, ctx);

    case "STORY_SCORE": {
      const i = input as { improve?: boolean; target?: number };
      return i.improve ? improveStory(job.projectId, { target: i.target, onProgress: ctx.onProgress }) : scoreStory(job.projectId);
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

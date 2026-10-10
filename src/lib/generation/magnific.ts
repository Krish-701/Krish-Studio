import type { McpServerConfig } from "../settings";
import { callTool, collect, field, fields, findUrls, McpToolError } from "../mcp/client";
import { getFile } from "../storage";
import { sleep } from "../utils";
import { snap, snapAspect, videoModel } from "./catalog";
import type { GenContext, GenerationProvider, GenResult, RefImage } from "./types";

/**
 * Native adapter for Magnific MCP (https://mcp.magnific.com).
 * Flow for every generation: upload refs once (cached as providerRef) → *_generate → creations_wait → download.
 */

const IMAGE_ASPECTS = ["1:1", "21:9", "16:9", "9:16", "2:3", "3:4", "1:2", "2:1", "5:4", "4:5", "3:2", "4:3"];
const ID_KEYS = ["identifier", "identifiers", "creationIdentifier", "creationIdentifiers", "creation_identifier"];

function identifiersOf(result: unknown): string[] {
  const vals = collect(result, ID_KEYS).flat(2).filter((v): v is string => typeof v === "string" && v.length > 3);
  if (vals.length) return [...new Set(vals)];
  // TOON text responses ("identifier: abc123" / "identifiers[1]: abc123")
  const text = typeof (result as { text?: unknown })?.text === "string" ? (result as { text: string }).text : JSON.stringify(result);
  const out = [...text.matchAll(/(?:creationI|i)dentifiers?(?:\[\d+\])?:\s*"?([A-Za-z0-9_,\- "]{6,})/g)].flatMap((x) => x[1].split(",").map((v) => v.replace(/"/g, "").trim()));
  return [...new Set(out.filter((v) => v.length >= 6))];
}

function statusesOf(result: unknown): string[] {
  return fields(result, "status").map((x) => x.toLowerCase());
}

const FAILED = /fail|error|cancel|reject|moderat/;
const DONE = /complete|done|success|succeed|finish|ready/;

function mediaUrl(result: unknown, kind: "image" | "video" | "audio") {
  // Prefer the creation's top-level full-res `url` over previews, thumbnails and originals.
  const direct = fields(result, "url").filter((u) => /^https?:\/\//.test(u) && !/thumb|preview-grid|start_frame|end_frame|original\./i.test(u));
  return direct[0] || findUrls(result, kind).find((u) => !/original\./.test(u)) || null;
}

export function magnificProvider(cfg: McpServerConfig): GenerationProvider {
  let cachedVoice: number | null = null;

  async function ensureRef(ref: RefImage, ctx: GenContext): Promise<string> {
    if (ref.providerRef) return ref.providerRef;
    let id: string | undefined;
    // 1) Direct upload of our stored bytes (works even when the app isn't publicly reachable).
    if (ref.key) {
      try {
        const mime = ref.mime && /^(image|video|audio)\//.test(ref.mime) ? ref.mime : "image/png";
        const req = await callTool(cfg, "creations_request_upload", { mimeType: mime });
        const putUrl = field(req, ["uploadUrl", "putUrl", "presignedUrl", "signedUrl", "url"]) || findUrls(req)[0];
        const pathVal = field(req, ["path", "tempPath", "key"]);
        if (!putUrl || !pathVal) throw new Error("upload slot missing url/path");
        const body = await getFile(ref.key);
        const put = await fetch(putUrl, { method: "PUT", body: new Uint8Array(body), headers: { "Content-Type": mime } });
        if (!put.ok) throw new Error(`PUT ${put.status}`);
        const fin = await callTool(cfg, "creations_finalize_upload", { path: pathVal, fileName: ref.label ? `${ref.label}.png` : undefined, visible: false });
        id = identifiersOf(fin)[0];
      } catch (e) {
        console.warn("[magnific] direct upload failed, trying URL import:", (e as Error).message);
      }
    }
    // 2) URL import for publicly reachable images.
    if (!id && /^https:\/\//.test(ref.url) && !/localhost|127\.0\.0\.1/.test(ref.url)) {
      const res = await callTool(cfg, "creations_upload_image", { url: ref.url });
      id = identifiersOf(res)[0];
    }
    if (!id) throw new McpToolError(`Could not upload reference "${ref.label ?? ref.url}" to Magnific`, "upload", false);
    if (ref.assetId) await ctx.onRefUploaded?.(ref.assetId, id);
    ref.providerRef = id;
    return id;
  }

  async function waitFor(ids: string[], kind: "image" | "video" | "audio", ctx: GenContext, expectedSec: number, label: string): Promise<GenResult> {
    if (!ids.length) throw new McpToolError("Magnific did not return a creation identifier", "generate");
    const started = Date.now();
    const deadline = started + Math.max(expectedSec * 4, 300) * 1000;
    while (Date.now() < deadline) {
      if (ctx.signal?.aborted) throw new Error("Canceled");
      const res = await callTool(cfg, "creations_wait", { identifiers: ids.slice(0, 1), timeoutSeconds: 25 }, 60_000);
      const st = statusesOf(res);
      if (st.some((s) => FAILED.test(s))) {
        const msg = field(res, ["error", "message", "reason", "failureReason"]);
        throw new McpToolError(`Magnific ${label} failed${msg ? `: ${msg}` : ""}`, "creations_wait");
      }
      let url = mediaUrl(res, kind);
      const done = st.length ? st.every((s) => DONE.test(s)) : !!url;
      if (done) {
        if (!url) {
          const got = await callTool(cfg, "creations_get", { creationIdentifier: ids[0] });
          url = mediaUrl(got, kind);
        }
        if (!url) throw new McpToolError("Magnific finished but returned no media URL", "creations_get");
        return { url, mime: kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "audio/mpeg", providerRef: ids[0] };
      }
      const elapsed = (Date.now() - started) / 1000;
      // Asymptotic progress toward 95% based on the model's expected generation time.
      const pct = Math.min(95, Math.round(20 + 75 * (1 - Math.exp(-elapsed / Math.max(expectedSec, 10)))));
      await ctx.onProgress(pct, `${label} · ${st[0] ?? "processing"} (${Math.round(elapsed)}s)`);
      await sleep(1000);
    }
    throw new McpToolError(`Magnific ${label} timed out`, "creations_wait");
  }

  return {
    id: cfg.id,
    name: cfg.name,
    supports: (cap) => cfg.capabilities.includes(cap),
    unavailable: () => (!cfg.url ? "No URL configured" : !cfg.token ? "No access token (add it in Settings)" : null),

    async image(req, ctx) {
      await ctx.onProgress(5, "Uploading character & style references");
      const refs = [];
      for (const r of req.references.slice(0, 12)) {
        refs.push({ type: r.type === "style" ? "style" : "image", identifier: await ensureRef(r, ctx) });
      }
      await ctx.onProgress(15, `Submitting to Magnific (${req.model || "auto"})`);
      const prompt = req.negativePrompt ? `${req.prompt}\n\nAvoid: ${req.negativePrompt}` : req.prompt;
      const res = await callTool(cfg, "images_generate", {
        prompt,
        mode: req.model || "auto",
        aspectRatio: snapAspect(req.aspectRatio, IMAGE_ASPECTS),
        count: 1,
        ...(refs.length ? { references: refs } : {}),
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
      });
      return waitFor(identifiersOf(res), "image", ctx, 45, "Rendering frame");
    },

    async video(req, ctx) {
      const m = videoModel(req.model);
      const args: Record<string, unknown> = { prompt: req.prompt };
      if (req.model && req.model !== "auto") {
        args.slug = req.model;
        args.duration = snap(req.durationSec, m?.durations);
        if (m?.resolutions) args.resolution = m.defaultResolution || m.resolutions[0];
        args.aspectRatio = snapAspect(req.aspectRatio, m?.aspectRatios);
      } else {
        args.duration = snap(req.durationSec, [5, 10]);
        args.aspectRatio = req.aspectRatio;
      }
      await ctx.onProgress(5, "Uploading keyframe");
      if (req.startFrame) {
        args.keyframes = { start: { type: "image", url: await ensureRef(req.startFrame, ctx) } };
      } else if (req.references?.length && (m?.refs ?? true)) {
        const refs = [];
        for (const r of req.references.slice(0, 9)) refs.push({ type: r.type === "style" ? "style" : "character", url: await ensureRef(r, ctx) });
        args.references = refs;
      }
      if (req.cameraMotion && m?.cameraMotion) args.cameraMotion = req.cameraMotion;
      if (m?.sound) args.withSoundEffects = !!req.withSound;
      await ctx.onProgress(15, `Submitting to Magnific (${m?.name || "auto"})`);
      const res = await callTool(cfg, "video_generate", args);
      return waitFor(identifiersOf(res), "video", ctx, 240, "Generating clip");
    },

    async tts(req, ctx) {
      let voiceId = req.voiceId ?? cachedVoice;
      if (!voiceId) {
        const voices = await callTool(cfg, "audio_voices_list", { scope: "catalog" });
        const v = field(voices, ["id", "voiceId"]);
        voiceId = v && /^\d+$/.test(v) ? Number(v) : null;
        cachedVoice = voiceId;
      }
      await ctx.onProgress(15, "Submitting voiceover");
      const res = await callTool(cfg, "audio_tts", { text: req.text, ...(voiceId ? { voiceId } : {}), ...(req.model ? { model: req.model } : {}) });
      return waitFor(identifiersOf(res), "audio", ctx, 20, "Synthesising voice");
    },

    async music(req, ctx) {
      await ctx.onProgress(15, "Submitting score");
      const res = await callTool(cfg, "audio_music_generate", {
        prompt: req.prompt.padEnd(10, "."),
        model: "elevenlabs-music-generation-v2",
        durationSeconds: Math.round(Math.min(300, Math.max(10, req.durationSec))),
      });
      return waitFor(identifiersOf(res), "audio", ctx, 60, "Composing music");
    },

    async sfx(req, ctx) {
      await ctx.onProgress(15, "Submitting sound effect");
      const res = await callTool(cfg, "audio_sfx_generate", {
        prompt: req.prompt.slice(0, 450),
        durationSeconds: Math.round(Math.min(30, Math.max(1, req.durationSec))),
      });
      return waitFor(identifiersOf(res), "audio", ctx, 20, "Designing SFX");
    },

    async upscale(req, ctx) {
      const id = await ensureRef(req.image, ctx);
      await ctx.onProgress(15, "Submitting upscale");
      const res = await callTool(cfg, "images_upscale", {
        creationIdentifier: id,
        scale: req.scale,
        mode: "creative",
        optimised: "FilmAndPhotography",
        ...(req.prompt ? { prompt: req.prompt.slice(0, 2000) } : {}),
      });
      return waitFor(identifiersOf(res), "image", ctx, 60, "Upscaling");
    },

    async inpaint(req, ctx) {
      const id = await ensureRef(req.image, ctx);
      const mask = await ensureRef(req.mask, ctx);
      await ctx.onProgress(15, "Submitting retouch");
      const res = await callTool(cfg, "images_retouch", { creationIdentifier: id, maskCreationIdentifier: mask, prompt: req.prompt, mode: "replace" });
      return waitFor(identifiersOf(res), "image", ctx, 40, "Inpainting");
    },
  };
}

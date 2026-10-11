import { promises as fs } from "fs";
import path from "path";
import { ffmpeg, probeDuration, tmpDir } from "./ffmpeg";
import { describeImage, llmConfig, testLlm, testVision } from "./llm";
import { callTool, listTools } from "./mcp/client";
import { magnificProvider } from "./generation/magnific";
import { DEFAULT_IMAGE_MODEL, DEFAULT_IMAGE_VARIANT, DEFAULT_VIDEO_MODEL } from "./generation/catalog";
import { getSettings } from "./settings";
import { localPath } from "./storage";
import { persist } from "@/worker/store";
import { errorMessage } from "./utils";

/**
 * "Check connections" before starting a film. Each step runs on its own so the UI can show them one by one:
 *  llm      the AI model answers (Qwen3.8 Omni Flash on OpenRouter by default)
 *  vision   the AI model can see images (used for consistency, mood and frame checks)
 *  magnific signed in to Magnific (Freepik) and its tools are reachable
 *  image    Magnific renders one real test image with the default image model, and the AI looks at it
 */
export type CheckStep = "llm" | "vision" | "magnific" | "image" | "video";
export interface CheckResult {
  step: CheckStep;
  ok: boolean;
  detail: string;
  ms: number;
  url?: string;
  /** The test image, so the video step can animate it. */
  key?: string;
  providerRef?: string;
}

async function thumb(key: string) {
  try {
    return await jpegThumb(key);
  } catch {
    // ffmpeg can't read it: send the original file as is.
    const buf = await fs.readFile(await localPath(key));
    return `data:image/${key.endsWith(".jpg") || key.endsWith(".jpeg") ? "jpeg" : key.endsWith(".webp") ? "webp" : "png"};base64,${buf.toString("base64")}`;
  }
}

async function jpegThumb(key: string) {
  const dir = await tmpDir();
  const out = path.join(dir, "t.jpg");
  await ffmpeg(["-i", await localPath(key), "-vf", "scale='min(768,iw)':-2", "-frames:v", "1", "-q:v", "4", out]);
  const b64 = (await fs.readFile(out)).toString("base64");
  await fs.rm(dir, { recursive: true, force: true });
  return `data:image/jpeg;base64,${b64}`;
}

export async function runCheck(step: CheckStep, opts: { model?: string; prompt?: string; imageKey?: string; imageRef?: string } = {}): Promise<CheckResult> {
  const t0 = Date.now();
  const done = (ok: boolean, detail: string, url?: string, extra: Partial<CheckResult> = {}): CheckResult => ({ step, ok, detail, ms: Date.now() - t0, url, ...extra });
  try {
    const s = await getSettings();
    const mag = s.mcpServers.find((m) => m.kind === "magnific" && m.enabled);
    switch (step) {
      case "llm": {
        const cfg = await llmConfig();
        if (!cfg) return done(false, "No AI key yet. Add your OpenRouter key in Settings → AI assistant (or LLM_API_KEY in .env).");
        const reply = await testLlm();
        return done(true, `${cfg.model} replied “${reply.slice(0, 40)}”${cfg.reasoning ? " · reasoning on" : ""}`);
      }
      case "vision": {
        const word = await testVision();
        const ok = /red/i.test(word);
        return done(ok, ok ? `Sees images (said “${word.slice(0, 30)}” for a red square)` : `Answered “${word.slice(0, 40)}” for a red square; image checks may be unreliable`);
      }
      case "magnific": {
        if (!mag) return done(false, "Magnific is turned off in Settings → Generation backends.");
        if (!mag.token && !mag.oauthConnected) return done(false, "Not signed in. Press Connect Magnific.");
        const tools = await listTools(mag);
        let credits = "";
        try {
          const bal = (await callTool(mag, "account_balance", {}, 20_000)) as Record<string, unknown>;
          const v = JSON.stringify(bal).match(/"(?:credits|balance|available)[^"]*"\s*:\s*"?([\d.,]+)/i)?.[1];
          if (v) credits = ` · ${v} credits`;
        } catch {}
        return done(tools.length > 0, `Connected · ${tools.length} tools${credits}`);
      }
      case "image": {
        if (!mag || (!mag.token && !mag.oauthConnected)) return done(false, "Connect Magnific first.");
        const model = opts.model || DEFAULT_IMAGE_MODEL;
        const ctx = { projectId: "_check", onProgress: async () => {}, onRefUploaded: async () => {} };
        const res = await magnificProvider(mag).image!(
          { prompt: opts.prompt || "Cinematic film still: an old lighthouse on black rocks at dusk, warm lamp light, stormy sea, 35mm, shallow depth of field", aspectRatio: "16:9", model, variant: model === DEFAULT_IMAGE_MODEL ? DEFAULT_IMAGE_VARIANT : undefined, references: [] },
          ctx,
        );
        const stored = await persist("_check", "images", res);
        let seen = "";
        try {
          seen = await describeImage(await thumb(stored.key), "Describe this image in one short sentence.");
        } catch (e) {
          seen = `(AI could not look at it: ${errorMessage(e).slice(0, 80)})`;
        }
        return done(true, `Magnific made a test image with ${model}${model === DEFAULT_IMAGE_MODEL ? " (Flare)" : ""}. AI sees: ${seen.slice(0, 160)}`, stored.url, { key: stored.key, providerRef: res.providerRef });
      }
      case "video": {
        // A 10-second clip with the default video model at 720p, animated from the test image when there is one.
        if (!mag || (!mag.token && !mag.oauthConnected)) return done(false, "Connect Magnific first.");
        const model = opts.model || DEFAULT_VIDEO_MODEL;
        const ctx = { projectId: "_check", onProgress: async () => {}, onRefUploaded: async () => {} };
        const start = opts.imageKey ? { key: opts.imageKey, url: "", providerRef: opts.imageRef ?? null, type: "image" as const, label: "test image" } : null;
        const res = await magnificProvider(mag).video!(
          { prompt: opts.prompt || "Slow cinematic push-in on the lighthouse at dusk, waves breaking on the rocks, the lamp starts to turn, light rain", aspectRatio: "16:9", model, durationSec: 10, resolution: "720p", startFrame: start },
          ctx,
        );
        const stored = await persist("_check", "clips", res);
        const sec = await probeDuration(await localPath(stored.key)).catch(() => null);
        return done(true, `Magnific made a ${sec ? `${sec.toFixed(1)} s` : "10 s"} test clip with ${model} at 720p`, stored.url);
      }
    }
  } catch (e) {
    return done(false, errorMessage(e).slice(0, 400));
  }
}

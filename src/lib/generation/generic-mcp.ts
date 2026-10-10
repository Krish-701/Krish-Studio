import type { Capability, McpServerConfig } from "../settings";
import { callTool, collect, findUrls, McpToolError } from "../mcp/client";
import { externalUrl } from "../storage";
import { sleep } from "../utils";
import type { GenContext, GenerationProvider, GenResult, RefImage } from "./types";

/**
 * Adapter for any other MCP server (Veo, Kling, MiniMax, Wan, fal.ai, Replicate MCP...).
 * Each capability maps to { tool, args } where args is a JSON template with placeholders:
 *   {{prompt}} {{negative_prompt}} {{aspect_ratio}} {{duration}} {{model}} {{image_url}}
 *   {{reference_urls}} (JSON array) {{text}} {{voice_id}} {{mask_url}} {{scale}}
 * Optional poll: { tool, args } with {{id}} — called until the result contains a media URL.
 */
function fill(template: string, vars: Record<string, unknown>) {
  const out = template.replace(/"?\{\{(\w+)\}\}"?/g, (match, name) => {
    const v = vars[name];
    const quoted = match.startsWith('"') && match.endsWith('"');
    if (v === undefined || v === null) return quoted ? '""' : "null";
    if (typeof v === "string") return quoted ? JSON.stringify(v) : JSON.stringify(v).slice(1, -1);
    return JSON.stringify(v);
  });
  return JSON.parse(out) as Record<string, unknown>;
}

async function refUrl(r?: RefImage | null) {
  if (!r) return null;
  return r.key ? externalUrl(r.key) : r.url;
}

export function genericMcpProvider(cfg: McpServerConfig): GenerationProvider {
  async function run(cap: Capability, vars: Record<string, unknown>, kind: "image" | "video" | "audio", ctx: GenContext): Promise<GenResult> {
    const map = cfg.toolMap?.[cap];
    if (!map) throw new McpToolError(`${cfg.name} has no tool mapped for ${cap}`, cap, false);
    await ctx.onProgress(15, `Calling ${cfg.name}.${map.tool}`);
    let res = await callTool(cfg, map.tool, fill(map.args, vars), 600_000);
    let url = findUrls(res, kind)[0] || findUrls(res)[0];
    if (!url && map.poll) {
      const id = (collect(res, ["id", "identifier", "task_id", "taskId", "request_id", "job_id"]).find((v) => typeof v === "string" || typeof v === "number") ?? "") as string;
      const started = Date.now();
      while (!url && Date.now() - started < 20 * 60_000) {
        await sleep(4000);
        res = await callTool(cfg, map.poll.tool, fill(map.poll.args, { ...vars, id }));
        const st = collect(res, ["status", "state"]).filter((s): s is string => typeof s === "string").join(" ").toLowerCase();
        if (/fail|error|cancel/.test(st)) throw new McpToolError(`${cfg.name} reported ${st}`, map.poll.tool);
        url = findUrls(res, kind)[0];
        const el = (Date.now() - started) / 1000;
        await ctx.onProgress(Math.min(95, Math.round(20 + 75 * (1 - Math.exp(-el / 120)))), `${cfg.name} · ${st || "processing"} (${Math.round(el)}s)`);
      }
    }
    if (!url) throw new McpToolError(`${cfg.name}.${map.tool} returned no ${kind} URL`, map.tool);
    return { url, mime: kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "audio/mpeg" };
  }

  return {
    id: cfg.id,
    name: cfg.name,
    supports: (cap) => cfg.capabilities.includes(cap) && !!cfg.toolMap?.[cap],
    unavailable: () => (cfg.url ? null : "No URL configured"),
    async image(req, ctx) {
      const refs = await Promise.all(req.references.map(refUrl));
      return run("image", { prompt: req.prompt, negative_prompt: req.negativePrompt, aspect_ratio: req.aspectRatio, model: req.model, reference_urls: refs, image_url: refs[0] }, "image", ctx);
    },
    async video(req, ctx) {
      const refs = await Promise.all((req.references ?? []).map(refUrl));
      return run("video", { prompt: req.prompt, aspect_ratio: req.aspectRatio, duration: req.durationSec, model: req.model, image_url: await refUrl(req.startFrame), reference_urls: refs }, "video", ctx);
    },
    tts: (req, ctx) => run("tts", { text: req.text, voice_id: req.voiceId, model: req.model }, "audio", ctx),
    music: (req, ctx) => run("music", { prompt: req.prompt, duration: req.durationSec }, "audio", ctx),
    sfx: (req, ctx) => run("sfx", { prompt: req.prompt, duration: req.durationSec }, "audio", ctx),
    async upscale(req, ctx) {
      return run("upscale", { image_url: await refUrl(req.image), scale: req.scale, prompt: req.prompt }, "image", ctx);
    },
    async inpaint(req, ctx) {
      return run("inpaint", { image_url: await refUrl(req.image), mask_url: await refUrl(req.mask), prompt: req.prompt }, "image", ctx);
    },
  };
}

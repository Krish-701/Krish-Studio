import { promises as fs } from "fs";
import path from "path";
import { dims, ffmpeg, tmpDir } from "../ffmpeg";
import { localPath } from "../storage";
import { sleep } from "../utils";
import type { GenContext, GenerationProvider, GenResult, ImageRequest, RefImage, VideoRequest } from "./types";

/**
 * Offline preview renderer. Costs nothing and needs no credentials, so the whole
 * Script → Storyboard → Video → Audio → Export pipeline can be exercised end to end.
 * Frames are stylised cards; clips are Ken-Burns moves over the storyboard frame; audio is tones/silence.
 */
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

function wrap(text: string, width: number) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else line += " " + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

function frameSvg(req: ImageRequest, w: number, h: number) {
  const seed = hash(req.prompt + (req.seed ?? ""));
  const hue = seed % 360;
  const hue2 = (hue + 40 + (seed % 80)) % 360;
  const lines = wrap(req.prompt.split("\n")[0].replace(/\s+/g, " ").slice(0, 260), Math.round(w / 22)).slice(0, 5);
  const label = esc(req.label || "PREVIEW");
  const refs = req.references.filter((r) => r.type === "character").map((r) => r.label).filter(Boolean).join(" · ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue},45%,14%)"/>
      <stop offset="1" stop-color="hsl(${hue2},55%,6%)"/>
    </linearGradient>
    <radialGradient id="l" cx="${30 + (seed % 40)}%" cy="35%" r="60%">
      <stop offset="0" stop-color="hsl(${hue},80%,60%)" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#000" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <rect width="100%" height="100%" fill="url(#l)"/>
  <g stroke="hsl(${hue},40%,40%)" stroke-opacity="0.18">
    <line x1="${w / 3}" y1="0" x2="${w / 3}" y2="${h}"/><line x1="${(2 * w) / 3}" y1="0" x2="${(2 * w) / 3}" y2="${h}"/>
    <line x1="0" y1="${h / 3}" x2="${w}" y2="${h / 3}"/><line x1="0" y1="${(2 * h) / 3}" x2="${w}" y2="${(2 * h) / 3}"/>
  </g>
  <rect x="0" y="0" width="${w}" height="${h * 0.08}" fill="#000"/>
  <rect x="0" y="${h * 0.92}" width="${w}" height="${h * 0.08}" fill="#000"/>
  <text x="${w * 0.05}" y="${h * 0.2}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${Math.round(h * 0.045)}" font-weight="700" fill="hsl(${hue},90%,70%)" letter-spacing="4">${label}</text>
  ${lines
    .map(
      (l, i) =>
        `<text x="${w * 0.05}" y="${h * 0.34 + i * h * 0.075}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${Math.round(h * 0.042)}" fill="#e8e6e3">${esc(l)}</text>`,
    )
    .join("\n  ")}
  ${refs ? `<text x="${w * 0.05}" y="${h * 0.86}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${Math.round(h * 0.032)}" fill="hsl(${hue2},70%,70%)">◆ ${esc(refs)}</text>` : ""}
  <text x="${w * 0.95}" y="${h * 0.86}" text-anchor="end" font-family="DejaVu Sans Mono, monospace" font-size="${Math.round(h * 0.026)}" fill="#888">OFFLINE PREVIEW</text>
</svg>`;
}

/** A contact sheet / turnaround: one preview card per tile, stacked into a grid. */
async function renderGrid(req: ImageRequest): Promise<Buffer> {
  const { cols, rows, labels } = req.grid!;
  const dir = await tmpDir();
  try {
    const files: string[] = [];
    for (let i = 0; i < cols * rows; i++) {
      const f = path.join(dir, `g${i}.png`);
      await fs.writeFile(f, await renderPng({ ...req, grid: undefined, prompt: labels[i] ?? req.prompt, label: labels[i] ? `${req.label ?? ""} ${i + 1}`.trim() : req.label }));
      files.push(f);
    }
    const out = path.join(dir, "grid.png");
    const layout = files.map((_, i) => `${(i % cols) === 0 ? "0" : Array.from({ length: i % cols }, () => "w0").join("+")}_${Math.floor(i / cols) === 0 ? "0" : Array.from({ length: Math.floor(i / cols) }, () => "h0").join("+")}`).join("|");
    if (files.length === 1) await fs.copyFile(files[0], out);
    else await ffmpeg([...files.flatMap((f) => ["-i", f]), "-filter_complex", `${files.map((_, i) => `[${i}:v]`).join("")}xstack=inputs=${files.length}:layout=${layout}`, "-frames:v", "1", out]);
    return await fs.readFile(out);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Ken Burns move over a still: the preview renderer's stand-in for a generated clip. */
async function kenBurns(still: string, out: string, durationSec: number, move: string | null | undefined, w: number, h: number, onSec: (sec: number) => void) {
  const fps = 24;
  const frames = Math.max(1, Math.round(durationSec * fps));
  const mv = move || "pushIn";
  const z = /out/i.test(mv) ? `max(1.15-0.15*on/${frames},1)` : `min(1+0.15*on/${frames},1.15)`;
  const x = /left/i.test(mv) ? `(iw-iw/zoom)*(1-on/${frames})` : /right/i.test(mv) ? `(iw-iw/zoom)*on/${frames}` : `iw/2-(iw/zoom/2)`;
  await ffmpeg(
    [
      "-loop", "1", "-i", still,
      "-vf", `scale=${w * 2}:${h * 2},zoompan=z='${z}':x='${x}':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=${fps},format=yuv420p`,
      "-frames:v", String(frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-movflags", "+faststart", out,
    ],
    onSec,
  );
}

async function fakeProgress(ctx: GenContext, steps: string[], ms = 350) {
  for (let i = 0; i < steps.length; i++) {
    await ctx.onProgress(Math.round(((i + 1) / (steps.length + 1)) * 90), steps[i]);
    await sleep(ms);
  }
}

async function renderPng(req: ImageRequest): Promise<Buffer> {
  const [w, h] = dims(req.aspectRatio, 1280);
  const dir = await tmpDir();
  const svg = path.join(dir, "f.svg");
  const png = path.join(dir, "f.png");
  await fs.writeFile(svg, frameSvg(req, w, h));
  try {
    await ffmpeg(["-i", svg, "-frames:v", "1", png]);
  } catch {
    const hue = hash(req.prompt) % 360;
    await ffmpeg(["-f", "lavfi", "-i", `color=c=0x${((hue * 7919) & 0x3f3f3f).toString(16).padStart(6, "0")}:s=${w}x${h}`, "-frames:v", "1", png]);
  }
  const buf = await fs.readFile(png);
  await fs.rm(dir, { recursive: true, force: true });
  return buf;
}

async function toneWav(seconds: number, kind: "tts" | "music" | "sfx", seed: string): Promise<Buffer> {
  const dir = await tmpDir();
  const out = path.join(dir, "a.mp3");
  const f = 180 + (hash(seed) % 300);
  const src =
    kind === "music"
      ? `sine=f=${f}:d=${seconds},volume=0.12`
      : kind === "sfx"
        ? `anoisesrc=d=${seconds}:c=pink:a=0.08`
        : `sine=f=${f}:d=${seconds},volume=0.05`;
  await ffmpeg(["-f", "lavfi", "-i", src, "-ac", "2", "-ar", "44100", "-b:a", "128k", out]);
  const buf = await fs.readFile(out);
  await fs.rm(dir, { recursive: true, force: true });
  return buf;
}

export const mockProvider: GenerationProvider = {
  id: "preview",
  name: "Offline preview renderer",
  supports: () => true,

  async image(req, ctx): Promise<GenResult> {
    await fakeProgress(ctx, ["Composing frame", "Applying style lock", "Injecting character refs"]);
    if (req.grid) return { buffer: await renderGrid(req), mime: "image/png", meta: { preview: true } };
    return { buffer: await renderPng(req), mime: "image/png", meta: { preview: true } };
  },

  async video(req: VideoRequest, ctx): Promise<GenResult> {
    await ctx.onProgress(10, "Preparing keyframe");
    const [w, h] = dims(req.aspectRatio, 1280);
    const dir = await tmpDir();
    const stillFor = async (ref: RefImage | null | undefined, label: string | undefined, i: number) => {
      if (ref?.key && (ref.media ?? "image") === "image") return localPath(ref.key);
      const file = path.join(dir, `s${i}.png`);
      await fs.writeFile(file, await renderPng({ prompt: req.prompt, aspectRatio: req.aspectRatio, references: [], label }));
      return file;
    };
    const firstImageRef = req.references?.find((r) => (r.media ?? "image") === "image" && /storyboard frame/.test(r.label ?? ""));
    // Multi-shot: one segment per shot, each from that shot's storyboard frame when it was sent as a reference.
    const frames = req.references?.filter((r) => /storyboard frame/.test(r.label ?? "")) ?? [];
    const segs = req.multiPrompt?.length
      ? req.multiPrompt.map((p, i) => ({ dur: p.durationSec, move: p.cameraMotion, ref: frames[i] ?? null, label: `${req.label ?? "SCENE"} · ${i + 1}` }))
      : [{ dur: req.durationSec, move: req.cameraMotion, ref: req.startFrame ?? firstImageRef ?? null, label: req.label }];
    const files: string[] = [];
    const total = segs.reduce((a, b) => a + b.dur, 0);
    let done = 0;
    for (const [i, sg] of segs.entries()) {
      const out = path.join(dir, `v${i}.mp4`);
      await kenBurns(await stillFor(sg.ref, sg.label, i), out, sg.dur, sg.move, w, h, (sec) => ctx.onProgress(Math.min(95, 15 + Math.round(((done + sec) / total) * 80)), "Rendering motion"));
      done += sg.dur;
      files.push(out);
    }
    let final = files[0];
    if (files.length > 1) {
      final = path.join(dir, "all.mp4");
      await ffmpeg([...files.flatMap((f) => ["-i", f]), "-filter_complex", `${files.map((_, i) => `[${i}:v]`).join("")}concat=n=${files.length}:v=1:a=0`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-movflags", "+faststart", final]);
    }
    const buf = await fs.readFile(final);
    await fs.rm(dir, { recursive: true, force: true });
    return { buffer: buf, mime: "video/mp4", durationSec: total, meta: { preview: true, segments: segs.map((x) => x.dur) } };
  },

  async extend(req, ctx) {
    await ctx.onProgress(10, "Reading last frame");
    const dir = await tmpDir();
    if (!req.video.key) throw new Error("Preview extend needs a stored clip");
    const still = path.join(dir, "last.png");
    await ffmpeg(["-sseof", "-0.15", "-i", await localPath(req.video.key), "-frames:v", "1", "-update", "1", still]);
    const out = path.join(dir, "ext.mp4");
    await kenBurns(still, out, req.durationSec, "pushIn", 1280, 720, (sec) => ctx.onProgress(Math.min(95, 15 + Math.round((sec / req.durationSec) * 80)), "Extending"));
    const buf = await fs.readFile(out);
    await fs.rm(dir, { recursive: true, force: true });
    return { buffer: buf, mime: "video/mp4", durationSec: req.durationSec, meta: { preview: true } };
  },

  async tts(req, ctx) {
    await fakeProgress(ctx, ["Synthesising voice"]);
    const sec = Math.max(1.5, Math.min(30, req.text.split(/\s+/).length / 2.6));
    return { buffer: await toneWav(sec, "tts", req.text), mime: "audio/mpeg", durationSec: sec, meta: { preview: true } };
  },

  async music(req, ctx) {
    await fakeProgress(ctx, ["Composing score"]);
    return { buffer: await toneWav(req.durationSec, "music", req.prompt), mime: "audio/mpeg", durationSec: req.durationSec, meta: { preview: true } };
  },

  async sfx(req, ctx) {
    await fakeProgress(ctx, ["Designing sound"]);
    return { buffer: await toneWav(req.durationSec, "sfx", req.prompt), mime: "audio/mpeg", durationSec: req.durationSec, meta: { preview: true } };
  },

  async upscale(req, ctx) {
    await fakeProgress(ctx, ["Upscaling"]);
    const dir = await tmpDir();
    const src = req.image.key ? await localPath(req.image.key) : null;
    if (!src) throw new Error("Preview upscale needs a stored image");
    const out = path.join(dir, "u.png");
    await ffmpeg(["-i", src, "-vf", `scale=iw*${req.scale === "4x" ? 4 : 2}:-1:flags=lanczos`, out]);
    const buf = await fs.readFile(out);
    await fs.rm(dir, { recursive: true, force: true });
    return { buffer: buf, mime: "image/png", meta: { preview: true } };
  },

  async inpaint(req, ctx) {
    await fakeProgress(ctx, ["Inpainting region"]);
    return { buffer: await renderPng({ prompt: req.prompt, aspectRatio: "16:9", references: [], label: "INPAINT" }), mime: "image/png", meta: { preview: true } };
  },
};

import { createHash } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { db } from "../db";
import { dims, ffmpeg, tmpDir } from "../ffmpeg";
import { localPath, newKey, publicUrl, putFile, storageDriver } from "../storage";
import { clipLen } from "../timeline";

const XFADE: Record<string, string> = { fade: "fade", crossfade: "dissolve", dissolve: "dissolve", dip: "fadeblack", fadeblack: "fadeblack", wipe: "wipeleft", slide: "slideleft" };
const TRANSITION_SEC = 0.5;
export const LONG_EDGE: Record<string, number> = { "720p": 1280, "1080p": 1920, "4K": 3840, "4k": 3840 };
/** Audio is mixed in bounded graphs: at most this many inputs per ffmpeg call. */
const MIX_MAX = 60;
/** Bump when conform/transition encoding changes so stale cache files are not reused. */
const CACHE_VERSION = "v2";
const PRESET = process.env.EXPORT_X264_PRESET || "medium";
const ENC = ["-c:v", "libx264", "-preset", PRESET, "-crf", "18", "-pix_fmt", "yuv420p", "-video_track_timescale", "90000"];

type Progress = (pct: number, step: string) => void | Promise<void>;
type Seg = { key: string; head: string | null; body: string | null; tail: string | null };
/** An audio input placed on the timeline; `inPoint` is set only for source clips (not yet trimmed). */
type Mixable = { file: string; offset: number; len: number; inPoint?: number; volume?: number };

const hash = (...parts: unknown[]) => createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 20);
const exists = (f: string) => fs.access(f).then(() => true, () => false);
const exportCacheDir = (projectId: string) => path.join(process.cwd(), "storage", "cache", projectId);

/** Runs tasks with bounded concurrency, preserving result order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** Produces `file` via `make(tmp)` unless it is already cached; writes are atomic so a crash never leaves a half file. */
async function cached(file: string, make: (tmp: string) => Promise<void>) {
  if (await exists(file)) return true;
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.part${path.extname(file)}`;
  await make(tmp);
  await fs.rename(tmp, file);
  return false;
}

/** Stores a (possibly multi-GB) file without loading it into memory on the local driver. */
export async function storeFile(key: string, file: string, mime: string) {
  if (storageDriver !== "s3") {
    const dest = await localPath(key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(file, dest).catch(() => fs.copyFile(file, dest));
    return { key, url: publicUrl(key) };
  }
  // S3: putFile takes a Buffer, so files over ~2 GB need a streaming multipart upload in storage.ts.
  return putFile(key, await fs.readFile(file), mime);
}

/**
 * Renders the timeline (video track + voice/music/sfx tracks) to a single MP4, scaling from 30s spots
 * to 3h features without ever building one giant filter graph:
 *  1) every video clip is conformed once into cached pieces (re-exports only re-encode changed clips),
 *  2) only the few frames under each transition are re-encoded (xfade of tail + head),
 *  3) all pieces are joined with the concat demuxer (stream copy) — no whole-film filter graph,
 *  4) audio is mixed in bounded chunks (≤60 inputs per graph, see mixAll), then muxed.
 */
export async function exportMp4(projectId: string, onProgress: Progress) {
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  const clips = await db.timelineClip.findMany({ where: { projectId }, include: { asset: true }, orderBy: { start: "asc" } });
  const video = clips.filter((c) => c.track === "VIDEO" && c.asset?.storageKey);
  if (!video.length) throw new Error("The timeline has no video clips yet. Generate clips first.");
  const audio = clips.filter((c) => c.track !== "VIDEO" && c.asset?.storageKey);
  const fps = project.fps > 0 ? project.fps : 24;
  const [W, H] = dims(project.aspectRatio, LONG_EDGE[project.resolution] ?? 1920);
  const cache = exportCacheDir(projectId);
  await fs.mkdir(cache, { recursive: true });
  const dir = await tmpDir();
  const used = new Set<string>();
  const workers = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));

  try {
    // 0) Frame plan. A transition's overlap is taken from the timeline (clip.start), so picture stays in
    // sync with the audio track even when 0.5s is not a whole number of frames.
    const plan = video.map((c) => ({ c, frames: Math.max(1, Math.round(clipLen(c) * fps)), dIn: 0, dOut: 0, tr: null as string | null }));
    let end = 0;
    for (const [i, p] of plan.entries()) {
      if (i > 0 && p.c.transition !== "none") {
        const prev = plan[i - 1];
        const overlap = end - Math.round(p.c.start * fps);
        const d = Math.min(overlap > 0 ? overlap : Math.round(TRANSITION_SEC * fps), Math.floor(prev.frames / 2), Math.floor(p.frames / 2));
        if (d > 0) {
          p.tr = XFADE[p.c.transition] ?? "fade";
          p.dIn = prev.dOut = d;
        }
      }
      end += p.frames - p.dIn;
    }
    const totalFrames = end;
    const total = totalFrames / fps;

    // 1) Conform: trim, scale/pad, fixed fps, exact frame count, no audio. Each clip is cut into
    // head (frames under the incoming transition), body and tail (frames under the outgoing transition),
    // so only the short overlaps are ever re-encoded again and everything else joins by stream copy.
    let done = 0;
    await onProgress(2, `Conforming ${video.length} clips`);
    const segs: Seg[] = await pool(plan, workers, async ({ c, frames, dIn, dOut }) => {
      const a = c.asset!;
      const key = hash(CACHE_VERSION, a.storageKey, c.inPoint, c.outPoint, W, H, fps, PRESET, dIn, dOut);
      const part = (name: string) => path.join(cache, `seg-${key}-${name}.mp4`);
      const parts = { head: dIn ? part("head") : null, body: frames - dIn - dOut > 0 ? part("body") : null, tail: dOut ? part("tail") : null };
      const files = Object.values(parts).filter((f): f is string => !!f);
      files.forEach((f) => used.add(f));
      const hit = (await Promise.all(files.map(exists))).every(Boolean);
      if (!hit) {
        const image = !!a.mimeType?.startsWith("image/");
        const cuts: [string | null, number, number][] = [[parts.head, 0, dIn], [parts.body, dIn, frames - dOut], [parts.tail, frames - dOut, frames]];
        const live = cuts.filter(([f]) => f);
        const filters = [
          `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p,tpad=stop_mode=clone:stop_duration=${(frames / fps).toFixed(3)},split=${live.length}${live.map((_, i) => `[p${i}]`).join("")}`,
          ...live.map(([, from, to], i) => `[p${i}]trim=start_frame=${from}:end_frame=${to},setpts=PTS-STARTPTS[o${i}]`),
        ];
        const tmps = live.map(([f]) => `${f}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.part.mp4`);
        await ffmpeg([
          ...(image ? ["-loop", "1", "-t", String(frames / fps + 1)] : ["-ss", String(c.inPoint), "-t", String(frames / fps + 1)]), "-i", await localPath(a.storageKey!),
          "-filter_complex", filters.join(";"),
          ...live.flatMap((_, i) => ["-map", `[o${i}]`, "-an", ...ENC, tmps[i]]),
        ]);
        await Promise.all(live.map(([f], i) => fs.rename(tmps[i], f!)));
      }
      done++;
      await onProgress(2 + Math.round((done / video.length) * 63), `${hit ? "Cached" : "Conformed"} clip ${done}/${video.length}`);
      return { key, ...parts };
    });

    // 2) Transitions: blend the outgoing tail with the incoming head (only `d` frames each).
    await onProgress(65, `Rendering ${plan.filter((p) => p.tr).length} transitions`);
    const pieces: string[][] = segs.map(() => []);
    await pool(plan, workers, async (p, i) => {
      if (p.tr) {
        const file = path.join(cache, `xf-${hash(CACHE_VERSION, segs[i - 1].key, segs[i].key, p.tr, p.dIn)}.mp4`);
        used.add(file);
        await cached(file, (tmp) =>
          ffmpeg([
            "-i", segs[i - 1].tail!, "-i", segs[i].head!,
            "-filter_complex", `[0:v]settb=AVTB[a];[1:v]settb=AVTB[b];[a][b]xfade=transition=${p.tr}:duration=${(p.dIn / fps).toFixed(4)}:offset=0[o]`,
            "-map", "[o]", "-frames:v", String(p.dIn), "-an", ...ENC, tmp,
          ]),
        );
        pieces[i].push(file);
      }
      if (segs[i].body) pieces[i].push(segs[i].body!);
    });

    // 3) Join every piece with the concat demuxer (stream copy): they all share encoder settings, so no
    // re-encode and no filter graph at all, however many clips. The demuxer opens files one at a time.
    await onProgress(70, `Joining ${video.length} clips`);
    const list = path.join(dir, "pieces.txt");
    await fs.writeFile(list, pieces.flat().map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
    const picture = path.join(dir, "picture.mp4");
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-an", picture], (sec) => onProgress(70 + Math.round((sec / total) * 14), "Joining clips"));

    // 4) Audio: mix in bounded chunks, cached as a whole.
    let mixed: string | null = null;
    if (audio.length) {
      await onProgress(84, `Mixing ${audio.length} audio clips`);
      const items: Mixable[] = await Promise.all(
        audio.map(async (c) => ({ file: await localPath(c.asset!.storageKey!), offset: c.start, len: clipLen(c), inPoint: c.inPoint, volume: c.volume })),
      );
      mixed = path.join(cache, `mix-${hash(CACHE_VERSION, audio.map((c) => [c.asset!.storageKey, c.start, c.inPoint, c.outPoint, c.volume]), totalFrames, fps)}.m4a`);
      used.add(mixed);
      const out = mixed;
      await cached(out, async (tmp) => {
        const lanes = await mixAll(items, dir, (pct) => onProgress(84 + Math.round(pct * 4), "Mixing audio"));
        await onProgress(88, "Encoding audio");
        await ffmpeg([...lanes.flatMap((l) => ["-i", l.file]), "-filter_complex", lanesGraph(lanes, 0, `,apad,atrim=0:${total.toFixed(3)}`), "-map", "[aout]", "-c:a", "aac", "-b:a", "192k", tmp]);
      });
    }

    // 5) Mux.
    await onProgress(93, "Muxing master");
    const out = path.join(dir, "film.mp4");
    if (mixed) await ffmpeg(["-i", picture, "-i", mixed, "-map", "0:v", "-map", "1:a", "-c", "copy", "-t", total.toFixed(3), "-movflags", "+faststart", out]);
    else await ffmpeg(["-i", picture, "-c", "copy", "-movflags", "+faststart", out]);

    // Drop cache files that this export no longer references (replaced or removed clips).
    for (const f of await fs.readdir(cache)) {
      const full = path.join(cache, f);
      if (!used.has(full) && !f.includes(".part")) await fs.rm(full, { force: true });
    }

    await onProgress(97, "Saving export");
    const key = newKey(projectId, "exports", "video/mp4");
    const stored = await storeFile(key, out, "video/mp4");
    const asset = await db.asset.create({
      data: { projectId, kind: "VIDEO", role: "EXPORT", name: `${project.title}.mp4`, storageKey: stored.key, url: stored.url, mimeType: "video/mp4", durationSec: total, meta: { width: W, height: H, fps, clips: segs.length, transitions: plan.filter((p) => p.tr).length, audioClips: audio.length } },
    });
    return { assetId: asset.id, url: asset.url, durationSec: total };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Mixes any number of audio clips with bounded graphs and work proportional to the film length:
 *  - clips are packed into lanes of non-overlapping clips (interval partitioning; a film needs only a few),
 *  - each lane is rendered by concatenating its clips with silence between them, ≤MIX_MAX clips per graph,
 *    and the chunk files are concatenated the same way until the lane is one file,
 *  - the lanes are mixed (amix), again ≤MIX_MAX inputs at a time; the last amix happens in the AAC encode.
 * Mixing with adelay instead would make every input as long as its window, which is far slower at 3h.
 */
async function mixAll(items: Mixable[], dir: string, onProgress: (frac: number) => void | Promise<void>): Promise<Mixable[]> {
  const lanes: Mixable[][] = [];
  for (const it of [...items].sort((a, b) => a.offset - b.offset)) {
    const lane = lanes.find((l) => l[l.length - 1].offset + l[l.length - 1].len <= it.offset + 1e-6);
    if (lane) lane.push(it);
    else lanes.push([it]);
  }
  let n = 0;
  const fmt = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
  const render = async (inputs: Mixable[], filter: string) => {
    const file = path.join(dir, `mix${n++}.wav`);
    await ffmpeg([...inputs.flatMap((c) => ["-i", c.file]), "-filter_complex", filter, "-map", "[aout]", "-c:a", "pcm_f32le", "-rf64", "auto", file]);
    return file;
  };
  const flat: Mixable[] = [];
  for (const [l, lane] of lanes.entries()) {
    let level = lane;
    while (level.length > 1 || level[0].inPoint !== undefined) {
      const next: Mixable[] = [];
      for (let i = 0; i < level.length; i += MIX_MAX) {
        const chunk = level.slice(i, i + MIX_MAX);
        const base = chunk[0].offset;
        const last = chunk[chunk.length - 1];
        // Each clip is trimmed/padded to exactly the time until the next clip starts, then all are concatenated.
        const parts = chunk.map((c, j) => {
          const slot = j < chunk.length - 1 ? chunk[j + 1].offset - c.offset : c.len;
          return `[${j}:a]atrim=start=${c.inPoint ?? 0}:duration=${c.len},asetpts=PTS-STARTPTS,${fmt},volume=${c.volume ?? 1},apad=whole_dur=${slot.toFixed(6)},atrim=duration=${slot.toFixed(6)}[a${j}]`;
        });
        const file = await render(chunk, [...parts, `${chunk.map((_, j) => `[a${j}]`).join("")}concat=n=${chunk.length}:v=0:a=1[aout]`].join(";"));
        next.push({ file, offset: base, len: last.offset + last.len - base });
      }
      level = next;
    }
    flat.push(level[0]);
    await onProgress((l + 1) / (lanes.length + 1));
  }
  // Mix lanes down until ≤MIX_MAX remain; the caller mixes those straight into the AAC master.
  let level = flat;
  while (level.length > MIX_MAX) {
    const next: Mixable[] = [];
    for (let i = 0; i < level.length; i += MIX_MAX) {
      const chunk = level.slice(i, i + MIX_MAX);
      const base = Math.min(...chunk.map((c) => c.offset));
      const file = await render(chunk, lanesGraph(chunk, base, ""));
      next.push({ file, offset: base, len: Math.max(...chunk.map((c) => c.offset + c.len)) - base });
    }
    level = next;
  }
  return level;
}

/** amix of rendered lanes, each delayed to its offset from `base`. */
function lanesGraph(lanes: Mixable[], base: number, after: string) {
  const parts = lanes.map((c, j) => `[${j}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${Math.round((c.offset - base) * 1000)}:all=1[a${j}]`);
  const mix = lanes.length > 1 ? `${lanes.map((_, j) => `[a${j}]`).join("")}amix=inputs=${lanes.length}:normalize=0:duration=longest` : "[a0]anull";
  return [...parts, `${mix}${after}[aout]`].join(";");
}

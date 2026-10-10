import { promises as fs } from "fs";
import path from "path";
import { db } from "../db";
import { dims, ffmpeg, tmpDir } from "../ffmpeg";
import { localPath, newKey, putFile } from "../storage";
import { clipLen } from "../timeline";

const XFADE: Record<string, string> = { fade: "fade", crossfade: "dissolve", dissolve: "dissolve", dip: "fadeblack", fadeblack: "fadeblack", wipe: "wipeleft", slide: "slideleft" };
const TRANSITION_SEC = 0.5;

/** Renders the timeline (video track + voice/music/sfx tracks) to a single MP4. */
export async function exportMp4(projectId: string, onProgress: (pct: number, step: string) => void | Promise<void>) {
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  const clips = await db.timelineClip.findMany({ where: { projectId }, include: { asset: true }, orderBy: { start: "asc" } });
  const video = clips.filter((c) => c.track === "VIDEO" && c.asset?.storageKey);
  if (!video.length) throw new Error("The timeline has no video clips yet. Generate clips first.");
  const audio = clips.filter((c) => c.track !== "VIDEO" && c.asset?.storageKey);
  const [W, H] = dims(project.aspectRatio, 1920);
  const dir = await tmpDir();

  // 1) Normalise every clip (trim, scale/pad, 24fps, no audio) so xfade can join them.
  const segs: { file: string; dur: number; transition: string }[] = [];
  for (const [i, c] of video.entries()) {
    await onProgress(5 + Math.round((i / video.length) * 45), `Conforming clip ${i + 1}/${video.length}`);
    const src = await localPath(c.asset!.storageKey!);
    const out = path.join(dir, `seg${i}.mp4`);
    const dur = clipLen(c);
    await ffmpeg([
      "-ss", String(c.inPoint), "-t", String(dur), "-i", src,
      "-vf", `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,fps=24,format=yuv420p,setsar=1`,
      "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", out,
    ]);
    segs.push({ file: out, dur, transition: c.transition });
  }

  // 2) Join with transitions.
  const inputs: string[] = [];
  segs.forEach((s) => inputs.push("-i", s.file));
  const filters: string[] = [];
  let last = "[0:v]";
  let t = segs[0].dur;
  for (let i = 1; i < segs.length; i++) {
    const tr = XFADE[segs[i].transition];
    const outLabel = `[v${i}]`;
    if (tr) {
      const d = Math.min(TRANSITION_SEC, segs[i].dur / 2, segs[i - 1].dur / 2);
      filters.push(`${last}[${i}:v]xfade=transition=${tr}:duration=${d}:offset=${(t - d).toFixed(3)}${outLabel}`);
      t += segs[i].dur - d;
    } else {
      filters.push(`${last}[${i}:v]concat=n=2:v=1:a=0${outLabel}`);
      t += segs[i].dur;
    }
    last = outLabel;
  }
  const total = t;

  // 3) Mix audio tracks at their timeline positions.
  const audioFilters: string[] = [];
  const aLabels: string[] = [];
  for (const [i, c] of audio.entries()) {
    const src = await localPath(c.asset!.storageKey!);
    inputs.push("-i", src);
    const idx = segs.length + i;
    const delay = Math.max(0, Math.round(c.start * 1000));
    audioFilters.push(
      `[${idx}:a]atrim=start=${c.inPoint}:end=${c.outPoint},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo,volume=${c.volume},adelay=${delay}|${delay}[a${i}]`,
    );
    aLabels.push(`[a${i}]`);
  }
  if (aLabels.length) audioFilters.push(`${aLabels.join("")}amix=inputs=${aLabels.length}:normalize=0:duration=longest,atrim=0:${total.toFixed(3)}[aout]`);

  const graph = [...filters, ...audioFilters].join(";");
  const out = path.join(dir, "film.mp4");
  const args = [...inputs];
  if (graph) args.push("-filter_complex", graph);
  args.push("-map", segs.length > 1 ? last : "0:v");
  if (aLabels.length) args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
  args.push("-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-t", total.toFixed(3), out);

  await onProgress(55, "Mixing audio & encoding master");
  await ffmpeg(args, (sec) => onProgress(Math.min(97, 55 + Math.round((sec / total) * 42)), `Encoding ${Math.round(sec)}s / ${Math.round(total)}s`));

  const buf = await fs.readFile(out);
  const key = newKey(projectId, "exports", "video/mp4");
  const stored = await putFile(key, buf, "video/mp4");
  await fs.rm(dir, { recursive: true, force: true });
  const asset = await db.asset.create({
    data: { projectId, kind: "VIDEO", role: "EXPORT", name: `${project.title}.mp4`, storageKey: stored.key, url: stored.url, mimeType: "video/mp4", durationSec: total, meta: { width: W, height: H, clips: segs.length, audioClips: aLabels.length } },
  });
  return { assetId: asset.id, url: asset.url, durationSec: total };
}

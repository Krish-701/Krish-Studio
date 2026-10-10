import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import zlib from "zlib";
import type { Asset, Job, Prisma } from "@prisma/client";
import { db } from "../db";
import { dims, tmpDir } from "../ffmpeg";
import { extFor, localPath, newKey, storageDriver } from "../storage";
import { clipLen } from "../timeline";
import { LONG_EDGE, pool, storeFile } from "./mp4";

type Progress = (pct: number, step: string) => void | Promise<void>;

/** Media is bundled into the zip below this size; above it the package carries only download_media.sh. */
const MEDIA_LIMIT = 2 * 1024 ** 3;
const ROLE: Record<string, { lane: number; role: string }> = { VOICE: { lane: -1, role: "dialogue" }, MUSIC: { lane: -2, role: "music" }, SFX: { lane: -3, role: "effects" } };

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const csv = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "clip";
const metaOf = (a?: { meta: Prisma.JsonValue } | null) => (a?.meta && typeof a.meta === "object" && !Array.isArray(a.meta) ? (a.meta as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/**
 * Editor / festival deliverables: timeline.fcpxml (Resolve / Final Cut), a CMX3600 EDL (video, any NLE),
 * a per-shot production log (AI disclosure), a media download script and, when small enough, the media itself.
 */
export async function exportPackage(projectId: string, onProgress: Progress, opts: { includeMedia?: boolean } = {}) {
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  const fps = project.fps > 0 ? project.fps : 24;
  const clips = await db.timelineClip.findMany({ where: { projectId }, include: { asset: true }, orderBy: [{ start: "asc" }, { lane: "asc" }] });
  const video = clips.filter((c) => c.track === "VIDEO" && c.asset?.storageKey);
  const audio = clips.filter((c) => c.track !== "VIDEO" && c.asset?.storageKey);
  const shots = await db.shot.findMany({ where: { projectId }, orderBy: { order: "asc" }, include: { scene: true } });
  const shotById = new Map(shots.map((s) => [s.id, s]));
  const dir = await tmpDir();
  const stage = path.join(dir, "package");
  await fs.mkdir(path.join(stage, "media"), { recursive: true });

  try {
    // Media names, in first-use order (video track first).
    await onProgress(5, "Collecting media");
    const media = new Map<string, { asset: Asset; name: string; id: string; maxOut: number; isVideo: boolean }>();
    for (const c of [...video, ...audio]) {
      const a = c.asset!;
      let m = media.get(a.id);
      if (!m) {
        const shot = c.shotId ? shotById.get(c.shotId) : null;
        const label = c.track === "VIDEO" ? shot ? `s${shot.order + 1}_${shot.title}` : a.name ?? "shot" : `${c.track.toLowerCase()}_${a.name ?? c.label ?? ""}`;
        const n = media.size + 1;
        m = { asset: a, name: `${String(n).padStart(4, "0")}_${slug(label)}.${extFor(a.mimeType ?? "", a.storageKey ?? undefined)}`, id: `a${n}`, maxOut: 0, isVideo: c.track === "VIDEO" && !a.mimeType?.startsWith("image/") };
        media.set(a.id, m);
      }
      m.maxOut = Math.max(m.maxOut, c.outPoint);
    }

    // Probe streams/durations so the NLE links audio-bearing video clips correctly.
    const probes = new Map<string, { duration: number | null; audio: boolean; size: number }>();
    const local = storageDriver !== "s3";
    await pool([...media.values()], 8, async (m) => {
      if (!local) return probes.set(m.asset.id, { duration: m.asset.durationSec, audio: !m.isVideo, size: 0 });
      const file = await localPath(m.asset.storageKey!);
      const size = await fs.stat(file).then((s) => s.size, () => 0);
      probes.set(m.asset.id, { ...(await probe(file)), size });
    });

    // Timeline in frames.
    const F = (sec: number) => Math.round(sec * fps);
    const T = (frames: number) => (frames === 0 ? "0s" : `${frames}/${fps}s`);
    type SpineItem = { kind: "clip" | "gap"; offset: number; start: number; dur: number; clip?: (typeof video)[number]; xfade?: number; children: string[] };
    const spine: SpineItem[] = [];
    let pos = 0;
    for (const [i, c] of video.entries()) {
      const s = Math.max(pos, F(c.start));
      if (s > pos) spine.push({ kind: "gap", offset: pos, start: 0, dur: s - pos, children: [] });
      const len = Math.max(1, F(clipLen(c)));
      const next = video[i + 1];
      // Overlapping neighbours (transitions) are trimmed at the next clip's start; the overlap becomes a
      // transition that starts on the edit, using this clip's tail as the handle (as the MP4 export renders it).
      const overlap = next ? s + len - F(next.start) : 0;
      const dur = overlap > 0 ? Math.max(1, len - overlap) : len;
      spine.push({ kind: "clip", offset: s, start: F(c.inPoint), dur, clip: c, xfade: overlap > 0 && next.transition !== "none" ? len - dur : 0, children: [] });
      pos = s + dur;
    }
    const seqDur = Math.max(pos, ...audio.map((c) => F(c.start) + F(clipLen(c))), 1);
    if (!spine.length || pos < seqDur) spine.push({ kind: "gap", offset: pos, start: 0, dur: seqDur - pos, children: [] });

    // Scene markers on the first clip of each scene.
    let lastScene: string | null | undefined;
    for (const it of spine) {
      if (it.kind !== "clip") continue;
      const scene = it.clip!.shotId ? shotById.get(it.clip!.shotId)?.scene : null;
      if (scene && scene.id !== lastScene) it.children.push(`<marker start="${T(it.start)}" duration="${T(1)}" value="${xml(`${scene.index + 1}. ${scene.heading}`)}"/>`);
      lastScene = scene?.id ?? lastScene;
    }

    // Connected audio, anchored to the spine item under its start, in that item's local time.
    for (const c of audio) {
      const at = F(c.start);
      const host = spine.find((it) => at >= it.offset && at < it.offset + it.dur) ?? spine[spine.length - 1];
      const m = media.get(c.asset!.id)!;
      const r = ROLE[c.track];
      const vol = c.volume === 1 ? "" : `<adjust-volume amount="${c.volume > 0 ? (20 * Math.log10(c.volume)).toFixed(1) : "-96"}dB"/>`;
      host.children.push(
        `<asset-clip ref="${m.id}" lane="${r.lane}" offset="${T(host.start + at - host.offset)}" name="${xml(c.label ?? m.name)}" start="${T(F(c.inPoint))}" duration="${T(Math.max(1, F(clipLen(c))))}" audioRole="${r.role}">${vol}</asset-clip>`,
      );
    }

    await onProgress(25, "Writing FCPXML & EDL");
    const [width, height] = dims(project.aspectRatio, LONG_EDGE[project.resolution] ?? 1920);
    const assets = [...media.values()].map((m) => {
      const p = probes.get(m.asset.id);
      const dur = Math.max(F(p?.duration ?? m.asset.durationSec ?? 0), F(m.maxOut), 1);
      const hasAudio = m.isVideo ? (p?.audio ? 1 : 0) : 1;
      const v = m.isVideo || m.asset.mimeType?.startsWith("image/") ? ` hasVideo="1" format="r1"` : ` hasVideo="0"`;
      return `    <asset id="${m.id}" name="${xml(m.name)}" start="0s" duration="${T(dur)}"${v} hasAudio="${hasAudio}"${hasAudio ? ` audioSources="1" audioChannels="2" audioRate="48000"` : ""}>\n      <media-rep kind="original-media" src="media/${xml(m.name)}"/>\n    </asset>`;
    });
    const items = spine.flatMap((it, i) => {
      const out: string[] = [];
      const kids = it.children.map((k) => `\n            ${k}`).join("");
      const close = (tag: string) => (kids ? `>${kids}\n          </${tag}>` : "/>");
      if (it.kind === "gap") out.push(`          <gap name="Gap" offset="${T(it.offset)}" start="0s" duration="${T(it.dur)}"${close("gap")}`);
      else {
        const m = media.get(it.clip!.asset!.id)!;
        const shot = it.clip!.shotId ? shotById.get(it.clip!.shotId) : null;
        out.push(`          <asset-clip ref="${m.id}" offset="${T(it.offset)}" name="${xml(shot ? `${shot.order + 1}. ${shot.title}` : it.clip!.label ?? m.name)}" start="${T(it.start)}" duration="${T(it.dur)}" format="r1" tcFormat="NDF"${close("asset-clip")}`);
      }
      const next = spine[i + 1];
      if (it.xfade && next) out.push(`          <transition name="Cross Dissolve" offset="${T(next.offset)}" duration="${T(it.xfade)}"/>`);
      return out;
    });
    const fcpxml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="r1" name="FFVideoFormat${height}p${fps}" frameDuration="1/${fps}s" width="${width}" height="${height}" colorSpace="1-1-1 (Rec. 709)"/>
${assets.join("\n")}
  </resources>
  <library>
    <event name="${xml(project.title)}">
      <project name="${xml(project.title)}">
        <sequence format="r1" duration="${T(seqDur)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
${items.join("\n")}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
    await fs.writeFile(path.join(stage, "timeline.fcpxml"), fcpxml);

    // CMX3600: one event per clip; dissolves as the classic "C then D" pair.
    const tc = (frames: number) => {
      const f = frames % fps, s = Math.floor(frames / fps);
      return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60, f].map((n) => String(n).padStart(2, "0")).join(":");
    };
    const edl = [`TITLE: ${project.title.replace(/[^\x20-\x7E]/g, "").slice(0, 60)}`, "FCM: NON-DROP FRAME", ""];
    let ev = 0;
    const clipItems = spine.filter((it) => it.kind === "clip");
    for (const [i, it] of clipItems.entries()) {
      const name = media.get(it.clip!.asset!.id)!.name;
      const prev = clipItems[i - 1];
      const num = () => String(++ev).padStart(3, "0");
      const rec = `${tc(it.offset)} ${tc(it.offset + it.dur)}`;
      if (prev?.xfade && prev.offset + prev.dur === it.offset) {
        const n = num();
        const at = prev.start + prev.dur;
        edl.push(`${n}  AX       V     C        ${tc(at)} ${tc(at)} ${tc(it.offset)} ${tc(it.offset)}`);
        edl.push(`${n}  AX       V     D    ${String(prev.xfade).padStart(3, "0")} ${tc(it.start)} ${tc(it.start + it.dur)} ${rec}`);
        edl.push(`* FROM CLIP NAME: ${media.get(prev.clip!.asset!.id)!.name}`, `* TO CLIP NAME: ${name}`, "");
      } else {
        edl.push(`${num()}  AX       V     C        ${tc(it.start)} ${tc(it.start + it.dur)} ${rec}`, `* FROM CLIP NAME: ${name}`, "");
      }
    }
    await fs.writeFile(path.join(stage, "timeline.edl"), edl.join("\r\n"));

    // Production log: models/providers from the latest successful generation job per shot.
    await onProgress(40, "Writing production log");
    const jobs = await db.job.findMany({ where: { projectId, status: "SUCCEEDED", type: { in: ["IMAGE", "VIDEO", "MULTISHOT_VIDEO"] } }, orderBy: { updatedAt: "desc" } });
    const shotAssets = await db.asset.findMany({ where: { id: { in: shots.flatMap((s) => [s.imageAssetId, s.videoAssetId]).filter((x): x is string => !!x) } } });
    const assetById = new Map(shotAssets.map((a) => [a.id, a]));
    const inputOf = (j?: Job) => (j?.input && typeof j.input === "object" && !Array.isArray(j.input) ? (j.input as Record<string, unknown>) : {});
    const forShot = (shotId: string, types: string[]) =>
      jobs.find((j) => types.includes(j.type) && (j.shotId === shotId || (Array.isArray(inputOf(j).shotIds) && (inputOf(j).shotIds as unknown[]).includes(shotId))));
    const refCount = (input: Record<string, unknown>) => Object.entries(input).reduce((n, [k, v]) => n + (/ref/i.test(k) && Array.isArray(v) ? v.length : 0), 0);
    const clipsByShot = new Map<string, typeof video>();
    for (const c of video) if (c.shotId) clipsByShot.set(c.shotId, [...(clipsByShot.get(c.shotId) ?? []), c]);

    const rows = shots.map((s) => {
      const ij = forShot(s.id, ["IMAGE"]), vj = forShot(s.id, ["VIDEO", "MULTISHOT_VIDEO"]);
      const onTimeline = clipsByShot.get(s.id) ?? [];
      const im = metaOf(s.imageAssetId ? assetById.get(s.imageAssetId) : null), vm = metaOf(s.videoAssetId ? assetById.get(s.videoAssetId) : onTimeline[0]?.asset);
      const uploaded = onTimeline.length ? onTimeline.every((c) => metaOf(c.asset).uploaded === true) : vm.uploaded === true;
      return {
        shot: s.order + 1,
        scene: s.scene ? `${s.scene.index + 1}. ${s.scene.heading}` : "",
        title: s.title,
        durationSec: +(onTimeline.length ? onTimeline.reduce((n, c) => n + clipLen(c), 0) : s.durationSec).toFixed(3),
        onTimeline: onTimeline.length > 0,
        imageModel: str(inputOf(ij).model) ?? str(im.model) ?? s.imageModel,
        imageProvider: ij?.provider ?? str(im.provider),
        videoModel: str(inputOf(vj).model) ?? str(vm.model) ?? s.videoModel,
        videoProvider: vj?.provider ?? str(vm.provider),
        prompt: s.prompt || str(vm.prompt) || str(im.prompt) || "",
        referenceCount: Math.max(refCount(inputOf(ij)), refCount(inputOf(vj)), typeof im.refs === "number" ? im.refs : 0),
        aiGenerated: !uploaded,
      };
    });
    const runtime = pos / fps;
    const aiSec = video.filter((c) => metaOf(c.asset).uploaded !== true).reduce((n, c) => n + clipLen(c), 0);
    const allSec = video.reduce((n, c) => n + clipLen(c), 0);
    const tool = (model: unknown, provider: unknown) => (model || provider ? `${model ?? "auto"}${provider ? ` (${provider})` : ""}` : null);
    const tools = new Set<string>();
    for (const r of rows) for (const t of [tool(r.imageModel, r.imageProvider), tool(r.videoModel, r.videoProvider)]) if (t && (r.onTimeline || !video.length)) tools.add(t);
    for (const c of audio) {
      const t = tool(metaOf(c.asset).model, metaOf(c.asset).provider);
      if (t) tools.add(`${t} [${c.track.toLowerCase()}]`);
    }
    const totals = {
      title: project.title,
      runtimeSec: +runtime.toFixed(3),
      runtime: tc(pos),
      fps,
      shots: rows.length,
      shotsOnTimeline: rows.filter((r) => r.onTimeline).length,
      aiGeneratedPercentByDuration: allSec ? +((aiSec / allSec) * 100).toFixed(1) : 0,
      toolsUsed: [...tools].sort(),
      generatedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(stage, "production_log.json"), JSON.stringify({ totals, shots: rows }, null, 2));
    const cols = Object.keys(rows[0] ?? { shot: 0 }) as (keyof (typeof rows)[number])[];
    const lines = [cols.join(","), ...rows.map((r) => cols.map((k) => csv(r[k])).join(","))];
    lines.push("", "# totals", ...Object.entries(totals).map(([k, v]) => `${csv(k)},${csv(Array.isArray(v) ? v.join("; ") : v)}`));
    await fs.writeFile(path.join(stage, "production_log.csv"), lines.join("\n") + "\n");

    // Download script (always) + README.
    const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
    const sh = [
      "#!/bin/sh",
      `# Downloads the media referenced by timeline.fcpxml / timeline.edl into ./media`,
      "set -e",
      `APP_URL="\${APP_URL:-${appUrl}}"`,
      'cd "$(dirname "$0")"',
      "mkdir -p media",
      ...[...media.values()].map((m) => `[ -s "media/${m.name}" ] || curl -fL --retry 3 -o "media/${m.name}" "$APP_URL/api/files/${m.asset.storageKey!.split("/").map(encodeURIComponent).join("/")}"`),
      `echo "Downloaded ${media.size} files into media/"`,
    ];
    await fs.writeFile(path.join(stage, "download_media.sh"), sh.join("\n") + "\n", { mode: 0o755 });
    const totalSize = [...probes.values()].reduce((n, p) => n + p.size, 0);
    const bundle = opts.includeMedia !== false && local && totalSize < MEDIA_LIMIT;
    const readme = `${project.title} - edit package
Exported by Krish Studio on ${new Date().toISOString().slice(0, 10)} - ${tc(pos)} at ${fps} fps, ${clipItems.length} video clips, ${audio.length} audio clips.

1. Unzip this package and keep timeline.fcpxml next to the media/ folder.
   ${bundle ? "The media/ folder is included." : "Media was too large to bundle: run ./download_media.sh (set APP_URL if the studio is not at the default address) to fill media/."}
2. DaVinci Resolve: File > Import > Timeline... and pick timeline.fcpxml (video, voice/music/sfx lanes, dissolves, scene markers).
   Premiere Pro: File > Import, pick timeline.edl (video track and dissolves; add the media/ audio files by hand),
   or open timeline.fcpxml in Resolve / Final Cut Pro and send it to Premiere from there.
3. If clips show as offline, relink them to the media/ folder (Resolve: right-click > Relink Clips; Premiere: Link Media).
4. Scene headings are timeline markers; voice / music / sfx sit on audio lanes 1 / 2 / 3. production_log.csv lists the
   model, provider and prompt for every shot (AI disclosure for festivals and distributors).
`;
    await fs.writeFile(path.join(stage, "README.txt"), readme);

    if (bundle) {
      await onProgress(55, "Adding media");
      for (const m of media.values()) await fs.symlink(await localPath(m.asset.storageKey!), path.join(stage, "media", m.name));
    }

    await onProgress(70, "Zipping package");
    const zipFile = path.join(dir, "package.zip");
    if (!(await zipCli(stage, zipFile))) await zipStore(stage, zipFile);

    await onProgress(95, "Saving package");
    const key = newKey(projectId, "exports", "application/zip", "package.zip");
    const stored = await storeFile(key, zipFile, "application/zip");
    const asset = await db.asset.create({
      data: { projectId, kind: "DOCUMENT", role: "EXPORT_PACKAGE", name: `${project.title} - edit package.zip`, storageKey: stored.key, url: stored.url, mimeType: "application/zip", durationSec: runtime, meta: { clips: clipItems.length, audioClips: audio.length, mediaIncluded: bundle, mediaBytes: totalSize } },
    });
    return { assetId: asset.id, url: asset.url };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Duration and whether the file has an audio stream. */
function probe(file: string): Promise<{ duration: number | null; audio: boolean }> {
  return new Promise((resolve) => {
    const p = spawn(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => resolve({ duration: null, audio: false }));
    p.on("close", () => {
      try {
        const j = JSON.parse(out);
        const d = parseFloat(j.format?.duration);
        resolve({ duration: Number.isFinite(d) ? d : null, audio: (j.streams ?? []).some((s: { codec_type: string }) => s.codec_type === "audio") });
      } catch {
        resolve({ duration: null, audio: false });
      }
    });
  });
}

/** Zips with the system `zip` (following symlinks, storing already-compressed media). Resolves false if unavailable. */
function zipCli(dir: string, out: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const p = spawn("zip", ["-q", "-r", "-X", "-n", ".mp4:.mov:.webm:.mp3:.m4a:.ogg:.png:.jpg:.jpeg:.webp", out, "."], { cwd: dir });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", () => resolve(false));
    p.on("close", (code) => (code === 0 ? resolve(true) : reject(new Error(`zip exited ${code}: ${err.slice(-400)}`))));
  });
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer) {
  const native = (zlib as unknown as { crc32?: (b: Buffer) => number }).crc32;
  if (native) return native(buf) >>> 0;
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal STORE-method zip writer (no compression, no zip64: fine below the 2 GB media limit). */
async function zipStore(dir: string, out: string) {
  const files: string[] = [];
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(dir);
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const fh = await fs.open(out, "w");
  const central: Buffer[] = [];
  let offset = 0;
  try {
    for (const f of files) {
      const data = await fs.readFile(f);
      const name = Buffer.from(path.relative(dir, f).split(path.sep).join("/"));
      const crc = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(dosTime, 10);
      local.writeUInt16LE(dosDate, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      await fh.write(Buffer.concat([local, name]));
      await fh.write(data);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(0x0314, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0x0800, 8);
      cd.writeUInt16LE(dosTime, 12);
      cd.writeUInt16LE(dosDate, 14);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(data.length, 20);
      cd.writeUInt32LE(data.length, 24);
      cd.writeUInt16LE(name.length, 28);
      cd.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      cd.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([cd, name]));
      offset += local.length + name.length + data.length;
    }
    const cdBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(cdBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    await fh.write(Buffer.concat([cdBuf, end]));
  } finally {
    await fh.close();
  }
}

import path from "path";
import { promises as fs } from "fs";
import type { AssetKind, AssetRole } from "@prisma/client";
import { db } from "@/lib/db";
import { fail, ok, route, type Params } from "@/lib/api";
import { publish } from "@/lib/events";
import { ffmpeg, probeDuration, tmpDir } from "@/lib/ffmpeg";
import { localPath, newKey, putFile } from "@/lib/storage";
import { splitGrid } from "@/lib/media";
import type { StyleLock } from "@/lib/prompt-builder";

export const maxDuration = 300;

const ROLES: AssetRole[] = [
  "MASK", "CHARACTER_REF", "STYLE_REF", "MOODBOARD", "VIDEO_REF", "SHOT_IMAGE", "SHOT_VIDEO", "VOICEOVER", "MUSIC", "SFX",
  "CHARACTER_SHEET", "WARDROBE_REF", "ELEMENT_REF", "CONTACT_SHEET", "MOTION_REF", "AUDIO_REF",
];
const ANGLES = ["front", "three_quarter", "side", "back", "full_body"];

function kindOf(mime: string): AssetKind {
  if (mime.startsWith("image/")) return "IMAGE";
  if (mime.startsWith("video/")) return "VIDEO";
  if (mime.startsWith("audio/")) return "AUDIO";
  return "DOCUMENT";
}

/**
 * Multipart upload: files[], role, characterId?, elementId?, angle?, look?, shotId?, lockStyle?, cols?, rows?
 * Contact sheets / turnarounds (role CONTACT_SHEET or CHARACTER_SHEET with cols/rows) are cut into tiles:
 * a character's sheet becomes angle references, a set's sheet becomes set references, a scene's sheet becomes shot frames (shotIds[]).
 * A motion reference uploaded for a shot is attached to that shot.
 * Style/moodboard images are added to the project style lock automatically.
 * Reference videos get a keyframe extracted as a style image so they can steer generations.
 */
export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const form = await req.formData();
  const role = String(form.get("role") || "STYLE_REF") as AssetRole;
  if (!ROLES.includes(role)) return fail("Bad role");
  const characterId = (form.get("characterId") as string) || null;
  const elementId = (form.get("elementId") as string) || null;
  const shotId = (form.get("shotId") as string) || null;
  const look = (form.get("look") as string) || null;
  const cols = Number(form.get("cols")) || 0;
  const rows = Number(form.get("rows")) || 0;
  const sheetShotIds = form.getAll("shotIds").map(String);
  const angles = form.getAll("angle").map(String);
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (!files.length) return fail("No files");

  const created = [];
  for (const [i, file] of files.entries()) {
    const mime = file.type || "application/octet-stream";
    const buf = Buffer.from(await file.arrayBuffer());
    const key = newKey(id, role.toLowerCase(), mime, file.name);
    const stored = await putFile(key, buf, mime);
    const kind = kindOf(mime);
    const durationSec = kind === "VIDEO" || kind === "AUDIO" ? await probeDuration(await localPath(key)) : null;
    const asset = await db.asset.create({
      data: {
        projectId: id, kind, role, name: role === "WARDROBE_REF" && look ? look : file.name, storageKey: stored.key, url: stored.url, mimeType: mime,
        characterId, elementId, shotId: role === "MOTION_REF" || role === "AUDIO_REF" ? shotId : role === "CONTACT_SHEET" ? null : shotId,
        angle: angles[i] || angles[0] || null, durationSec, meta: { uploaded: true, ...(look ? { look } : {}) },
      },
    });
    created.push(asset);
    // "Use my own song": the track goes on the music lane from 0 and sets the film's length.
    if (role === "MUSIC" && form.get("song") === "true" && kind === "AUDIO") {
      const old = await db.asset.findMany({ where: { projectId: id, role: "MUSIC", meta: { path: ["song"], equals: true } }, select: { id: true } });
      await db.timelineClip.deleteMany({ where: { projectId: id, track: "MUSIC", assetId: { in: old.map((o) => o.id) } } });
      await db.asset.update({ where: { id: asset.id }, data: { meta: { uploaded: true, song: true } } });
      const len = durationSec ?? 0;
      if (len > 0) {
        await db.timelineClip.create({ data: { projectId: id, track: "MUSIC", assetId: asset.id, start: 0, inPoint: 0, outPoint: len, volume: 1 } });
        await db.project.update({ where: { id }, data: { targetRuntimeSec: Math.round(len) } });
      }
      publish(id, { type: "refresh", scope: "project" });
    }
    if (role === "MOTION_REF" && shotId) await db.shot.update({ where: { id: shotId }, data: { motionRefAssetId: asset.id } });
    if (role === "CHARACTER_SHEET" && characterId) await db.character.update({ where: { id: characterId }, data: { sheetAssetId: asset.id } });

    // Cut a grid into tiles.
    if (kind === "IMAGE" && cols * rows > 1 && (role === "CONTACT_SHEET" || role === "CHARACTER_SHEET")) {
      const tiles = await splitGrid(stored.key, cols, rows);
      for (const [t, buf] of tiles.entries()) {
        const tk = await putFile(newKey(id, "tiles", "image/png"), buf, "image/png");
        const base = { projectId: id, kind: "IMAGE" as const, storageKey: tk.key, url: tk.url, mimeType: "image/png", meta: { fromSheet: asset.id, uploaded: true } };
        if (characterId) {
          created.push(await db.asset.create({ data: { ...base, role: "CHARACTER_REF", characterId, angle: angles[t] || ANGLES[t] || null } }));
        } else if (elementId) {
          created.push(await db.asset.create({ data: { ...base, role: "ELEMENT_REF", elementId, name: `${file.name} ${t + 1}` } }));
        } else if (sheetShotIds[t]) {
          const frame = await db.asset.create({ data: { ...base, role: "SHOT_IMAGE", shotId: sheetShotIds[t] } });
          await db.shot.update({ where: { id: sheetShotIds[t] }, data: { imageAssetId: frame.id, imageStatus: "DONE" } });
          created.push(frame);
        }
      }
    }

    if (kind === "VIDEO" && (role === "VIDEO_REF" || role === "STYLE_REF" || role === "MOODBOARD")) {
      try {
        const dir = await tmpDir();
        const out = path.join(dir, "k.jpg");
        await ffmpeg(["-ss", String(Math.max(0, (durationSec ?? 2) / 2)), "-i", await localPath(key), "-frames:v", "1", "-q:v", "3", out]);
        const kf = await putFile(newKey(id, "style_ref", "image/jpeg"), await fs.readFile(out), "image/jpeg");
        const still = await db.asset.create({
          data: { projectId: id, kind: "IMAGE", role: "STYLE_REF", name: `${file.name} (keyframe)`, storageKey: kf.key, url: kf.url, mimeType: "image/jpeg", meta: { fromVideo: asset.id } },
        });
        created.push(still);
        await fs.rm(dir, { recursive: true, force: true });
      } catch (e) {
        console.warn("keyframe extraction failed", (e as Error).message);
      }
    }
  }

  // New style images (and style videos, for models that take video references) join the global style lock.
  const styleImgs = created.filter((a) => (a.kind === "IMAGE" || (a.kind === "VIDEO" && a.role === "STYLE_REF")) && (a.role === "STYLE_REF" || a.role === "MOODBOARD"));
  if (styleImgs.length && form.get("lockStyle") !== "false") {
    const p = await db.project.findUniqueOrThrow({ where: { id } });
    const lock = (p.styleLock as StyleLock) || {};
    const refs = [...new Set([...(lock.referenceAssetIds ?? []), ...styleImgs.map((a) => a.id)])];
    await db.project.update({ where: { id }, data: { styleLock: { ...lock, referenceAssetIds: refs, enabled: lock.enabled ?? true } } });
  }

  publish(id, { type: "refresh", scope: characterId || elementId ? "characters" : sheetShotIds.length ? "shots" : "assets" });
  if (styleImgs.length) publish(id, { type: "refresh", scope: "project" });
  return ok(created, 201);
});

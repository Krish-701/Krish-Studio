import path from "path";
import { promises as fs } from "fs";
import type { AssetKind, AssetRole } from "@prisma/client";
import { db } from "@/lib/db";
import { fail, ok, route, type Params } from "@/lib/api";
import { publish } from "@/lib/events";
import { ffmpeg, probeDuration, tmpDir } from "@/lib/ffmpeg";
import { localPath, newKey, putFile } from "@/lib/storage";
import type { StyleLock } from "@/lib/prompt-builder";

export const maxDuration = 300;

const ROLES: AssetRole[] = ["MASK", "CHARACTER_REF", "STYLE_REF", "MOODBOARD", "VIDEO_REF", "SHOT_IMAGE", "SHOT_VIDEO", "VOICEOVER", "MUSIC", "SFX"];

function kindOf(mime: string): AssetKind {
  if (mime.startsWith("image/")) return "IMAGE";
  if (mime.startsWith("video/")) return "VIDEO";
  if (mime.startsWith("audio/")) return "AUDIO";
  return "DOCUMENT";
}

/**
 * Multipart upload: files[], role, characterId?, angle?, shotId?, lockStyle?
 * Style/moodboard images are added to the project style lock automatically.
 * Reference videos get a keyframe extracted as a style image so they can steer generations.
 */
export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const form = await req.formData();
  const role = String(form.get("role") || "STYLE_REF") as AssetRole;
  if (!ROLES.includes(role)) return fail("Bad role");
  const characterId = (form.get("characterId") as string) || null;
  const shotId = (form.get("shotId") as string) || null;
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
      data: { projectId: id, kind, role, name: file.name, storageKey: stored.key, url: stored.url, mimeType: mime, characterId, shotId, angle: angles[i] || angles[0] || null, durationSec },
    });
    created.push(asset);

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

  // New style images join the global style lock.
  const styleImgs = created.filter((a) => a.kind === "IMAGE" && (a.role === "STYLE_REF" || a.role === "MOODBOARD"));
  if (styleImgs.length && form.get("lockStyle") !== "false") {
    const p = await db.project.findUniqueOrThrow({ where: { id } });
    const lock = (p.styleLock as StyleLock) || {};
    const refs = [...new Set([...(lock.referenceAssetIds ?? []), ...styleImgs.map((a) => a.id)])];
    await db.project.update({ where: { id }, data: { styleLock: { ...lock, referenceAssetIds: refs, enabled: lock.enabled ?? true } } });
  }

  publish(id, { type: "refresh", scope: characterId ? "characters" : "assets" });
  if (styleImgs.length) publish(id, { type: "refresh", scope: "project" });
  return ok(created, 201);
});

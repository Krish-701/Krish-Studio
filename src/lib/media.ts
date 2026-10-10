import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import type { Asset } from "@prisma/client";
import { db } from "./db";
import { ffmpeg, tmpDir } from "./ffmpeg";
import { localPath, newKey, putFile } from "./storage";
import type { RefImage } from "./generation/types";

/** Asset → provider reference. */
export function toRef(a: Asset, label: string, extra: Partial<RefImage> = {}): RefImage {
  const media = a.kind === "VIDEO" ? "video" : a.kind === "AUDIO" ? "audio" : "image";
  return { assetId: a.id, key: a.storageKey, url: a.url, mime: a.mimeType, providerRef: a.providerRef, type: "image", media, label, ...extra };
}

/**
 * Last frame of a clip, used to start the next shot when continuity is "continuous".
 * Cached on the video asset (meta.lastFrameAssetId).
 */
export async function lastFrameAsset(video: Asset): Promise<Asset | null> {
  const meta = (video.meta as Record<string, unknown>) ?? {};
  if (typeof meta.lastFrameAssetId === "string") {
    const hit = await db.asset.findUnique({ where: { id: meta.lastFrameAssetId } });
    if (hit) return hit;
  }
  if (!video.storageKey) return null;
  const dir = await tmpDir();
  try {
    const out = path.join(dir, "last.png");
    await ffmpeg(["-sseof", "-0.15", "-i", await localPath(video.storageKey), "-frames:v", "1", "-update", "1", out]);
    const key = newKey(video.projectId, "frames", "image/png");
    const stored = await putFile(key, await fs.readFile(out), "image/png");
    const asset = await db.asset.create({
      data: { projectId: video.projectId, kind: "IMAGE", role: "SHOT_IMAGE", name: "Last frame", storageKey: stored.key, url: stored.url, mimeType: "image/png", meta: { lastFrameOf: video.id } },
    });
    await db.asset.update({ where: { id: video.id }, data: { meta: { ...meta, lastFrameAssetId: asset.id } } });
    return asset;
  } catch (e) {
    console.warn("[media] last frame extraction failed:", (e as Error).message);
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** A swatch image of the palette's colours, for models that accept a colour (or style) reference. Cached by palette. */
export async function paletteAsset(projectId: string, colors: string[]): Promise<Asset | null> {
  const hex = colors.map((c) => c.trim()).filter((c) => /^#?[0-9a-f]{6}$/i.test(c)).map((c) => (c.startsWith("#") ? c : `#${c}`));
  if (!hex.length) return null;
  const hash = createHash("sha1").update(hex.join(",")).digest("hex").slice(0, 12);
  const existing = await db.asset.findFirst({ where: { projectId, role: "COLOR_PALETTE", name: `palette-${hash}` } });
  if (existing) return existing;
  const dir = await tmpDir();
  try {
    const w = Math.floor(1024 / hex.length);
    const inputs = hex.flatMap((c) => ["-f", "lavfi", "-i", `color=c=${c.replace("#", "0x")}:s=${w}x512`]);
    const out = path.join(dir, "palette.png");
    const filter = hex.length > 1 ? `${hex.map((_, i) => `[${i}:v]`).join("")}hstack=inputs=${hex.length}` : "null";
    await ffmpeg([...inputs, "-filter_complex", filter, "-frames:v", "1", out]);
    const stored = await putFile(newKey(projectId, "palette", "image/png"), await fs.readFile(out), "image/png");
    return db.asset.create({
      data: { projectId, kind: "IMAGE", role: "COLOR_PALETTE", name: `palette-${hash}`, storageKey: stored.key, url: stored.url, mimeType: "image/png", meta: { colors: hex } },
    });
  } catch (e) {
    console.warn("[media] palette swatch failed:", (e as Error).message);
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Cuts a grid image (contact sheet, turnaround sheet) into cols × rows tiles, trimming a small gutter.
 * Returns PNG buffers in reading order.
 */
export async function splitGrid(key: string, cols: number, rows: number): Promise<Buffer[]> {
  const dir = await tmpDir();
  try {
    const src = await localPath(key);
    const tiles: Buffer[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const out = path.join(dir, `t${r}_${c}.png`);
        // 1.5% inset on every side drops grid lines / gutters.
        const crop = `crop=iw/${cols}*0.97:ih/${rows}*0.97:iw/${cols}*${c}+iw/${cols}*0.015:ih/${rows}*${r}+ih/${rows}*0.015`;
        await ffmpeg(["-i", src, "-vf", crop, "-frames:v", "1", out]);
        tiles.push(await fs.readFile(out));
      }
    }
    return tiles;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Grid size for n frames on a contact sheet (max 3×3 per sheet). */
export function gridFor(n: number): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n <= 2) return { cols: 2, rows: 1 };
  if (n <= 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  return { cols: 3, rows: 3 };
}

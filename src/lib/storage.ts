import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Storage abstraction: local disk (served by /api/files) or S3 / Cloudflare R2.
 */
export interface StoredFile {
  key: string;
  url: string;
}

const LOCAL_ROOT = path.resolve(process.env.STORAGE_DIR || path.join(process.cwd(), "storage"));
const driver = (process.env.STORAGE_DRIVER || "local").toLowerCase();

let s3: S3Client | null = null;
function s3c() {
  if (!s3) {
    s3 = new S3Client({
      region: process.env.S3_REGION || "auto",
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: !!process.env.S3_ENDPOINT,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
      },
    });
  }
  return s3;
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

export function extFor(mime: string, fallbackName?: string) {
  if (EXT[mime]) return EXT[mime];
  const m = fallbackName?.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "bin";
}

export function mimeFor(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const found = Object.entries(EXT).find(([, e]) => e === ext);
  return found ? found[0] : "application/octet-stream";
}

export function newKey(projectId: string, folder: string, mime: string, name?: string) {
  return `${projectId}/${folder}/${randomUUID()}.${extFor(mime, name)}`;
}

export function publicUrl(key: string) {
  if (driver === "s3" && process.env.S3_PUBLIC_URL) {
    return `${process.env.S3_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
  }
  return `/api/files/${key}`;
}

/** Absolute URL that an external service (e.g. Magnific) can fetch. */
export async function externalUrl(key: string) {
  if (driver === "s3") {
    if (process.env.S3_PUBLIC_URL) return publicUrl(key);
    return getSignedUrl(s3c(), new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key }), {
      expiresIn: 3600,
    });
  }
  const base = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
  return `${base}/api/files/${key}`;
}

export async function putFile(key: string, data: Buffer, mime: string): Promise<StoredFile> {
  if (driver === "s3") {
    await s3c().send(
      new PutObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key, Body: data, ContentType: mime }),
    );
  } else {
    const full = path.join(LOCAL_ROOT, key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
  }
  return { key, url: publicUrl(key) };
}

export async function getFile(key: string): Promise<Buffer> {
  if (driver === "s3") {
    const res = await s3c().send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
  const full = path.join(LOCAL_ROOT, key);
  if (!full.startsWith(LOCAL_ROOT)) throw new Error("bad key");
  return fs.readFile(full);
}

/** Path on local disk (downloading from S3 to a temp file if needed) — used by ffmpeg. */
export async function localPath(key: string): Promise<string> {
  if (driver !== "s3") return path.join(LOCAL_ROOT, key);
  const tmp = path.join(LOCAL_ROOT, ".cache", key);
  try {
    await fs.access(tmp);
  } catch {
    await fs.mkdir(path.dirname(tmp), { recursive: true });
    await fs.writeFile(tmp, await getFile(key));
  }
  return tmp;
}

export async function storeFromUrl(projectId: string, folder: string, url: string, fallbackMime?: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const mime = (res.headers.get("content-type") || fallbackMime || "application/octet-stream").split(";")[0];
  const buf = Buffer.from(await res.arrayBuffer());
  const key = newKey(projectId, folder, mime, new URL(url).pathname);
  const stored = await putFile(key, buf, mime);
  return { ...stored, mime, size: buf.length };
}

export const storageDriver = driver;
export const localRoot = LOCAL_ROOT;

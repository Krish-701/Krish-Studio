import { probeDuration } from "@/lib/ffmpeg";
import type { GenResult } from "@/lib/generation/types";
import { localPath, newKey, putFile, storeFromUrl } from "@/lib/storage";

/** Saves a generation result (buffer or remote URL) into storage. */
export async function persist(projectId: string, folder: string, res: GenResult) {
  if (res.buffer) {
    const key = newKey(projectId, folder, res.mime);
    const stored = await putFile(key, res.buffer, res.mime);
    return { ...stored, mime: res.mime };
  }
  if (!res.url) throw new Error("Generation returned no media");
  return storeFromUrl(projectId, folder, res.url, res.mime);
}

export async function durationOf(key: string, fallback?: number) {
  return (await probeDuration(await localPath(key))) ?? fallback ?? 4;
}

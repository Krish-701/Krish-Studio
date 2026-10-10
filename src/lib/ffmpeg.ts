import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

const BIN = process.env.FFMPEG_PATH || "ffmpeg";
const PROBE = process.env.FFPROBE_PATH || "ffprobe";

/** Runs ffmpeg. onProgress receives seconds of output processed. */
export function ffmpeg(args: string[], onProgress?: (sec: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(BIN, ["-hide_banner", "-y", ...args]);
    let err = "";
    p.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      err = (err + s).slice(-4000);
      const m = s.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (m && onProgress) onProgress(+m[1] * 3600 + +m[2] * 60 + +m[3]);
    });
    p.on("error", (e) => reject(new Error(`ffmpeg not available: ${e.message}`)));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-800)}`))));
  });
}

export function probeDuration(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(PROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => resolve(null));
    p.on("close", () => {
      const n = parseFloat(out.trim());
      resolve(Number.isFinite(n) ? n : null);
    });
  });
}

export async function tmpDir() {
  const d = path.join(os.tmpdir(), "film-studio", randomUUID());
  await fs.mkdir(d, { recursive: true });
  return d;
}

export function dims(aspect: string, long = 1280): [number, number] {
  const [a, b] = aspect.split(":").map(Number);
  if (!a || !b) return [long, Math.round((long * 9) / 16 / 2) * 2];
  if (a >= b) return [long, Math.round((long * b) / a / 2) * 2];
  return [Math.round((long * a) / b / 2) * 2, long];
}

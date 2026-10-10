/**
 * Model catalog shown in the UI. Slugs match Magnific's `images_models_list` / `video_models_list`.
 * Settings → "Refresh models" can pull the live catalog; this is the offline default.
 */
export interface ModelInfo {
  slug: string;
  name: string;
  note?: string;
  refs?: boolean;
  durations?: number[];
  resolutions?: string[];
  defaultResolution?: string;
  aspectRatios?: string[];
  startFrame?: boolean;
  sound?: boolean;
  cameraMotion?: boolean;
}

export const IMAGE_MODELS: ModelInfo[] = [
  { slug: "auto", name: "Auto (best for prompt)", refs: true },
  { slug: "seedream-5-pro", name: "Seedream 5 Pro", note: "Default · strongest character consistency", refs: true },
  { slug: "imagen-nano-banana-2", name: "Nano Banana Pro", note: "Max fidelity to references", refs: true },
  { slug: "imagen-nano-banana-2-lite", name: "Nano Banana 2 Lite", note: "Fast drafts", refs: true },
  { slug: "gpt-2-mini", name: "GPT Image 2.5", note: "Text & layout", refs: true },
  { slug: "recraft-v4-1", name: "Recraft V4.1", note: "Pure text-to-image", refs: false },
  { slug: "magnific-one", name: "Magnific One", note: "Aesthetic finals", refs: true },
];

const SEEDANCE_MOTION = true;

export const VIDEO_MODELS: ModelInfo[] = [
  { slug: "auto", name: "Auto", refs: true, durations: [5, 10], startFrame: true },
  {
    slug: "bytedance-seedance-pro-2.5", name: "Seedance 2.5", note: "Best overall · native audio · up to 30s",
    refs: true, durations: Array.from({ length: 27 }, (_, i) => i + 4), resolutions: ["1080p", "720p", "480p"], defaultResolution: "720p",
    aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], startFrame: true, sound: true, cameraMotion: SEEDANCE_MOTION,
  },
  {
    slug: "bytedance-seedance-pro-2.0", name: "Seedance 2.0", note: "4K · references",
    refs: true, durations: Array.from({ length: 12 }, (_, i) => i + 4), resolutions: ["4K", "1080p", "720p", "480p"], defaultResolution: "720p",
    aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], startFrame: true, sound: true, cameraMotion: SEEDANCE_MOTION,
  },
  {
    slug: "bytedance-seedance-fast-2.0", name: "Seedance 2.0 Fast", note: "Fast drafts",
    refs: true, durations: Array.from({ length: 12 }, (_, i) => i + 4), resolutions: ["720p", "480p"], defaultResolution: "720p",
    aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], startFrame: true, sound: true, cameraMotion: SEEDANCE_MOTION,
  },
  {
    slug: "kling-25", name: "Kling 2.5", note: "Best value · start/end frames",
    refs: false, durations: [5, 10], resolutions: ["1080p", "720p"], defaultResolution: "1080p",
    aspectRatios: ["1:1", "16:9", "9:16"], startFrame: true,
  },
  {
    slug: "minimax-video-3_0-max", name: "MiniMax H3 Max", note: "Reference-guided drafts",
    refs: true, durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolutions: ["768p", "480p"], defaultResolution: "768p",
    aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], startFrame: true,
  },
  {
    slug: "minimax-video-3_0-max-turbo", name: "MiniMax H3 Turbo", note: "Cheapest",
    refs: false, durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolutions: ["768p", "480p"], defaultResolution: "768p",
    aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], startFrame: true,
  },
];

export const CAMERA_MOTIONS = [
  "static", "pushIn", "pullOut", "panLeft", "panRight", "tiltUp", "tiltDown", "truckLeft", "truckRight",
  "dollyIn", "craneUp", "craneDown", "orbitLeft", "orbitRight", "handheld", "whipPan", "zoomIn", "zoomOut", "fpvDrone", "overhead",
];

export const SHOT_TYPES = ["EXTREME_WIDE", "WIDE", "FULL", "MEDIUM", "MEDIUM_CLOSE", "CLOSE_UP", "EXTREME_CLOSE_UP", "OVER_SHOULDER", "POV", "INSERT", "AERIAL"];

export const ASPECT_RATIOS = ["16:9", "21:9", "9:16", "1:1", "4:3", "3:4", "2:3", "3:2"];

export function videoModel(slug?: string | null) {
  return VIDEO_MODELS.find((m) => m.slug === slug);
}

export function snap<T extends number>(value: number, allowed?: T[]): number {
  if (!allowed?.length) return value;
  return allowed.reduce((best, v) => (Math.abs(v - value) < Math.abs(best - value) ? v : best), allowed[0]);
}

export function snapAspect(aspect: string, allowed?: string[]) {
  if (!allowed?.length || allowed.includes(aspect)) return aspect;
  const [a, b] = aspect.split(":").map(Number);
  const r = a / b;
  return allowed.reduce((best, cur) => {
    const [x, y] = cur.split(":").map(Number);
    const [bx, by] = best.split(":").map(Number);
    return Math.abs(x / y - r) < Math.abs(bx / by - r) ? cur : best;
  }, allowed[0]);
}

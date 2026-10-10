/**
 * Model catalog. Slugs and capabilities match Magnific's `images_models_list` / `video_models_list`
 * (captured 2026-10). Settings → "Sync models" pulls the live catalog through MCP and stores it,
 * so new models and new reference types show up without a code change; this list is the offline default.
 */

/** Reference kinds a model can take. `locations` is image-only (Magnific library sets). */
export type RefType = "image" | "video" | "audio" | "character" | "product" | "style" | "color" | "effect" | "locations";

export interface ModelInfo {
  slug: string;
  name: string;
  note?: string;
  kind: "image" | "video";
  /** Max references per type (missing = not supported). */
  refLimits: Partial<Record<RefType, number>>;
  /** Total references the call accepts. */
  maxRefs?: number;
  durations?: number[];
  resolutions?: string[];
  defaultResolution?: string;
  aspectRatios?: string[];
  startFrame?: boolean;
  endFrame?: boolean;
  /** References and start/end keyframes can't be combined (Seedance 2.x). */
  keyframesExclusive?: boolean;
  sound?: boolean;
  /** Several shots in one generation (Seedance multi_prompt). */
  multishot?: { limit: number; min: number; max: number };
  cameraMotions?: string[];
  promptMax?: number;
  tier?: "sota" | "recommended";
  expectedSec?: number;
  private?: boolean;
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const IMG_REFS = (types: RefType[], n = 12) => Object.fromEntries(types.map((t) => [t, n])) as Partial<Record<RefType, number>>;

const SEEDANCE_CAMERA = [
  "static", "pushIn", "pullOut", "panLeft", "panRight", "tiltUp", "tiltDown", "truckLeft", "truckRight", "pedestalUp", "pedestalDown",
  "zoomIn", "zoomOut", "superDollyIn", "superDollyOut", "crashZoomIn", "doubleDolly", "jibUp", "jibDown", "craneUp", "craneDown",
  "craneOverTheHead", "orbitLeft", "orbitRight", "360Orbit", "fisheye", "overhead", "objectPov", "whipPan", "dutchAngle", "dirtyLens",
  "lensFlare", "focusChange", "lowShutter", "fpvDrone", "handheld", "headTracking", "snorricam", "scenicShot",
];
const WIDE_ASPECTS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const SEEDANCE_REFS: Partial<Record<RefType, number>> = { image: 9, video: 3, audio: 3, character: 9, product: 1, style: 1, color: 1, effect: 1 };

export const IMAGE_MODELS: ModelInfo[] = [
  { slug: "auto", name: "Auto (best for prompt)", kind: "image", refLimits: IMG_REFS(["image", "style", "character", "product"]), maxRefs: 12 },
  { slug: "seedream-5-pro", name: "Seedream 5 Pro", note: "Default · strongest character consistency", kind: "image", refLimits: IMG_REFS(["image", "style", "character", "product"]), maxRefs: 12, tier: "sota", expectedSec: 55 },
  { slug: "magnific-one", name: "Magnific One", note: "Aesthetic finals · sets & characters", kind: "image", refLimits: IMG_REFS(["image", "style", "character", "product", "locations"]), maxRefs: 12, expectedSec: 90 },
  { slug: "imagen-nano-banana-2", name: "Nano Banana Pro", note: "Max fidelity to references", kind: "image", refLimits: IMG_REFS(["image", "style", "character", "product"]), maxRefs: 12, tier: "recommended", expectedSec: 39 },
  { slug: "imagen-nano-banana-2-flash", name: "Nano Banana 2", note: "Good refs · fast", kind: "image", refLimits: IMG_REFS(["image", "style", "character", "product"]), maxRefs: 12, expectedSec: 40 },
  { slug: "imagen-nano-banana-2-lite", name: "Nano Banana 2 Lite", note: "Cheap drafts", kind: "image", refLimits: IMG_REFS(["image", "style", "character", "product"]), maxRefs: 12, tier: "recommended", expectedSec: 9 },
  { slug: "flux-2", name: "Flux.2 Pro", note: "Multi-reference", kind: "image", refLimits: IMG_REFS(["image", "style", "character", "product"]), maxRefs: 12, expectedSec: 20 },
  { slug: "flux-kontext-high", name: "Flux.1 Kontext Max", note: "Edits that keep identity", kind: "image", refLimits: IMG_REFS(["image", "style", "character", "product"]), maxRefs: 12, expectedSec: 11 },
  { slug: "gpt-2-mini", name: "GPT Image 2.5", note: "Text & layout, contact sheets", kind: "image", refLimits: IMG_REFS(["image", "style", "character", "product"]), maxRefs: 12, expectedSec: 32 },
  { slug: "recraft-v4-1", name: "Recraft V4.1", note: "Pure text-to-image", kind: "image", refLimits: { style: 1 }, maxRefs: 1, expectedSec: 11 },
];

export const VIDEO_MODELS: ModelInfo[] = [
  { slug: "auto", name: "Auto", kind: "video", refLimits: { image: 3, character: 3 }, durations: [5, 10], startFrame: true },
  {
    slug: "bytedance-seedance-pro-2.5", name: "Seedance 2.5", note: "Best overall · up to 30s · 30 image + 10 video + 10 audio refs · multi-shot",
    kind: "video", refLimits: { image: 30, video: 10, audio: 10, character: 30, product: 1, style: 1, color: 1, effect: 1 },
    durations: range(4, 30), resolutions: ["1080p", "720p", "480p"], defaultResolution: "720p", aspectRatios: WIDE_ASPECTS,
    startFrame: true, endFrame: true, keyframesExclusive: true, sound: true, multishot: { limit: 6, min: 1, max: 12 },
    cameraMotions: SEEDANCE_CAMERA, promptMax: 10000, tier: "sota", expectedSec: 300,
  },
  {
    slug: "bytedance-seedance-pro-2.0", name: "Seedance 2.0", note: "4K · 9 image + 3 video + 3 audio refs · multi-shot",
    kind: "video", refLimits: SEEDANCE_REFS, durations: range(4, 15), resolutions: ["4K", "1080p", "720p", "480p"], defaultResolution: "720p",
    aspectRatios: WIDE_ASPECTS, startFrame: true, endFrame: true, keyframesExclusive: true, sound: true, multishot: { limit: 6, min: 1, max: 12 },
    cameraMotions: SEEDANCE_CAMERA, tier: "recommended", expectedSec: 240,
  },
  {
    slug: "bytedance-seedance-fast-2.0", name: "Seedance 2.0 Fast", note: "Fast drafts with references",
    kind: "video", refLimits: SEEDANCE_REFS, durations: range(4, 15), resolutions: ["720p", "480p"], defaultResolution: "720p",
    aspectRatios: WIDE_ASPECTS, startFrame: true, endFrame: true, keyframesExclusive: true, sound: true, multishot: { limit: 6, min: 1, max: 12 },
    cameraMotions: SEEDANCE_CAMERA, tier: "recommended", expectedSec: 120,
  },
  {
    slug: "kling-30", name: "Kling 3.0", note: "4K · character/product refs · start+end frames",
    kind: "video", refLimits: { image: 3, character: 3, product: 3 }, durations: range(3, 15), resolutions: ["720p", "1080p", "4K"], defaultResolution: "1080p",
    aspectRatios: ["16:9", "9:16", "1:1"], startFrame: true, endFrame: true, sound: true, expectedSec: 240,
  },
  {
    slug: "kling-omni3", name: "Kling 3.0 Omni", note: "Image + video + character refs",
    kind: "video", refLimits: { image: 4, video: 1, character: 4, product: 4 }, durations: range(3, 15), resolutions: ["720p", "1080p", "4K"], defaultResolution: "1080p",
    aspectRatios: ["16:9", "9:16", "1:1"], startFrame: true, endFrame: true, sound: true, expectedSec: 240,
  },
  {
    slug: "kling-motion-control-30", name: "Kling 3.0 Motion Control", note: "Copies motion from a reference video",
    kind: "video", refLimits: { video: 1 }, durations: range(3, 15), resolutions: ["720p", "1080p"], defaultResolution: "1080p", startFrame: true, expectedSec: 240,
  },
  {
    slug: "kling-25", name: "Kling 2.5", note: "Best value · start/end frames",
    kind: "video", refLimits: {}, durations: [5, 10], resolutions: ["1080p", "720p"], defaultResolution: "1080p", aspectRatios: ["1:1", "16:9", "9:16"],
    startFrame: true, endFrame: true, tier: "recommended", expectedSec: 180,
  },
  {
    slug: "google-veo3_1", name: "Google Veo 3.1", note: "4K · 3 image refs · native audio",
    kind: "video", refLimits: { image: 3 }, durations: [4, 6, 8], resolutions: ["4K", "1080p", "720p"], defaultResolution: "1080p", aspectRatios: ["16:9", "9:16"],
    startFrame: true, endFrame: true, sound: true, expectedSec: 300,
  },
  {
    slug: "gemini-omni-1_1", name: "Gemini Omni 1.1", note: "8 image + 3 video refs",
    kind: "video", refLimits: { image: 8, video: 3 }, durations: range(3, 10), resolutions: ["720p", "1080p", "4K"], defaultResolution: "1080p", aspectRatios: ["16:9", "9:16"],
    startFrame: true, endFrame: true, expectedSec: 300,
  },
  {
    slug: "wan-2-7", name: "Wan 2.7", note: "Image, video, style & colour refs",
    kind: "video", refLimits: { image: 5, video: 5, character: 5, product: 5, style: 1, color: 1, effect: 1 }, durations: range(2, 15), resolutions: ["1080p", "720p"], defaultResolution: "1080p",
    startFrame: true, endFrame: true, sound: true, expectedSec: 240,
  },
  {
    slug: "minimax-video-3_0-max", name: "MiniMax H3 Max", note: "9 image + 3 video + 3 audio refs",
    kind: "video", refLimits: { image: 9, character: 9, video: 3, audio: 3 }, durations: range(5, 15), resolutions: ["768p", "480p"], defaultResolution: "768p",
    aspectRatios: WIDE_ASPECTS, startFrame: true, endFrame: true, tier: "recommended", expectedSec: 180,
  },
  {
    slug: "grok-imagine-video-1-5", name: "Grok Imagine 1.5", note: "7 image refs · up to 15s",
    kind: "video", refLimits: { image: 7 }, durations: range(1, 15), resolutions: ["480p", "720p", "1080p"], defaultResolution: "720p", startFrame: true, expectedSec: 120,
  },
  {
    slug: "happy-horse-1-1", name: "Happy Horse 1.1", note: "9 image refs · native audio",
    kind: "video", refLimits: { image: 9 }, durations: range(3, 15), resolutions: ["1080p", "720p"], defaultResolution: "1080p", startFrame: true, sound: true, expectedSec: 180,
  },
];

export const CAMERA_MOTIONS = SEEDANCE_CAMERA;

/** Motion templates: one-click motion prompts (the camera move is set too when the model supports it). */
export const MOTION_TEMPLATES: { name: string; camera: string; prompt: string }[] = [
  { name: "Slow push-in", camera: "pushIn", prompt: "Slow, steady push-in toward the subject; the moment tightens." },
  { name: "Pull back reveal", camera: "pullOut", prompt: "Slow pull back revealing the wider space around the subject." },
  { name: "Handheld follow", camera: "handheld", prompt: "Handheld camera following the subject, subtle natural shake." },
  { name: "Orbit", camera: "orbitRight", prompt: "Camera orbits slowly around the subject, keeping them centred." },
  { name: "Crane up", camera: "craneUp", prompt: "Camera cranes up and away, ending on a high wide view." },
  { name: "Locked-off", camera: "static", prompt: "Locked-off tripod shot; only the subject moves." },
  { name: "Whip pan", camera: "whipPan", prompt: "Fast whip pan to the next subject with motion blur." },
  { name: "Drone fly-over", camera: "fpvDrone", prompt: "Smooth aerial drone glide over the landscape." },
  { name: "Rack focus", camera: "focusChange", prompt: "Focus racks from the foreground to the background subject." },
  { name: "Dolly zoom", camera: "doubleDolly", prompt: "Dolly zoom: background stretches while the subject stays the same size." },
];

/** Colour presets (shown on shots and in the look picker). Each adds grading language to prompts. */
export const COLOR_PRESETS: { id: string; name: string; prompt: string; swatch: string[] }[] = [
  { id: "natural", name: "Natural Light", prompt: "natural daylight colour, true-to-life skin tones, soft contrast", swatch: ["#d8c3a5", "#8e8d8a", "#e98074"] },
  { id: "moody", name: "Moody Dark", prompt: "low-key lighting, deep shadows, desaturated cool tones", swatch: ["#1b263b", "#415a77", "#778da9"] },
  { id: "vibrant", name: "Vibrant Pop", prompt: "saturated vivid colours, punchy contrast, bright highlights", swatch: ["#ff006e", "#fb5607", "#ffbe0b"] },
  { id: "vintage", name: "Vintage Film", prompt: "1970s film stock, warm faded colours, soft grain, lifted blacks", swatch: ["#cb997e", "#ddbea9", "#6b705c"] },
  { id: "teal-orange", name: "Teal & Orange", prompt: "teal shadows and orange skin tones, blockbuster grade", swatch: ["#0b7a75", "#f4a261", "#264653"] },
  { id: "bleach", name: "Bleach Bypass", prompt: "bleach bypass look, high contrast, low saturation, silvery highlights", swatch: ["#adb5bd", "#495057", "#212529"] },
  { id: "golden", name: "Golden Hour", prompt: "golden hour sunlight, warm amber glow, long soft shadows", swatch: ["#f9c74f", "#f8961e", "#f3722c"] },
  { id: "noir", name: "Noir", prompt: "black and white noir, hard light, strong silhouettes", swatch: ["#000000", "#6c757d", "#f8f9fa"] },
];

/** Film looks for the "Your look" step: name, one-line description and the style lock they set. */
export const LOOKS: { id: string; name: string; desc: string; prompt: string; color?: string }[] = [
  { id: "cinematic", name: "Cinematic", desc: "Photorealistic with dramatic film lighting", prompt: "cinematic photorealistic film still, anamorphic lens, dramatic film-grade lighting and colour", color: "teal-orange" },
  { id: "realistic", name: "Realistic", desc: "Photoreal, natural lighting", prompt: "photorealistic, natural lighting, documentary realism, 35mm lens", color: "natural" },
  { id: "anime", name: "Anime", desc: "Cel-shaded Japanese animation", prompt: "high-quality anime, cel-shaded, painterly backgrounds, expressive characters" },
  { id: "cartoon", name: "Cartoon", desc: "Bold outlines, flat colours", prompt: "stylised 2D cartoon, bold clean outlines, flat vibrant colours", color: "vibrant" },
  { id: "pixar", name: "3D Render", desc: "Feature-animation 3D", prompt: "feature-film 3D animation, soft global illumination, stylised characters" },
  { id: "sketch", name: "Sketch", desc: "Pencil storyboard drawing", prompt: "pencil storyboard sketch, hatching, loose expressive lines, monochrome" },
  { id: "watercolor", name: "Watercolor", desc: "Soft painterly washes", prompt: "watercolour illustration, soft bleeding washes, paper texture" },
  { id: "comic", name: "Comic Book", desc: "Halftone dots, inked panels", prompt: "comic book art, inked lines, halftone shading, dynamic composition", color: "vibrant" },
  { id: "noir", name: "Film Noir", desc: "High-contrast black and white", prompt: "1940s film noir, black and white, hard shadows, venetian-blind light", color: "noir" },
  { id: "fantasy", name: "Fantasy Art", desc: "Painterly, ethereal, epic", prompt: "epic fantasy concept art, painterly, ethereal light, grand scale" },
  { id: "gothic", name: "Gothic Fantasy", desc: "Dark, ornate, desaturated", prompt: "gothic dark fantasy, ornate architecture, candlelight, desaturated", color: "moody" },
  { id: "pastel", name: "Symmetric Pastel", desc: "Centred frames, pastel palette", prompt: "symmetrical centred compositions, pastel colour palette, whimsical production design" },
  { id: "neon", name: "Neon Noir", desc: "Rain, neon, night city", prompt: "neon noir, rain-soaked night streets, magenta and cyan neon, reflections", color: "moody" },
  { id: "bleach", name: "Bleach Bypass", desc: "Gritty, silvery, high contrast", prompt: "gritty war-film look, bleach bypass, handheld realism", color: "bleach" },
  { id: "indie", name: "Golden Hour Indie", desc: "Warm, intimate, sun-flared", prompt: "indie film, golden hour, lens flares, intimate handheld framing", color: "golden" },
  { id: "commercial", name: "Clean Commercial", desc: "Bright, crisp, polished", prompt: "clean high-end commercial look, bright soft key light, crisp detail", color: "natural" },
];

/**
 * Film formats for the new-film wizard. Average shot length sets the shot count for a runtime
 * (a 3-hour feature at ~5s per shot is ~2,000 shots; a 30s spot is ~10).
 */
export const FORMATS: { id: string; name: string; desc: string; runtime: number; min: number; max: number; avgShot: number; acts: number }[] = [
  { id: "spot", name: "Ad / Spot", desc: "A quick, punchy piece built around one idea.", runtime: 30, min: 15, max: 90, avgShot: 2.5, acts: 1 },
  { id: "short", name: "Short Film", desc: "A cinematic short with a three-act shape.", runtime: 60, min: 30, max: 900, avgShot: 4.5, acts: 3 },
  { id: "action", name: "Action Film", desc: "A set piece with clear geography, cut on the action.", runtime: 120, min: 30, max: 1200, avgShot: 3, acts: 3 },
  { id: "music_video", name: "Music Video", desc: "Cut to your song, performance and story intercut.", runtime: 180, min: 30, max: 600, avgShot: 3, acts: 1 },
  { id: "episode", name: "Series Episode", desc: "A 20–60 minute episode with A and B plots.", runtime: 1800, min: 600, max: 3600, avgShot: 4.5, acts: 4 },
  { id: "feature", name: "Feature Film", desc: "A full movie, 75 minutes to 3 hours, in acts and sequences.", runtime: 5400, min: 1800, max: 10800, avgShot: 5, acts: 3 },
];

export function estimateShots(format: string, runtimeSec: number) {
  const f = FORMATS.find((x) => x.id === format) ?? FORMATS[1];
  return Math.max(3, Math.round(runtimeSec / f.avgShot));
}

export const SHOT_TYPES = ["EXTREME_WIDE", "WIDE", "FULL", "MEDIUM", "MEDIUM_CLOSE", "CLOSE_UP", "EXTREME_CLOSE_UP", "OVER_SHOULDER", "POV", "INSERT", "AERIAL"];

export const ASPECT_RATIOS = ["16:9", "21:9", "9:16", "1:1", "4:3", "3:4", "2:3", "3:2"];

// ---- live catalog (synced from Magnific) ----

let live: { image: ModelInfo[]; video: ModelInfo[] } | null = null;

/** Installs a synced catalog (called with AppSettings.modelCatalog). Built-in entries fill gaps. */
export function setLiveCatalog(cat: { image?: ModelInfo[]; video?: ModelInfo[] } | null) {
  live = cat ? { image: cat.image ?? [], video: cat.video ?? [] } : null;
}

function merged(builtin: ModelInfo[], synced?: ModelInfo[]) {
  if (!synced?.length) return builtin;
  const bySlug = new Map(synced.map((m) => [m.slug, m]));
  // Keep our notes on known models; take the live capabilities.
  const known = builtin.map((b) => (bySlug.has(b.slug) ? { ...bySlug.get(b.slug)!, note: b.note, name: b.name } : b));
  const extra = synced.filter((m) => !builtin.some((b) => b.slug === m.slug) && !m.private);
  return [...known, ...extra];
}

export function imageModels() {
  return merged(IMAGE_MODELS, live?.image);
}

export function videoModels() {
  return merged(VIDEO_MODELS, live?.video);
}

export function videoModel(slug?: string | null) {
  return videoModels().find((m) => m.slug === slug);
}

export function imageModel(slug?: string | null) {
  return imageModels().find((m) => m.slug === (slug || "auto")) ?? IMAGE_MODELS[0];
}

/** Converts one entry of Magnific's video_models_list / images_models_list into a ModelInfo. */
export function fromMagnific(entry: Record<string, any>, kind: "image" | "video"): ModelInfo { // eslint-disable-line @typescript-eslint/no-explicit-any
  const refLimits: Partial<Record<RefType, number>> = {};
  const refs = Array.isArray(entry.references) ? entry.references : [];
  for (const r of refs) if (r && r.allowed !== false && r.type) refLimits[r.type as RefType] = Number(r.limit) || (kind === "image" ? 12 : 1);
  for (const t of (entry.referenceTypes ?? []) as RefType[]) refLimits[t] ??= kind === "image" ? 12 : 1;
  const exclusive = refs.some((r: { prohibitedWith?: string[] }) => (r.prohibitedWith ?? []).some((p) => String(p).startsWith("keyframes")));
  const ms = entry.multishot?.allowed ? { limit: Number(entry.multishot.limit) || 6, min: Number(entry.multishot.durationRange?.min) || 1, max: Number(entry.multishot.durationRange?.max) || 12 } : undefined;
  const res = (entry.resolutions ?? []).map(String).filter((r: string) => !/draft/i.test(r));
  return {
    slug: String(entry.slug),
    name: String(entry.name ?? entry.slug),
    kind,
    refLimits: entry.supportsReferences === false ? {} : refLimits,
    maxRefs: kind === "image" ? 12 : undefined,
    durations: entry.durations?.map(Number),
    resolutions: res.length ? res : undefined,
    defaultResolution: res.includes("720p") ? "720p" : res[0],
    aspectRatios: entry.aspectRatios?.map(String).filter((a: string) => a !== "auto"),
    startFrame: entry.supportsStartFrame ?? !!entry.keyframes?.start,
    endFrame: entry.supportsEndFrame ?? !!entry.keyframes?.end,
    keyframesExclusive: exclusive || undefined,
    sound: entry.supportsSoundEffects ?? entry.soundEffects?.allowed,
    multishot: ms,
    cameraMotions: entry.cameraMotion?.values?.map(String),
    promptMax: entry.prompt?.maxLength ? Number(entry.prompt.maxLength) : undefined,
    tier: entry.agentRecommendation?.tier,
    expectedSec: entry.expectedGenerationTime ? Number(entry.expectedGenerationTime) : undefined,
    private: !!entry.private,
  };
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

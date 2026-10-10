import type { Asset, Character, Element, Project, Scene, Shot } from "@prisma/client";
import { db } from "./db";
import { COLOR_PRESETS, DEFAULT_IMAGE_MODEL, DEFAULT_IMAGE_VARIANT, DEFAULT_VIDEO_MODEL, imageModel, videoModel, VIDEO_MODELS, type ModelInfo } from "./generation/catalog";
import type { ImageRequest, RefImage, VideoRequest } from "./generation/types";
import { lastFrameAsset, paletteAsset, toRef } from "./media";
import { planReferences, type Candidate, type RefPlan } from "./references";

/**
 * Character consistency + style lock live here. Every generation request is assembled from:
 *   shot prompt → framing → cast (descriptions, @handles, wardrobe look) → film set and props → style lock / colour
 * and a reference plan (lib/references.ts) that picks which images, videos and audio go with it for the chosen model.
 */
export interface StyleLock {
  enabled?: boolean;
  prompt?: string;
  mood?: string;
  tone?: string;
  palette?: string[];
  lighting?: string;
  camera?: string;
  negative?: string;
  referenceAssetIds?: string[];
  /** Notes distilled from pasted website links by the Mood & Tone agent. */
  linkNotes?: string;
  /** Look id from the look picker. */
  look?: string;
  /** Default colour preset for every shot. */
  colorPreset?: string;
}

const ANGLE_PRIORITY = ["front", "three_quarter", "side", "full_body", "back"];

export type CharWithRefs = Character & { references: Asset[] };
type ElementWithRefs = Element & { references: Asset[] };
type FullShot = Shot & { characters: { characterId: string; look: string | null }[]; elements: { elementId: string }[]; scene: Scene | null; project: Project };

export function effectiveStyle(project: Project, shot: Shot): StyleLock {
  const lock = (project.styleLock as StyleLock) || {};
  const override = shot.styleOverride as StyleLock | null;
  if (override && Object.keys(override).length) return { ...lock, ...override, enabled: true };
  return lock;
}

export function styleText(style: StyleLock, colorPreset?: string | null) {
  const preset = COLOR_PRESETS.find((p) => p.id === (colorPreset || style.colorPreset));
  if (!style.enabled && !preset) return "";
  const parts = [
    style.enabled && style.prompt && `Visual style: ${style.prompt}`,
    style.enabled && style.mood && `Mood: ${style.mood}`,
    style.enabled && style.tone && `Tone: ${style.tone}`,
    style.enabled && style.lighting && `Lighting: ${style.lighting}`,
    style.enabled && style.camera && `Camera/lens: ${style.camera}`,
    style.enabled && style.palette?.length && `Colour palette: ${style.palette.join(", ")}`,
    preset && `Colour grade: ${preset.prompt}`,
    style.enabled && style.linkNotes && `Style reference notes: ${style.linkNotes}`,
  ].filter(Boolean);
  return parts.join(". ");
}

const SHOT_WORDS: Record<string, string> = {
  EXTREME_WIDE: "extreme wide establishing shot",
  WIDE: "wide shot",
  FULL: "full shot",
  MEDIUM: "medium shot",
  MEDIUM_CLOSE: "medium close-up",
  CLOSE_UP: "close-up",
  EXTREME_CLOSE_UP: "extreme close-up",
  OVER_SHOULDER: "over-the-shoulder shot",
  POV: "point-of-view shot",
  INSERT: "insert detail shot",
  AERIAL: "aerial shot",
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A character's reference images for a shot: the wardrobe look first, then angles in priority order, then the turnaround sheet. */
export function characterRefList(c: CharWithRefs, look?: string | null): RefImage[] {
  const imgs = c.references.filter((a) => a.kind === "IMAGE");
  const lookRefs = look ? imgs.filter((a) => a.role === "WARDROBE_REF" && (a.meta as Record<string, unknown>)?.look === look) : [];
  const angles = imgs
    .filter((a) => a.role === "CHARACTER_REF")
    .sort((a, b) => ANGLE_PRIORITY.indexOf(a.angle ?? "z") - ANGLE_PRIORITY.indexOf(b.angle ?? "z"));
  const sheet = imgs.filter((a) => a.role === "CHARACTER_SHEET" || a.id === c.sheetAssetId);
  const lib = c.providerRef ? { libraryId: c.providerRef } : {};
  return [...lookRefs, ...angles, ...sheet]
    .filter((a, i, arr) => arr.findIndex((x) => x.id === a.id) === i)
    .map((a) => toRef(a, `${c.name}${a.role === "WARDROBE_REF" ? ` (${look})` : a.angle ? ` (${a.angle.replace("_", " ")})` : a.role === "CHARACTER_SHEET" ? " (turnaround)" : ""}`, { mention: c.handle ? `@${c.handle}` : undefined, ...lib }));
}

/** Kept for callers that only need a flat character list (agents, checks). */
export function characterRefs(chars: CharWithRefs[], perChar = 3, max = 10): RefImage[] {
  return chars.flatMap((c) => characterRefList(c).slice(0, perChar)).slice(0, max);
}

/** Characters for a shot: explicitly linked ones + locked characters named (or @mentioned) in the text. */
export async function shotCharacters(shot: Shot & { characters: { characterId: string }[] }): Promise<CharWithRefs[]> {
  const all = await db.character.findMany({ where: { projectId: shot.projectId }, include: { references: { where: { role: { in: ["CHARACTER_REF", "CHARACTER_SHEET", "WARDROBE_REF"] } } } } });
  const linked = new Set(shot.characters.map((c) => c.characterId));
  const text = `${shot.prompt} ${shot.description} ${shot.motionPrompt ?? ""} ${shot.speaker ?? ""}`.toLowerCase();
  return all.filter(
    (c) =>
      linked.has(c.id) ||
      (c.locked && new RegExp(`\\b${esc(c.name.toLowerCase())}\\b`).test(text)) ||
      (c.handle && text.includes(`@${c.handle.toLowerCase()}`)),
  );
}

/** The scene's film set plus props linked to the shot or named in it. */
export async function shotElements(shot: FullShot): Promise<{ location: ElementWithRefs | null; props: ElementWithRefs[] }> {
  const all = await db.element.findMany({ where: { projectId: shot.projectId }, include: { references: { where: { kind: "IMAGE" } } } });
  const text = `${shot.prompt} ${shot.description}`.toLowerCase();
  const linked = new Set(shot.elements.map((e) => e.elementId));
  const named = (e: Element) => e.locked && (new RegExp(`\\b${esc(e.name.toLowerCase())}\\b`).test(text) || (e.handle && text.includes(`@${e.handle.toLowerCase()}`)));
  const location =
    all.find((e) => e.kind === "location" && e.id === shot.scene?.locationId) ??
    all.find((e) => e.kind === "location" && linked.has(e.id)) ??
    all.find((e) => e.kind === "location" && named(e)) ??
    null;
  const props = all.filter((e) => e.kind === "prop" && (linked.has(e.id) || named(e)));
  return { location, props };
}

async function loadShot(shotId: string): Promise<FullShot> {
  return db.shot.findUniqueOrThrow({ where: { id: shotId }, include: { characters: true, elements: true, scene: true, project: true } });
}

/** Everything a shot could reference, as planner candidates. */
async function candidatesFor(shot: FullShot, kind: "image" | "video") {
  const chars = await shotCharacters(shot);
  const { location, props } = await shotElements(shot);
  const style = effectiveStyle(shot.project, shot);
  const looks = new Map(shot.characters.map((c) => [c.characterId, c.look]));
  const cands: Candidate[] = [];

  if (kind === "video") {
    const frame = shot.imageAssetId ? await db.asset.findUnique({ where: { id: shot.imageAssetId } }) : null;
    if (frame) cands.push({ role: "frame", ref: toRef(frame, `Shot #${shot.order + 1} storyboard frame`) });
    const end = shot.endFrameAssetId ? await db.asset.findUnique({ where: { id: shot.endFrameAssetId } }) : null;
    if (end) cands.push({ role: "end_frame", ref: toRef(end, `Shot #${shot.order + 1} end frame`) });
    if (shot.continuity === "continuous") {
      const prev = await db.shot.findFirst({ where: { projectId: shot.projectId, order: { lt: shot.order } }, orderBy: { order: "desc" } });
      const prevVideo = prev?.videoAssetId ? await db.asset.findUnique({ where: { id: prev.videoAssetId } }) : null;
      const last = prevVideo ? await lastFrameAsset(prevVideo) : null;
      if (last) cands.push({ role: "previous", ref: toRef(last, `Last frame of shot #${prev!.order + 1}`) });
    }
  }

  for (const c of chars) {
    const refs = characterRefList(c, looks.get(c.id));
    for (const r of refs) cands.push({ role: /turnaround/.test(r.label ?? "") ? "sheet" : "character", ref: r, owner: c.id });
  }
  if (location?.locked !== false) for (const a of location?.references.slice(0, 3) ?? []) cands.push({ role: "location", ref: toRef(a, `${location!.name} (film set)`, { libraryId: location!.providerRef }), owner: location!.id });
  for (const p of props) for (const a of p.references.slice(0, 2)) cands.push({ role: "prop", ref: toRef(a, `${p.name} (prop)`, { libraryId: p.providerRef }), owner: p.id });

  if (style.enabled && style.referenceAssetIds?.length) {
    const assets = await db.asset.findMany({ where: { id: { in: style.referenceAssetIds } } });
    for (const a of assets) {
      if (a.kind === "IMAGE") cands.push({ role: "style", ref: toRef(a, `Style reference${a.name ? `: ${a.name}` : ""}`) });
      else if (a.kind === "VIDEO" && kind === "video") cands.push({ role: "style_video", ref: toRef(a, `Style video${a.name ? `: ${a.name}` : ""}`) });
    }
  }
  const palette = style.enabled && style.palette?.length ? await paletteAsset(shot.projectId, style.palette) : null;
  if (palette) cands.push({ role: "palette", ref: toRef(palette, `Colour palette ${style.palette!.join(" ")}`) });

  if (kind === "video") {
    const motion = shot.motionRefAssetId ? await db.asset.findUnique({ where: { id: shot.motionRefAssetId } }) : null;
    if (motion) cands.push({ role: "motion", ref: toRef(motion, "Motion reference") });
    const audio = await db.asset.findFirst({ where: { projectId: shot.projectId, role: "AUDIO_REF", OR: [{ shotId: shot.id }, { shotId: null }] }, orderBy: { createdAt: "desc" } });
    if (audio) cands.push({ role: "audio", ref: toRef(audio, "Audio reference (rhythm and mood)") });
  }
  return { cands, chars, location, props, style };
}

function castText(chars: CharWithRefs[], looks: Map<string, string | null>) {
  return chars
    .map((c) => {
      const look = looks.get(c.id);
      return `${c.handle ? `@${c.handle} ` : ""}${c.name}: ${c.description || "see reference images"}${look ? ` — wearing their "${look}" look` : ""}`;
    })
    .join("; ");
}

const finish = (parts: (string | number | false | null | undefined)[]) =>
  parts
    .filter(Boolean)
    .map((p) => String(p).trim().replace(/[.\s]+$/, "") + ".")
    .join("\n");

export async function buildImageRequest(shotId: string, opts: { model?: string | null } = {}): Promise<{ req: ImageRequest; characters: CharWithRefs[]; style: StyleLock; plan: RefPlan }> {
  const shot = await loadShot(shotId);
  const defaults = (shot.project.defaults as Record<string, string> | null) ?? {};
  const slug = opts.model || shot.imageModel || defaults.image || DEFAULT_IMAGE_MODEL;
  const model = imageModel(slug);
  const variant = slug === (defaults.image || DEFAULT_IMAGE_MODEL) ? defaults.imageVariant || (slug === DEFAULT_IMAGE_MODEL ? DEFAULT_IMAGE_VARIANT : undefined) : undefined;
  const { cands, chars, location, props, style } = await candidatesFor(shot, "image");
  const plan = planReferences(model, { kind: "image", candidates: cands });
  const looks = new Map(shot.characters.map((c) => [c.characterId, c.look]));

  const base = shot.prompt?.trim() || shot.description;
  const framing = [shot.shotType && SHOT_WORDS[shot.shotType], location ? `Set: ${location.name} — ${location.description}` : shot.scene?.heading && `Setting: ${shot.scene.heading}`].filter(Boolean).join(". ");
  const cast = castText(chars, looks);
  const prompt = finish([
    base,
    framing,
    cast && `Characters in frame — ${cast}`,
    props.length && `Props: ${props.map((p) => `${p.name} (${p.description || "as in reference"})`).join(", ")}`,
    styleText(style, shot.colorPreset),
    ...plan.promptNotes,
    "Cinematic film still, consistent with the rest of the film",
  ]);

  return {
    req: {
      prompt,
      negativePrompt: [shot.negativePrompt, style.enabled ? style.negative : null].filter(Boolean).join(", ") || undefined,
      aspectRatio: shot.project.aspectRatio,
      model: slug,
      variant,
      references: plan.refs,
      label: `${shot.scene?.heading ?? "SHOT"} · #${shot.order + 1}`,
    },
    characters: chars,
    style,
    plan,
  };
}

function videoText(shot: FullShot, chars: CharWithRefs[], style: StyleLock, plan: RefPlan, looks: Map<string, string | null>) {
  const action = shot.motionPrompt?.trim() ? `${shot.description || shot.prompt} ${shot.motionPrompt}` : shot.description || shot.prompt;
  const dialogue = shot.dialogue ? ` ${shot.speaker ?? "The character"} says: "${shot.dialogue}"` : "";
  const motion = shot.cameraMove && shot.cameraMove !== "static" ? `Camera: ${shot.cameraMove}` : "Camera: locked off";
  const cast = castText(chars, looks);
  return finish([
    `${action}${dialogue}`,
    motion,
    cast && `Cast — ${cast}`,
    chars.length && plan.mode !== "text" && `Keep ${chars.map((c) => c.name).join(", ")} identical to their references throughout`,
    styleText(style, shot.colorPreset),
    ...plan.promptNotes,
  ]);
}

export function resolveVideoModel(shot: Shot & { project: Project }, override?: string | null): ModelInfo {
  const slug = override || shot.videoModel || (shot.project.defaults as Record<string, string>)?.video || DEFAULT_VIDEO_MODEL;
  return videoModel(slug) ?? { ...VIDEO_MODELS[0], slug: slug || "auto" };
}

/**
 * mode: "i2v" (legacy) = frame, "t2v" = reference/text, or a Shot.refMode value. Defaults to the shot's refMode.
 */
export async function buildVideoRequest(shotId: string, mode?: string, opts: { model?: string | null } = {}): Promise<VideoRequest & { plan: RefPlan }> {
  const shot = await loadShot(shotId);
  const model = resolveVideoModel(shot, opts.model);
  const { cands, chars, style } = await candidatesFor(shot, "video");
  const want = mode === "i2v" ? "frame" : mode === "t2v" ? "reference" : mode || shot.refMode || "auto";
  const plan = planReferences(model, { kind: "video", mode: want, continuous: shot.continuity === "continuous", candidates: cands });
  const looks = new Map(shot.characters.map((c) => [c.characterId, c.look]));
  return {
    prompt: videoText(shot, chars, style, plan, looks),
    aspectRatio: shot.project.aspectRatio,
    model: model.slug === "auto" ? null : model.slug,
    durationSec: shot.durationSec,
    resolution: shot.project.resolution,
    startFrame: plan.start ?? null,
    endFrame: plan.end ?? null,
    references: plan.refs,
    cameraMotion: shot.cameraMove,
    withSound: shot.withSound,
    label: `${shot.scene?.heading ?? "SHOT"} · #${shot.order + 1}`,
    plan,
  };
}

/**
 * One multi-shot call for consecutive shots of a scene (Seedance multi_prompt, up to 6 shots).
 * References are the union for all shots, planned once.
 */
export async function buildMultishotRequest(shotIds: string[], opts: { model?: string | null } = {}): Promise<VideoRequest & { plan: RefPlan; shotIds: string[] }> {
  const shots = await Promise.all(shotIds.map(loadShot));
  shots.sort((a, b) => a.order - b.order);
  const model = resolveVideoModel(shots[0], opts.model);
  const ms = model.multishot ?? { limit: 6, min: 1, max: 12 };
  const use = shots.slice(0, ms.limit);
  const seen = new Set<string>();
  const cands: Candidate[] = [];
  const allChars: CharWithRefs[] = [];
  let style: StyleLock = {};
  for (const s of use) {
    const r = await candidatesFor(s, "video");
    style = r.style;
    for (const c of r.chars) if (!allChars.some((x) => x.id === c.id)) allChars.push(c);
    for (const c of r.cands) {
      // Storyboard frames of every shot become image references (composition per shot).
      const k = `${c.role}:${c.ref.assetId}`;
      if (!seen.has(k) && c.role !== "end_frame" && c.role !== "previous") {
        seen.add(k);
        cands.push(c);
      }
    }
  }
  const plan = planReferences(model, { kind: "video", mode: "reference", candidates: cands });
  const looks = new Map(use.flatMap((s) => s.characters.map((c) => [c.characterId, c.look] as const)));
  const multiPrompt = use.map((s) => {
    const dur = Math.min(ms.max, Math.max(ms.min, Math.round(s.durationSec)));
    const text = `${s.description || s.prompt}${s.motionPrompt ? ` ${s.motionPrompt}` : ""}${s.dialogue ? ` ${s.speaker ?? "The character"} says: "${s.dialogue}"` : ""}`;
    return { prompt: text.slice(0, 1500), durationSec: dur, cameraMotion: s.cameraMove };
  });
  const header = finish([
    `One continuous scene in ${multiPrompt.length} shots${use[0].scene ? ` — ${use[0].scene.heading}` : ""}`,
    castText(allChars, looks) && `Cast — ${castText(allChars, looks)}`,
    styleText(style, use[0].colorPreset),
    ...plan.promptNotes,
  ]);
  return {
    prompt: header,
    aspectRatio: use[0].project.aspectRatio,
    model: model.slug === "auto" ? null : model.slug,
    durationSec: multiPrompt.reduce((a, b) => a + b.durationSec, 0),
    resolution: use[0].project.resolution,
    references: plan.refs,
    withSound: use[0].withSound,
    multiPrompt: multiPrompt.map((m, i) => ({ ...m, prompt: i === 0 ? `${header}\n${m.prompt}` : m.prompt })),
    label: `${use[0].scene?.heading ?? "SCENE"} · shots #${use[0].order + 1}–${use[use.length - 1].order + 1}`,
    plan,
    shotIds: use.map((s) => s.id),
  };
}

/** Aspect ratio of a cols × rows grid of frames, snapped to what image models accept. */
export function gridAspect(aspect: string, cols: number, rows: number) {
  const [a, b] = aspect.split(":").map(Number);
  const r = (a * cols) / (b * rows);
  const options = ["21:9", "2:1", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16", "1:2"];
  return options.reduce((best, cur) => {
    const [x, y] = cur.split(":").map(Number);
    const [bx, by] = best.split(":").map(Number);
    return Math.abs(Math.log(x / y / r)) < Math.abs(Math.log(bx / by / r)) ? cur : best;
  }, "16:9");
}

/**
 * Contact sheet: one image holding a grid of a scene's storyboard frames. Drawing them together keeps
 * light, wardrobe and set identical across the scene; the grid is then cut into one frame per shot.
 */
export async function buildContactSheetRequest(shotIds: string[], cols: number, rows: number, opts: { model?: string | null } = {}): Promise<{ req: ImageRequest; plan: RefPlan }> {
  const shots = (await Promise.all(shotIds.map(loadShot))).sort((a, b) => a.order - b.order);
  const first = shots[0];
  const model = imageModel(opts.model || first.imageModel || (first.project.defaults as Record<string, string>)?.image || "auto");
  const seen = new Set<string>();
  const cands: Candidate[] = [];
  const allChars: CharWithRefs[] = [];
  let style: StyleLock = {};
  let setText = "";
  for (const s of shots) {
    const r = await candidatesFor(s, "image");
    style = r.style;
    if (r.location && !setText) setText = `Set: ${r.location.name} — ${r.location.description}`;
    for (const c of r.chars) if (!allChars.some((x) => x.id === c.id)) allChars.push(c);
    for (const c of r.cands) {
      const k = `${c.role}:${c.ref.assetId}`;
      if (!seen.has(k)) {
        seen.add(k);
        cands.push(c);
      }
    }
  }
  const plan = planReferences(model, { kind: "image", candidates: cands });
  const looks = new Map(shots.flatMap((s) => s.characters.map((c) => [c.characterId, c.look] as const)));
  const labels = shots.map((s) => `${s.shotType ? SHOT_WORDS[s.shotType] ?? s.shotType : "shot"}: ${s.prompt || s.description}`.slice(0, 400));
  const n = cols * rows;
  const prompt = finish([
    `A film contact sheet: a ${cols}×${rows} grid of ${n} storyboard frames from one continuous scene, thin black gutters between frames, no text or numbers`,
    `Every frame shows the same characters with identical faces, hair and wardrobe, on the same set with the same lighting and colour grade`,
    first.scene && `Scene: ${first.scene.heading}${first.scene.summary ? ` — ${first.scene.summary}` : ""}`,
    setText,
    castText(allChars, looks) && `Cast — ${castText(allChars, looks)}`,
    ...labels.map((l, i) => `Frame ${i + 1} (row ${Math.floor(i / cols) + 1}, column ${(i % cols) + 1}): ${l}`),
    n > labels.length && `Frames ${labels.length + 1}–${n}: extra coverage of the scene`,
    styleText(style, first.colorPreset),
    ...plan.promptNotes,
  ]);
  return {
    req: {
      prompt,
      aspectRatio: gridAspect(first.project.aspectRatio, cols, rows),
      model: model.slug,
      references: plan.refs,
      label: `${first.scene?.heading ?? "SCENE"} · contact sheet`,
      grid: { cols, rows, labels },
    },
    plan,
  };
}

import type { Asset, Character, Project, Shot } from "@prisma/client";
import { db } from "./db";
import type { ImageRequest, RefImage, VideoRequest } from "./generation/types";

/**
 * Character consistency + style lock live here. Every generation request is assembled from:
 *   shot prompt → shot framing → locked character descriptions + reference images → style lock (or per-shot override).
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
}

const ANGLE_PRIORITY = ["front", "three_quarter", "side", "full_body", "back"];

type CharWithRefs = Character & { references: Asset[] };

export function effectiveStyle(project: Project, shot: Shot): StyleLock {
  const lock = (project.styleLock as StyleLock) || {};
  const override = shot.styleOverride as StyleLock | null;
  if (override && Object.keys(override).length) return { ...lock, ...override, enabled: true };
  return lock;
}

export function styleText(style: StyleLock) {
  if (!style.enabled) return "";
  const parts = [
    style.prompt && `Visual style: ${style.prompt}`,
    style.mood && `Mood: ${style.mood}`,
    style.tone && `Tone: ${style.tone}`,
    style.lighting && `Lighting: ${style.lighting}`,
    style.camera && `Camera/lens: ${style.camera}`,
    style.palette?.length && `Colour palette: ${style.palette.join(", ")}`,
    style.linkNotes && `Style reference notes: ${style.linkNotes}`,
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

export function characterRefs(chars: CharWithRefs[], perChar = 3, max = 10): RefImage[] {
  const refs: RefImage[] = [];
  for (const c of chars) {
    const sorted = [...c.references]
      .filter((a) => a.kind === "IMAGE")
      .sort((a, b) => ANGLE_PRIORITY.indexOf(a.angle ?? "z") - ANGLE_PRIORITY.indexOf(b.angle ?? "z"));
    for (const a of sorted.slice(0, perChar)) {
      refs.push({ assetId: a.id, key: a.storageKey, url: a.url, mime: a.mimeType, providerRef: a.providerRef, type: "character", label: `${c.name}${a.angle ? ` (${a.angle})` : ""}` });
    }
  }
  return refs.slice(0, max);
}

/** Characters for a shot: explicitly linked ones + locked characters named in the text. */
export async function shotCharacters(shot: Shot & { characters: { characterId: string }[] }): Promise<CharWithRefs[]> {
  const all = await db.character.findMany({ where: { projectId: shot.projectId }, include: { references: { where: { role: "CHARACTER_REF" } } } });
  const linked = new Set(shot.characters.map((c) => c.characterId));
  const text = `${shot.prompt} ${shot.description} ${shot.speaker ?? ""}`.toLowerCase();
  return all.filter((c) => linked.has(c.id) || (c.locked && new RegExp(`\\b${c.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)));
}

export async function buildImageRequest(shotId: string): Promise<{ req: ImageRequest; characters: CharWithRefs[]; style: StyleLock }> {
  const shot = await db.shot.findUniqueOrThrow({ where: { id: shotId }, include: { characters: true, scene: true, project: true } });
  const chars = await shotCharacters(shot);
  const style = effectiveStyle(shot.project, shot);

  const base = shot.prompt?.trim() || shot.description;
  const framing = [shot.shotType && SHOT_WORDS[shot.shotType], shot.scene?.heading && `Setting: ${shot.scene.heading}`].filter(Boolean).join(". ");
  const charText = chars
    .map((c) => `${c.name}: ${c.description || "see reference images"}${c.references.length ? " — match the reference images exactly (same face, hair, build, wardrobe)" : ""}`)
    .join("; ");

  const prompt = [base, framing, charText && `Characters in frame — ${charText}`, styleText(style), "Cinematic film still, consistent with the rest of the film."]
    .filter(Boolean)
    .map((p) => String(p).trim().replace(/[.\s]+$/, "") + ".")
    .join("\n");

  const styleRefs: RefImage[] = [];
  if (style.enabled && style.referenceAssetIds?.length) {
    const assets = await db.asset.findMany({ where: { id: { in: style.referenceAssetIds }, kind: "IMAGE" } });
    for (const a of assets.slice(0, 2)) styleRefs.push({ assetId: a.id, key: a.storageKey, url: a.url, mime: a.mimeType, providerRef: a.providerRef, type: "style", label: a.name ?? "style" });
  }

  return {
    req: {
      prompt,
      negativePrompt: [shot.negativePrompt, style.enabled ? style.negative : null].filter(Boolean).join(", ") || undefined,
      aspectRatio: shot.project.aspectRatio,
      model: shot.imageModel || (shot.project.defaults as Record<string, string>)?.image || null,
      references: [...characterRefs(chars), ...styleRefs].slice(0, 12),
      label: `${shot.scene?.heading ?? "SHOT"} · #${shot.order + 1}`,
    },
    characters: chars,
    style,
  };
}

export async function buildVideoRequest(shotId: string, mode: "i2v" | "t2v" = "i2v"): Promise<VideoRequest> {
  const shot = await db.shot.findUniqueOrThrow({ where: { id: shotId }, include: { characters: true, scene: true, project: true } });
  const chars = await shotCharacters(shot);
  const style = effectiveStyle(shot.project, shot);
  const frame = shot.imageAssetId ? await db.asset.findUnique({ where: { id: shot.imageAssetId } }) : null;

  const motion = shot.cameraMove && shot.cameraMove !== "static" ? `Camera: ${shot.cameraMove}.` : "Camera: locked off.";
  const action = shot.description || shot.prompt;
  const dialogue = shot.dialogue ? ` ${shot.speaker ?? "The character"} says: "${shot.dialogue}"` : "";
  const prompt = [
    `${action}${dialogue}`,
    motion,
    chars.length ? `Keep ${chars.map((c) => c.name).join(", ")} identical to the reference / first frame throughout.` : "",
    styleText(style),
  ]
    .filter(Boolean)
    .join(" ");

  const useFrame = mode === "i2v" && frame;
  return {
    prompt,
    aspectRatio: shot.project.aspectRatio,
    model: shot.videoModel || (shot.project.defaults as Record<string, string>)?.video || null,
    durationSec: shot.durationSec,
    startFrame: useFrame ? { assetId: frame.id, key: frame.storageKey, url: frame.url, mime: frame.mimeType, providerRef: frame.providerRef, type: "image" } : null,
    references: useFrame ? [] : characterRefs(chars, 2, 9),
    cameraMotion: shot.cameraMove,
    withSound: !!(shot.project.defaults as Record<string, unknown>)?.videoSound,
    label: `${shot.scene?.heading ?? "SHOT"} · #${shot.order + 1}`,
  };
}

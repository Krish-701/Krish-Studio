/**
 * Asset library kinds. Characters live in the Character model; everything else is an Element:
 *   location    — film sets / backgrounds (2×2 set plates)
 *   environment — recurring atmospheres: weather, sky, sea, landscape, time of day (2×2 plates in different light)
 *   prop        — objects the story needs (product-style sheet)
 *   mood        — colour & mood board: palette, lighting, texture (one per film, or per act / sequence)
 * Safe to import from client components (no server imports).
 */
export const ELEMENT_KINDS = ["location", "environment", "prop", "mood"] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

export const KIND_LABEL: Record<ElementKind, string> = {
  location: "Background / set",
  environment: "Environment",
  prop: "Prop",
  mood: "Colour & mood",
};

/** Any loose kind string ("set", "background", "weather", "palette", …) → a library kind. Unknown → location. */
export function normalizeKind(k: unknown): ElementKind {
  const s = String(k ?? "").toLowerCase().trim();
  if ((ELEMENT_KINDS as readonly string[]).includes(s)) return s as ElementKind;
  if (/^(prop|product|object|item)s?$/.test(s)) return "prop";
  if (/^(env|environment|environments|weather|sky|atmosphere|landscape)$/.test(s)) return "environment";
  if (/^(mood|moodboard|mood_board|colou?r|palette|look|colou?r_mood)$/.test(s)) return "mood";
  return "location";
}

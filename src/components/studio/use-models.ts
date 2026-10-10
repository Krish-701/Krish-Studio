"use client";
import useSWR from "swr";
import { fetcher } from "@/lib/client";
import { COLOR_PRESETS, FORMATS, IMAGE_MODELS, LOOKS, MOTION_TEMPLATES, VIDEO_MODELS, type ModelInfo } from "@/lib/generation/catalog";

interface Catalog {
  image: ModelInfo[];
  video: ModelInfo[];
  synced: boolean;
  syncedAt: string | null;
  looks: typeof LOOKS;
  colorPresets: typeof COLOR_PRESETS;
  motionTemplates: typeof MOTION_TEMPLATES;
  formats: typeof FORMATS;
}

const FALLBACK: Catalog = { image: IMAGE_MODELS, video: VIDEO_MODELS, synced: false, syncedAt: null, looks: LOOKS, colorPresets: COLOR_PRESETS, motionTemplates: MOTION_TEMPLATES, formats: FORMATS };

/** Model catalog including models synced live from the provider (falls back to the built-in list). */
export function useModels() {
  const { data, mutate } = useSWR<Catalog>("/api/models", fetcher, { revalidateOnFocus: false, dedupingInterval: 60_000 });
  return { ...(data ?? FALLBACK), reload: mutate };
}

/** "image 9 · video 3 · audio 3" — what a model accepts as references. */
export function refSummary(m?: ModelInfo) {
  if (!m) return "";
  const parts = Object.entries(m.refLimits).map(([k, v]) => `${k} ${v}`);
  return parts.length ? parts.join(" · ") : "text and start frame only";
}

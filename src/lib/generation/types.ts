import type { Capability } from "../settings";

export interface RefImage {
  assetId?: string;
  /** Storage key (for local upload to the provider). */
  key?: string | null;
  url: string;
  mime?: string | null;
  /** Provider-side identifier, if already uploaded. */
  providerRef?: string | null;
  type: "character" | "style" | "image";
  label?: string;
}

export interface ImageRequest {
  prompt: string;
  negativePrompt?: string;
  aspectRatio: string;
  model?: string | null;
  references: RefImage[];
  seed?: number;
  /** Text overlay label used only by the offline preview renderer. */
  label?: string;
}

export interface VideoRequest {
  prompt: string;
  aspectRatio: string;
  model?: string | null;
  durationSec: number;
  startFrame?: RefImage | null;
  references?: RefImage[];
  cameraMotion?: string | null;
  withSound?: boolean;
  label?: string;
}

export interface TtsRequest {
  text: string;
  voiceId?: number | null;
  model?: string | null;
}

export interface AudioGenRequest {
  prompt: string;
  durationSec: number;
}

export interface UpscaleRequest {
  image: RefImage;
  scale: "2x" | "4x";
  prompt?: string;
}

export interface InpaintRequest {
  image: RefImage;
  mask: RefImage;
  prompt: string;
}

export interface GenResult {
  /** Remote URL to download, or a buffer already in memory. */
  url?: string;
  buffer?: Buffer;
  mime: string;
  providerRef?: string;
  durationSec?: number;
  meta?: Record<string, unknown>;
}

export interface GenContext {
  projectId: string;
  onProgress: (pct: number, step: string) => void | Promise<void>;
  /** Called after a reference is uploaded to a provider so it can be cached on the Asset row. */
  onRefUploaded?: (assetId: string, providerRef: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface GenerationProvider {
  id: string;
  name: string;
  supports(cap: Capability): boolean;
  /** Returns a reason string when the provider can't run right now (e.g. missing token). */
  unavailable?(): string | null;
  image?(req: ImageRequest, ctx: GenContext): Promise<GenResult>;
  video?(req: VideoRequest, ctx: GenContext): Promise<GenResult>;
  tts?(req: TtsRequest, ctx: GenContext): Promise<GenResult>;
  music?(req: AudioGenRequest, ctx: GenContext): Promise<GenResult>;
  sfx?(req: AudioGenRequest, ctx: GenContext): Promise<GenResult>;
  upscale?(req: UpscaleRequest, ctx: GenContext): Promise<GenResult>;
  inpaint?(req: InpaintRequest, ctx: GenContext): Promise<GenResult>;
}

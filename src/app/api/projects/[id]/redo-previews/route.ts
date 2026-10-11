import { db } from "@/lib/db";
import { ok, route, type Params } from "@/lib/api";
import { queueImages, queueVideos } from "@/lib/services";

/** Placeholder frames and clips from the offline preview renderer. */
async function previews(projectId: string) {
  const shots = await db.shot.findMany({ where: { projectId }, select: { id: true, imageAssetId: true, videoAssetId: true } });
  const ids = shots.flatMap((s) => [s.imageAssetId, s.videoAssetId]).filter((x): x is string => !!x);
  const assets = await db.asset.findMany({ where: { id: { in: ids } }, select: { id: true, meta: true } });
  const isPreview = new Set(assets.filter((a) => (a.meta as Record<string, unknown> | null)?.preview).map((a) => a.id));
  return {
    frames: shots.filter((s) => s.imageAssetId && isPreview.has(s.imageAssetId)).map((s) => s.id),
    clips: shots.filter((s) => s.videoAssetId && isPreview.has(s.videoAssetId)).map((s) => s.id),
  };
}

export const GET = route(async (_: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const p = await previews(id);
  return ok({ frames: p.frames.length, clips: p.clips.length });
});

/** Regenerates every placeholder frame (and then clip) with the real backend. */
export const POST = route(async (_: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const p = await previews(id);
  if (p.frames.length) await queueImages(id, p.frames);
  // Clips wait for their new frames (the VIDEO job uses the shot's current frame when it runs).
  if (p.clips.length) await queueVideos(id, p.clips);
  return ok({ frames: p.frames.length, clips: p.clips.length });
});

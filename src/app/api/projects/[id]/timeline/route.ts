import type { TrackType } from "@prisma/client";
import { db } from "@/lib/db";
import { ok, route, type Params } from "@/lib/api";
import { publish } from "@/lib/events";

interface ClipIn {
  id?: string;
  track: TrackType;
  lane?: number;
  assetId?: string | null;
  shotId?: string | null;
  label?: string | null;
  start: number;
  inPoint: number;
  outPoint: number;
  transition?: string;
  volume?: number;
}

/** Saves the whole timeline (clips not in the payload are removed). */
export const PUT = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const { clips } = (await req.json()) as { clips: ClipIn[] };
  const existing = await db.timelineClip.findMany({ where: { projectId: id }, select: { id: true } });
  const keep = new Set(clips.filter((c) => c.id).map((c) => c.id));
  await db.$transaction([
    db.timelineClip.deleteMany({ where: { projectId: id, id: { in: existing.map((e) => e.id).filter((x) => !keep.has(x)) } } }),
    ...clips.map((c) => {
      const data = {
        track: c.track, lane: c.lane ?? 0, assetId: c.assetId ?? null, shotId: c.shotId ?? null, label: c.label ?? null,
        start: Math.max(0, c.start), inPoint: Math.max(0, c.inPoint), outPoint: Math.max(c.inPoint + 0.1, c.outPoint),
        transition: c.transition ?? "none", volume: c.volume ?? 1,
      };
      return c.id && existing.some((e) => e.id === c.id)
        ? db.timelineClip.update({ where: { id: c.id }, data })
        : db.timelineClip.create({ data: { ...data, projectId: id } });
    }),
  ]);
  publish(id, { type: "refresh", scope: "timeline" });
  return ok({ ok: true });
});

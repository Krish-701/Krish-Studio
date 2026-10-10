import { db } from "./db";

/** Duration a clip occupies on the timeline. */
export const clipLen = (c: { inPoint: number; outPoint: number }) => Math.max(0.1, c.outPoint - c.inPoint);

/** Appends (or replaces) the video clip for a shot, keeping its slot in shot order. */
export async function upsertShotVideoClip(projectId: string, shotId: string, assetId: string, duration: number) {
  const existing = await db.timelineClip.findFirst({ where: { projectId, shotId, track: "VIDEO" } });
  if (existing) {
    await db.timelineClip.update({ where: { id: existing.id }, data: { assetId, inPoint: 0, outPoint: duration } });
  } else {
    await db.timelineClip.create({ data: { projectId, shotId, assetId, track: "VIDEO", start: 0, inPoint: 0, outPoint: duration } });
  }
  await relayoutVideoTrack(projectId);
}

/**
 * Packs the video track in storyboard order (ripple edit), and moves each shot's voice clip with it.
 * Transitions overlap neighbouring clips by 0.5s.
 */
export async function relayoutVideoTrack(projectId: string) {
  const shots = await db.shot.findMany({ where: { projectId }, orderBy: { order: "asc" }, select: { id: true } });
  const order = new Map(shots.map((s, i) => [s.id, i]));
  const clips = await db.timelineClip.findMany({ where: { projectId, track: "VIDEO" } });
  clips.sort((a, b) => (order.get(a.shotId ?? "") ?? 1e9) - (order.get(b.shotId ?? "") ?? 1e9) || a.start - b.start);
  let t = 0;
  const shotStart = new Map<string, number>();
  for (const c of clips) {
    const start = Math.max(0, c.transition !== "none" && t > 0 ? t - 0.5 : t);
    if (Math.abs(c.start - start) > 1e-3) await db.timelineClip.update({ where: { id: c.id }, data: { start } });
    if (c.shotId) shotStart.set(c.shotId, start);
    t = start + clipLen(c);
  }
  const voices = await db.timelineClip.findMany({ where: { projectId, track: "VOICE", shotId: { not: null } } });
  for (const v of voices) {
    const s = shotStart.get(v.shotId!);
    if (s !== undefined && Math.abs(v.start - s) > 1e-3) await db.timelineClip.update({ where: { id: v.id }, data: { start: s + 0.2 } });
  }
  return t;
}

export async function shotStartTime(projectId: string, shotId: string) {
  const c = await db.timelineClip.findFirst({ where: { projectId, shotId, track: "VIDEO" } });
  if (c) return c.start;
  const end = await timelineEnd(projectId, "VIDEO");
  return end;
}

export async function timelineEnd(projectId: string, track?: "VIDEO" | "VOICE" | "MUSIC" | "SFX") {
  const clips = await db.timelineClip.findMany({ where: { projectId, ...(track ? { track } : {}) } });
  return clips.reduce((m, c) => Math.max(m, c.start + clipLen(c)), 0);
}

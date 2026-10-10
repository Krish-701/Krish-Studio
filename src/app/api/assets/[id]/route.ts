import { db } from "@/lib/db";
import { ok, route, type Params } from "@/lib/api";
import { publish } from "@/lib/events";
import type { StyleLock } from "@/lib/prompt-builder";

export const PATCH = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const b = await req.json();
  const a = await db.asset.update({ where: { id }, data: Object.fromEntries(Object.entries(b).filter(([k]) => ["angle", "name", "role"].includes(k))) });
  publish(a.projectId, { type: "refresh", scope: "all" });
  return ok(a);
});

export const DELETE = route(async (_: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const a = await db.asset.delete({ where: { id } });
  const p = await db.project.findUnique({ where: { id: a.projectId } });
  const lock = (p?.styleLock as StyleLock) || {};
  if (lock.referenceAssetIds?.includes(id)) {
    await db.project.update({ where: { id: a.projectId }, data: { styleLock: { ...lock, referenceAssetIds: lock.referenceAssetIds.filter((x) => x !== id) } } });
  }
  await db.shot.updateMany({ where: { imageAssetId: id }, data: { imageAssetId: null, imageStatus: "IDLE" } });
  await db.shot.updateMany({ where: { videoAssetId: id }, data: { videoAssetId: null, videoStatus: "IDLE" } });
  publish(a.projectId, { type: "refresh", scope: "all" });
  return ok({ ok: true });
});

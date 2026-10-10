import { db } from "@/lib/db";
import { ok, route, type Params } from "@/lib/api";
import { publish } from "@/lib/events";
import { deleteShot, setShotCharacters } from "@/lib/services";
import { relayoutVideoTrack } from "@/lib/timeline";

const FIELDS = ["title", "description", "prompt", "negativePrompt", "dialogue", "speaker", "shotType", "cameraMove", "durationSec", "imageModel", "videoModel", "styleOverride", "approved", "notes", "sceneId", "imageAssetId", "videoAssetId",
  "motionPrompt", "refMode", "continuity", "motionRefAssetId", "endFrameAssetId", "colorPreset", "withSound"];

export const GET = route(async (_: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const shot = await db.shot.findUniqueOrThrow({
    where: { id },
    include: { assets: { orderBy: { createdAt: "desc" } }, jobs: { orderBy: { createdAt: "desc" }, take: 10 }, findings: { where: { resolved: false } } },
  });
  return ok(shot);
});

export const PATCH = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const b = await req.json();
  const data = Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));
  const shot = await db.shot.update({ where: { id }, data });
  if (Array.isArray(b.characterIds)) await setShotCharacters(shot.projectId, id, b.characterIds);
  if (Array.isArray(b.elementIds)) {
    await db.shotElement.deleteMany({ where: { shotId: id } });
    if (b.elementIds.length) await db.shotElement.createMany({ data: b.elementIds.map((elementId: string) => ({ shotId: id, elementId })) });
  }
  // { looks: { [characterId]: "look name" | null } } — wardrobe per shot
  if (b.looks && typeof b.looks === "object") {
    for (const [characterId, look] of Object.entries(b.looks)) await db.shotCharacter.updateMany({ where: { shotId: id, characterId }, data: { look: (look as string) || null } });
  }
  if ("videoAssetId" in b && b.videoAssetId) {
    const a = await db.asset.findUnique({ where: { id: b.videoAssetId } });
    if (a) await db.timelineClip.updateMany({ where: { shotId: id, track: "VIDEO" }, data: { assetId: a.id, inPoint: 0, outPoint: a.durationSec ?? shot.durationSec } });
    await relayoutVideoTrack(shot.projectId);
    publish(shot.projectId, { type: "refresh", scope: "timeline" });
  }
  publish(shot.projectId, { type: "refresh", scope: "shots" });
  return ok(shot);
});

export const DELETE = route(async (_: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const shot = await db.shot.findUniqueOrThrow({ where: { id } });
  await deleteShot(shot.projectId, id);
  return ok({ ok: true });
});

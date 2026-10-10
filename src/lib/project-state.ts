import { db } from "./db";

/** Everything the studio UI needs for one project, in one payload. */
export async function projectState(id: string) {
  const project = await db.project.findUniqueOrThrow({ where: { id } });
  const [scenes, shots, characters, assets, clips, jobs, findings] = await Promise.all([
    db.scene.findMany({ where: { projectId: id }, orderBy: { index: "asc" } }),
    db.shot.findMany({ where: { projectId: id }, orderBy: { order: "asc" }, include: { characters: { select: { characterId: true } } } }),
    db.character.findMany({ where: { projectId: id }, orderBy: { createdAt: "asc" }, include: { references: { orderBy: { createdAt: "asc" } } } }),
    db.asset.findMany({ where: { projectId: id }, orderBy: { createdAt: "desc" } }),
    db.timelineClip.findMany({ where: { projectId: id }, orderBy: { start: "asc" } }),
    db.job.findMany({ where: { projectId: id }, orderBy: { createdAt: "desc" }, take: 200 }),
    db.agentFinding.findMany({ where: { projectId: id, resolved: false }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  const byId = new Map(assets.map((a) => [a.id, a]));
  return {
    project,
    scenes,
    shots: shots.map((s) => ({
      ...s,
      characterIds: s.characters.map((c) => c.characterId),
      imageUrl: s.imageAssetId ? byId.get(s.imageAssetId)?.url ?? null : null,
      imageMeta: s.imageAssetId ? byId.get(s.imageAssetId)?.meta ?? null : null,
      videoUrl: s.videoAssetId ? byId.get(s.videoAssetId)?.url ?? null : null,
    })),
    characters,
    assets: assets.filter((a) => a.role !== "CHARACTER_REF"),
    clips: clips.map((c) => ({ ...c, url: c.assetId ? byId.get(c.assetId)?.url ?? null : null, kind: c.assetId ? byId.get(c.assetId)?.kind : null })),
    jobs,
    findings,
  };
}

export type ProjectState = Awaited<ReturnType<typeof projectState>>;

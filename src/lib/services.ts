import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { publish } from "./events";
import { enqueue, requeue } from "./queue";
import type { ParsedScript } from "./script/parse";
import { relayoutVideoTrack } from "./timeline";

/** Shared operations used by API routes and by the AI agents' tools. */

const PALETTE = ["#f59e0b", "#22d3ee", "#a78bfa", "#f472b6", "#34d399", "#fb7185", "#60a5fa", "#facc15", "#4ade80", "#c084fc"];

export async function applyParsedScript(projectId: string, parsed: ParsedScript, replace = true) {
  await db.$transaction(async (tx) => {
    if (replace) {
      await tx.timelineClip.deleteMany({ where: { projectId, shotId: { not: null } } });
      await tx.shot.deleteMany({ where: { projectId } });
      await tx.scene.deleteMany({ where: { projectId } });
    }
    const existing = await tx.character.findMany({ where: { projectId } });
    const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c]));
    let colorIdx = existing.length;
    for (const c of parsed.characters) {
      const key = c.name.toLowerCase();
      if (byName.has(key)) {
        const prev = byName.get(key)!;
        if (!prev.description && c.description) await tx.character.update({ where: { id: prev.id }, data: { description: c.description } });
        continue;
      }
      const created = await tx.character.create({
        data: { projectId, name: c.name, description: c.description ?? "", color: PALETTE[colorIdx++ % PALETTE.length] },
      });
      byName.set(key, created);
    }
    const sceneStart = replace ? 0 : await tx.scene.count({ where: { projectId } });
    let order = replace ? 0 : await tx.shot.count({ where: { projectId } });
    for (const [si, s] of parsed.scenes.entries()) {
      const scene = await tx.scene.create({
        data: { projectId, index: sceneStart + si, heading: s.heading, location: s.location, timeOfDay: s.timeOfDay, summary: s.summary },
      });
      for (const sh of s.shots) {
        const chars = (sh.characters ?? []).map((n) => byName.get(n.toLowerCase())).filter(Boolean);
        await tx.shot.create({
          data: {
            projectId,
            sceneId: scene.id,
            order: order++,
            title: (sh.title || sh.description || "Shot").slice(0, 120),
            description: sh.description ?? "",
            prompt: sh.prompt ?? "",
            dialogue: sh.dialogue || null,
            speaker: sh.speaker || null,
            shotType: sh.shotType,
            cameraMove: sh.cameraMove,
            durationSec: Math.min(15, Math.max(2, Number(sh.durationSec) || 4)),
            characters: { create: chars.map((c) => ({ characterId: c!.id })) },
          },
        });
      }
    }
    await tx.project.update({
      where: { id: projectId },
      data: { stage: "STORYBOARD", ...(parsed.logline ? { logline: parsed.logline } : {}) },
    });
  }, { timeout: 60_000 });
  publish(projectId, { type: "refresh", scope: "all" });
}

async function shotIdsOrAll(projectId: string, shotIds: string[] | "all" | "missing" | undefined, field: "imageAssetId" | "videoAssetId") {
  if (Array.isArray(shotIds) && shotIds.length) return shotIds;
  const where: Prisma.ShotWhereInput = { projectId };
  if (shotIds === "missing" || !shotIds) where[field] = null;
  const shots = await db.shot.findMany({ where, orderBy: { order: "asc" }, select: { id: true } });
  return shots.map((s) => s.id);
}

async function markShot(projectId: string, shotId: string, patch: Prisma.ShotUpdateInput & Record<string, unknown>) {
  await db.shot.update({ where: { id: shotId }, data: patch });
  publish(projectId, { type: "shot", shotId, patch });
}

export async function queueImages(projectId: string, shotIds?: string[] | "all" | "missing", opts: { model?: string } = {}) {
  const ids = await shotIdsOrAll(projectId, shotIds, "imageAssetId");
  const jobs = [];
  for (const id of ids) {
    if (opts.model) await db.shot.update({ where: { id }, data: { imageModel: opts.model } });
    await markShot(projectId, id, { imageStatus: "QUEUED" });
    jobs.push(await enqueue({ projectId, shotId: id, type: "IMAGE" }));
  }
  return jobs;
}

export async function queueVideos(projectId: string, shotIds?: string[] | "all" | "missing", mode: "i2v" | "t2v" = "i2v", opts: { model?: string } = {}) {
  const ids = await shotIdsOrAll(projectId, shotIds, "videoAssetId");
  const jobs = [];
  for (const id of ids) {
    if (opts.model) await db.shot.update({ where: { id }, data: { videoModel: opts.model } });
    await markShot(projectId, id, { videoStatus: "QUEUED" });
    jobs.push(await enqueue({ projectId, shotId: id, type: "VIDEO", input: { mode } }));
  }
  await db.project.updateMany({ where: { id: projectId, stage: { in: ["SCRIPT", "STORYBOARD"] } }, data: { stage: "VIDEO" } });
  return jobs;
}

export async function queueVoiceover(projectId: string, shotId: string, text?: string) {
  const shot = await db.shot.findUniqueOrThrow({ where: { id: shotId } });
  const line = text ?? shot.dialogue;
  if (!line) throw new Error(`Shot #${shot.order + 1} has no dialogue`);
  const speaker = shot.speaker ? await db.character.findFirst({ where: { projectId, name: { equals: shot.speaker, mode: "insensitive" } } }) : null;
  await markShot(projectId, shotId, { audioStatus: "QUEUED" });
  return enqueue({ projectId, shotId, type: "TTS", input: { text: line, voiceId: speaker?.voiceId ?? null } });
}

export async function queueMusic(projectId: string, prompt: string, durationSec: number, start = 0) {
  return enqueue({ projectId, type: "MUSIC", input: { prompt, durationSec, start } });
}

export async function queueSfx(projectId: string, prompt: string, durationSec: number, start = 0) {
  return enqueue({ projectId, type: "SFX", input: { prompt, durationSec, start } });
}

export async function retryFailed(projectId: string, jobIds?: string[]) {
  const jobs = await db.job.findMany({ where: { projectId, status: "FAILED", ...(jobIds?.length ? { id: { in: jobIds } } : {}) } });
  for (const j of jobs) {
    if (j.shotId) {
      const field = j.type === "IMAGE" ? "imageStatus" : j.type === "VIDEO" ? "videoStatus" : j.type === "TTS" ? "audioStatus" : null;
      if (field) await markShot(projectId, j.shotId, { [field]: "QUEUED" });
    }
    await requeue(j.id, 0, true);
  }
  return jobs.length;
}

export async function cancelJob(jobId: string) {
  const job = await db.job.update({ where: { id: jobId }, data: { status: "CANCELED", step: "Canceled" } });
  if (job.shotId) {
    const field = job.type === "IMAGE" ? "imageStatus" : job.type === "VIDEO" ? "videoStatus" : job.type === "TTS" ? "audioStatus" : null;
    if (field) await markShot(job.projectId, job.shotId, { [field]: "IDLE" });
  }
  publish(job.projectId, { type: "job", job: { id: job.id, shotId: job.shotId, type: job.type, status: job.status, progress: job.progress, step: job.step, error: null } });
}

export async function reorderShots(projectId: string, shotIds: string[]) {
  await db.$transaction(shotIds.map((id, i) => db.shot.update({ where: { id }, data: { order: i } })));
  await relayoutVideoTrack(projectId);
  publish(projectId, { type: "refresh", scope: "shots" });
  publish(projectId, { type: "refresh", scope: "timeline" });
}

export async function setShotCharacters(projectId: string, shotId: string, names: string[]) {
  const chars = await db.character.findMany({ where: { projectId } });
  const ids = names
    .map((n) => chars.find((c) => c.id === n || c.name.toLowerCase() === n.toLowerCase())?.id)
    .filter((x): x is string => !!x);
  await db.shotCharacter.deleteMany({ where: { shotId } });
  if (ids.length) await db.shotCharacter.createMany({ data: ids.map((characterId) => ({ shotId, characterId })) });
}

export async function createShot(projectId: string, data: { sceneId?: string | null; afterShotId?: string | null; title: string; description?: string; prompt?: string; shotType?: string; cameraMove?: string; durationSec?: number; dialogue?: string; speaker?: string }) {
  const shots = await db.shot.findMany({ where: { projectId }, orderBy: { order: "asc" } });
  const afterIdx = data.afterShotId ? shots.findIndex((s) => s.id === data.afterShotId) : shots.length - 1;
  const after = shots[afterIdx];
  const order = afterIdx + 1;
  await db.$transaction(shots.slice(order).map((s, i) => db.shot.update({ where: { id: s.id }, data: { order: order + 1 + i } })));
  const shot = await db.shot.create({
    data: {
      projectId,
      sceneId: data.sceneId ?? after?.sceneId ?? null,
      order,
      title: data.title,
      description: data.description ?? "",
      prompt: data.prompt ?? "",
      shotType: data.shotType,
      cameraMove: data.cameraMove,
      durationSec: data.durationSec ?? 4,
      dialogue: data.dialogue,
      speaker: data.speaker,
    },
  });
  publish(projectId, { type: "refresh", scope: "shots" });
  return shot;
}

export async function deleteShot(projectId: string, shotId: string) {
  await db.timelineClip.deleteMany({ where: { shotId } });
  await db.shot.delete({ where: { id: shotId } });
  const rest = await db.shot.findMany({ where: { projectId }, orderBy: { order: "asc" } });
  await db.$transaction(rest.map((s, i) => db.shot.update({ where: { id: s.id }, data: { order: i } })));
  await relayoutVideoTrack(projectId);
  publish(projectId, { type: "refresh", scope: "all" });
}

export async function projectOverview(projectId: string) {
  const p = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    include: {
      scenes: { orderBy: { index: "asc" }, include: { _count: { select: { shots: true } } } },
      characters: { include: { _count: { select: { references: true } } } },
      _count: { select: { shots: true } },
    },
  });
  const shots = await db.shot.groupBy({ by: ["imageStatus"], where: { projectId }, _count: true });
  const vids = await db.shot.groupBy({ by: ["videoStatus"], where: { projectId }, _count: true });
  return {
    title: p.title,
    logline: p.logline,
    stage: p.stage,
    aspectRatio: p.aspectRatio,
    styleLock: p.styleLock,
    defaults: p.defaults,
    totalShots: p._count.shots,
    frames: Object.fromEntries(shots.map((s) => [s.imageStatus, s._count])),
    clips: Object.fromEntries(vids.map((s) => [s.videoStatus, s._count])),
    scenes: p.scenes.map((s) => ({ id: s.id, index: s.index + 1, heading: s.heading, shots: s._count.shots, summary: s.summary })),
    characters: p.characters.map((c) => ({ id: c.id, name: c.name, description: c.description, locked: c.locked, referenceImages: c._count.references, voiceId: c.voiceId })),
  };
}

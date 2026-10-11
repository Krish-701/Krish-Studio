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
            durationSec: Math.min(15, Math.max(3, Number(sh.durationSec) || 5)),
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

/**
 * mode: undefined/"auto" uses each shot's reference mode; "i2v"/"frame", "t2v"/"reference" or "text" force one.
 * Shots set to continuity "extend" are queued as clip extensions of the previous shot.
 */
export async function queueVideos(projectId: string, shotIds?: string[] | "all" | "missing", mode?: string, opts: { model?: string } = {}) {
  const ids = await shotIdsOrAll(projectId, shotIds, "videoAssetId");
  const jobs = [];
  const shots = await db.shot.findMany({ where: { id: { in: ids } }, select: { id: true, continuity: true } });
  for (const id of ids) {
    if (opts.model) await db.shot.update({ where: { id }, data: { videoModel: opts.model } });
    await markShot(projectId, id, { videoStatus: "QUEUED" });
    const extend = shots.find((s) => s.id === id)?.continuity === "extend";
    jobs.push(await enqueue({ projectId, shotId: id, type: extend ? "EXTEND_VIDEO" : "VIDEO", input: { mode: mode === "auto" ? undefined : mode } }));
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
      durationSec: Math.min(15, Math.max(3, data.durationSec ?? 5)),
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
      scenes: { orderBy: { index: "asc" }, include: { _count: { select: { shots: true } }, locationEl: { select: { name: true } } } },
      sequences: { orderBy: { index: "asc" }, include: { _count: { select: { scenes: true } } } },
      characters: { include: { _count: { select: { references: true } } } },
      elements: { include: { _count: { select: { references: true } } } },
      _count: { select: { shots: true } },
    },
  });
  const shots = await db.shot.groupBy({ by: ["imageStatus"], where: { projectId }, _count: true });
  const vids = await db.shot.groupBy({ by: ["videoStatus"], where: { projectId }, _count: true });
  return {
    title: p.title,
    logline: p.logline,
    format: p.format,
    targetRuntimeSec: p.targetRuntimeSec,
    synopsis: p.synopsis,
    stage: p.stage,
    aspectRatio: p.aspectRatio,
    resolution: p.resolution,
    styleLock: p.styleLock,
    defaults: p.defaults,
    totalShots: p._count.shots,
    frames: Object.fromEntries(shots.map((s) => [s.imageStatus, s._count])),
    clips: Object.fromEntries(vids.map((s) => [s.videoStatus, s._count])),
    sequences: p.sequences.map((q) => ({ id: q.id, index: q.index + 1, act: q.act, title: q.title, status: q.status, scenes: q._count.scenes, targetSec: q.targetDurationSec })),
    // Long films: scene list is capped; use list_shots with a scene or sequence filter for detail.
    scenes: p.scenes.slice(0, 120).map((s) => ({ id: s.id, index: s.index + 1, heading: s.heading, set: s.locationEl?.name ?? null, shots: s._count.shots, summary: s.summary?.slice(0, 200) ?? null })),
    moreScenes: Math.max(0, p.scenes.length - 120),
    characters: p.characters.map((c) => ({ id: c.id, name: c.name, handle: c.handle, role: c.role, description: c.description, locked: c.locked, referenceImages: c._count.references, designSheet: !!c.sheetAssetId, voiceId: c.voiceId })),
    sets: p.elements.filter((e) => e.kind === "location").map((e) => ({ id: e.id, name: e.name, description: e.description, referenceImages: e._count.references })),
    props: p.elements.filter((e) => e.kind === "prop").map((e) => ({ id: e.id, name: e.name, description: e.description, referenceImages: e._count.references })),
    environments: p.elements.filter((e) => e.kind === "environment").map((e) => ({ id: e.id, name: e.name, description: e.description, referenceImages: e._count.references })),
    moodBoards: p.elements.filter((e) => e.kind === "mood").map((e) => ({ id: e.id, name: e.name, description: e.description, referenceImages: e._count.references })),
  };
}

// ---------------- long-form production ----------------

/** "Write my film": outline (acts → sequences), then optionally board every sequence. */
export async function writeFilm(projectId: string, writeAll = true) {
  await db.project.update({ where: { id: projectId }, data: { setupDone: true } });
  return enqueue({ projectId, type: "WRITE_OUTLINE", input: { writeAll }, maxAttempts: 2 });
}

export async function writeSequences(projectId: string, sequenceIds?: string[]) {
  const seqs = await db.sequence.findMany({ where: { projectId, ...(sequenceIds?.length ? { id: { in: sequenceIds } } : { status: { not: "written" } }) }, orderBy: { index: "asc" } });
  const jobs = [];
  for (const s of seqs) jobs.push(await enqueue({ projectId, type: "WRITE_SEQUENCE", input: { sequenceId: s.id }, maxAttempts: 2 }));
  return jobs;
}

export async function queueDesignSheet(projectId: string, input: { characterId?: string; elementId?: string; kind?: "turnaround" | "wardrobe" | "plate"; look?: string; lookDescription?: string; model?: string }) {
  return enqueue({ projectId, type: "DESIGN_SHEET", input, maxAttempts: 2 });
}

/**
 * Asset library: every reference the film's frames are drawn from, built before the storyboard.
 * Queues a design sheet for each character (turnaround), background / set (plates), environment (plates),
 * prop (prop sheet) and the colour & mood board. missingOnly (default) skips assets that already have a sheet
 * or an uploaded reference, and anything with a sheet already queued. Creates the film's mood entry from the
 * style lock if there is none.
 */
export async function buildAssetLibrary(projectId: string, opts: { missingOnly?: boolean; model?: string } = {}) {
  const missingOnly = opts.missingOnly !== false;
  const { handleOf, moodFromStyle } = await import("./script/writer");
  type Lock = Parameters<typeof moodFromStyle>[0];
  if (!(await db.element.count({ where: { projectId, kind: "mood" } }))) {
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
    const m = moodFromStyle((project.styleLock as Lock) ?? {});
    await db.element.create({ data: { projectId, kind: "mood", name: m.name, description: m.description, handle: handleOf(m.name), color: "#f472b6" } });
  }
  const [chars, els, pending] = await Promise.all([
    db.character.findMany({ where: { projectId }, include: { references: { select: { id: true, kind: true } } } }),
    db.element.findMany({ where: { projectId }, orderBy: { createdAt: "asc" }, include: { references: { select: { id: true, kind: true } } } }),
    db.job.findMany({ where: { projectId, type: "DESIGN_SHEET", status: { in: ["QUEUED", "RUNNING"] } }, select: { input: true } }),
  ]);
  const busy = new Set(pending.flatMap((j) => { const i = (j.input ?? {}) as Record<string, string>; return [i.characterId, i.elementId].filter(Boolean); }));
  const has = (refs: { kind: string }[]) => refs.some((r) => r.kind === "IMAGE");
  const queued: Record<string, number> = { character: 0, location: 0, environment: 0, prop: 0, mood: 0 };
  let skipped = 0;
  for (const c of chars) {
    if (c.role === "extra" || busy.has(c.id) || (missingOnly && (c.sheetAssetId || has(c.references)))) { skipped++; continue; }
    await queueDesignSheet(projectId, { characterId: c.id, kind: "turnaround", model: opts.model });
    queued.character++;
  }
  // Long films can have hundreds of sets and props; cap each kind per build (run again for the rest).
  const CAP: Record<string, number> = { location: 40, environment: 20, prop: 40, mood: 6 };
  for (const e of els) {
    const k = e.kind in CAP ? e.kind : "location";
    if (busy.has(e.id) || (missingOnly && has(e.references)) || queued[k] >= CAP[k]) { skipped++; continue; }
    await queueDesignSheet(projectId, { elementId: e.id, kind: "plate", model: opts.model });
    queued[k]++;
  }
  const total = Object.values(queued).reduce((a, b) => a + b, 0);
  publish(projectId, { type: "refresh", scope: "characters" });
  return { queued, total, skipped };
}

/** Shot ids for a scope: explicit ids, a scene, a sequence, an act, or the whole film. */
export async function shotsInScope(projectId: string, scope: { shotIds?: string[]; sceneId?: string; sequenceId?: string; act?: number; missing?: "image" | "video" }) {
  const where: Prisma.ShotWhereInput = { projectId };
  if (scope.shotIds?.length) where.id = { in: scope.shotIds };
  if (scope.sceneId) where.sceneId = scope.sceneId;
  if (scope.sequenceId) where.scene = { sequenceId: scope.sequenceId };
  if (scope.act) where.scene = { sequence: { act: scope.act } };
  if (scope.missing === "image") where.imageAssetId = null;
  if (scope.missing === "video") where.videoAssetId = null;
  return db.shot.findMany({ where, orderBy: { order: "asc" }, select: { id: true, sceneId: true, durationSec: true, order: true } });
}

/** Contact sheets: each scene's shots drawn together, up to 9 per sheet. */
export async function queueContactSheets(projectId: string, scope: Parameters<typeof shotsInScope>[1] & { model?: string }) {
  const shots = await shotsInScope(projectId, scope);
  const byScene = new Map<string, string[]>();
  for (const s of shots) byScene.set(s.sceneId ?? "none", [...(byScene.get(s.sceneId ?? "none") ?? []), s.id]);
  const jobs = [];
  for (const ids of byScene.values()) {
    for (let i = 0; i < ids.length; i += 9) {
      const chunk = ids.slice(i, i + 9);
      for (const id of chunk) await markShot(projectId, id, { imageStatus: "QUEUED" });
      jobs.push(await enqueue({ projectId, type: "CONTACT_SHEET", input: { shotIds: chunk, model: scope.model } }));
    }
  }
  await db.project.updateMany({ where: { id: projectId, stage: "SCRIPT" }, data: { stage: "STORYBOARD" } });
  return jobs;
}

/**
 * Scene clips in one multi-shot call per run of consecutive shots (up to the model's shot limit and max length),
 * so cuts inside a scene share one generation: same faces, light and set.
 */
export async function queueMultishot(projectId: string, scope: Parameters<typeof shotsInScope>[1] & { model?: string }) {
  const { videoModel, DEFAULT_VIDEO_MODEL } = await import("./generation/catalog");
  const shots = await shotsInScope(projectId, scope);
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  const slug = scope.model || (project.defaults as Record<string, string>)?.video || DEFAULT_VIDEO_MODEL;
  const m = videoModel(slug);
  if (!m?.multishot) throw new Error(`${m?.name ?? slug} can't generate several shots in one call. Pick Seedance 2.x or Kling 3.0.`);
  const maxLen = Math.max(...(m.durations ?? [15]));
  const jobs: Awaited<ReturnType<typeof enqueue>>[] = [];
  let group: typeof shots = [];
  const flush = async () => {
    if (!group.length) return;
    for (const s of group) await markShot(projectId, s.id, { videoStatus: "QUEUED", multishotGroup: group[0].id });
    jobs.push(await enqueue({ projectId, type: "MULTISHOT_VIDEO", input: { shotIds: group.map((s) => s.id), model: slug } }));
    group = [];
  };
  for (const s of shots) {
    const len = group.reduce((a, b) => a + Math.min(m.multishot!.max, b.durationSec), 0) + Math.min(m.multishot.max, s.durationSec);
    if (group.length && (group[0].sceneId !== s.sceneId || group.length >= m.multishot.limit || len > maxLen)) await flush();
    group.push(s);
  }
  await flush();
  await db.project.updateMany({ where: { id: projectId, stage: { in: ["SCRIPT", "STORYBOARD"] } }, data: { stage: "VIDEO" } });
  return jobs;
}

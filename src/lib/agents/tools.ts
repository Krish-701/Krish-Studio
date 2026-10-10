import type { AgentKind, Stage } from "@prisma/client";
import { db } from "../db";
import { publish } from "../events";
import type { ToolDef } from "../llm";
import { enqueue } from "../queue";
import * as svc from "../services";
import type { StyleLock } from "../prompt-builder";
import { deleteMemory, listMemory, writeMemory } from "../memory";

export interface ToolCtx {
  projectId: string;
  agent: Exclude<AgentKind, "USER">;
  depth: number;
  spawn: (agent: Exclude<AgentKind, "USER" | "DIRECTOR">, task: string) => Promise<string>;
}

type Impl = (args: Record<string, any>, ctx: ToolCtx) => Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any

const S = (description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
  description,
  parameters: { type: "object", properties, required },
});
const str = (d: string) => ({ type: "string", description: d });
const num = (d: string) => ({ type: "number", description: d });
const strArr = (d: string) => ({ type: "array", items: { type: "string" }, description: d });

async function shotIdsFromRefs(projectId: string, refs?: (string | number)[]) {
  if (!refs?.length) return undefined;
  const shots = await db.shot.findMany({ where: { projectId }, select: { id: true, order: true } });
  return refs
    .map((r) => {
      if (typeof r === "number" || /^#?\d+$/.test(String(r))) return shots.find((s) => s.order + 1 === Number(String(r).replace("#", "")))?.id;
      return shots.find((s) => s.id === r)?.id;
    })
    .filter((x): x is string => !!x);
}

async function resolveShot(projectId: string, ref: string | number) {
  const ids = await shotIdsFromRefs(projectId, [ref]);
  if (!ids?.length) throw new Error(`Unknown shot ${ref}. Use list_shots to get valid ids or numbers.`);
  return ids[0];
}

const DEFS: Record<string, { schema: ReturnType<typeof S>; impl: Impl }> = {
  get_project_overview: {
    schema: S("Project summary: stage, style lock, characters (with reference counts), scenes and generation status counts."),
    impl: (_, c) => svc.projectOverview(c.projectId),
  },
  list_shots: {
    schema: S("List shots in storyboard order with prompts and statuses.", { scene: num("Optional 1-based scene index to filter") }),
    impl: async (a, c) => {
      const shots = await db.shot.findMany({
        where: { projectId: c.projectId, ...(a.scene ? { scene: { index: a.scene - 1 } } : {}) },
        orderBy: { order: "asc" },
        include: { characters: { include: { character: { select: { name: true } } } }, scene: { select: { index: true, heading: true } } },
      });
      return shots.map((s) => ({
        id: s.id, number: s.order + 1, scene: s.scene ? `${s.scene.index + 1}. ${s.scene.heading}` : null, title: s.title,
        description: s.description.slice(0, 300), prompt: s.prompt.slice(0, 400), shotType: s.shotType, cameraMove: s.cameraMove, durationSec: s.durationSec,
        dialogue: s.dialogue, speaker: s.speaker, characters: s.characters.map((x) => x.character.name),
        image: s.imageStatus, video: s.videoStatus, approved: s.approved, imageModel: s.imageModel, videoModel: s.videoModel,
      }));
    },
  },
  get_shot: {
    schema: S("Full details of one shot.", { shot: str("Shot id or number") }, ["shot"]),
    impl: async (a, c) => {
      const id = await resolveShot(c.projectId, a.shot);
      const s = await db.shot.findUnique({ where: { id }, include: { characters: { include: { character: true } }, findings: { where: { resolved: false } }, jobs: { orderBy: { createdAt: "desc" }, take: 3 } } });
      return s && { ...s, number: s.order + 1, characters: s.characters.map((x) => x.character.name) };
    },
  },
  update_shot: {
    schema: S(
      "Edit a shot. Only include fields you want to change.",
      {
        shot: str("Shot id or number"), title: str(""), description: str(""), prompt: str("Image generation prompt"), negativePrompt: str(""),
        shotType: str("EXTREME_WIDE|WIDE|FULL|MEDIUM|MEDIUM_CLOSE|CLOSE_UP|EXTREME_CLOSE_UP|OVER_SHOULDER|POV|INSERT|AERIAL"),
        cameraMove: str("static|pushIn|pullOut|panLeft|panRight|tiltUp|tiltDown|truckLeft|truckRight|craneUp|craneDown|orbitLeft|orbitRight|handheld"),
        durationSec: num("2-15"), dialogue: str(""), speaker: str(""), imageModel: str("image model slug"), videoModel: str("video model slug"),
        characters: strArr("Names of characters in frame (replaces the list)"),
        styleOverride: { type: "object", description: "Per-shot style override (same fields as set_style_lock), or {} to clear" },
      },
      ["shot"],
    ),
    impl: async (a, c) => {
      const id = await resolveShot(c.projectId, a.shot);
      const { shot: _s, characters, ...rest } = a;
      void _s;
      const allowed = ["title", "description", "prompt", "negativePrompt", "shotType", "cameraMove", "durationSec", "dialogue", "speaker", "imageModel", "videoModel", "styleOverride"];
      const data = Object.fromEntries(Object.entries(rest).filter(([k]) => allowed.includes(k)));
      await db.shot.update({ where: { id }, data });
      if (characters) await svc.setShotCharacters(c.projectId, id, characters);
      publish(c.projectId, { type: "refresh", scope: "shots" });
      return { ok: true, updated: Object.keys(data).concat(characters ? ["characters"] : []) };
    },
  },
  create_shot: {
    schema: S("Insert a new shot.", { after: str("Shot id or number to insert after (default: end)"), title: str(""), description: str(""), prompt: str(""), shotType: str(""), cameraMove: str(""), durationSec: num(""), dialogue: str(""), speaker: str("") }, ["title"]),
    impl: async (a, c) => {
      const afterShotId = a.after ? await resolveShot(c.projectId, a.after) : null;
      const s = await svc.createShot(c.projectId, { ...a, afterShotId } as never);
      return { id: s.id, number: s.order + 1 };
    },
  },
  delete_shot: {
    schema: S("Delete a shot.", { shot: str("Shot id or number") }, ["shot"]),
    impl: async (a, c) => {
      await svc.deleteShot(c.projectId, await resolveShot(c.projectId, a.shot));
      return { ok: true };
    },
  },
  reorder_shots: {
    schema: S("Set the full storyboard order.", { shots: strArr("All shot ids or numbers in the new order") }, ["shots"]),
    impl: async (a, c) => {
      const ids = (await shotIdsFromRefs(c.projectId, a.shots)) ?? [];
      await svc.reorderShots(c.projectId, ids);
      return { ok: true, count: ids.length };
    },
  },
  generate_images: {
    schema: S("Queue storyboard frame generation (Magnific MCP). Character references and style lock are injected automatically.", {
      shots: strArr("Shot ids or numbers. Omit for every shot that has no frame yet."), model: str("Optional image model slug"),
    }),
    impl: async (a, c) => {
      const ids = await shotIdsFromRefs(c.projectId, a.shots);
      const jobs = await svc.queueImages(c.projectId, ids ?? "missing", { model: a.model });
      return { queued: jobs.length };
    },
  },
  generate_videos: {
    schema: S("Queue video clip generation for shots.", {
      shots: strArr("Shot ids or numbers. Omit for every shot without a clip."), mode: str("i2v (from approved frame, default) or t2v"), model: str("Optional video model slug"),
    }),
    impl: async (a, c) => {
      const ids = await shotIdsFromRefs(c.projectId, a.shots);
      const jobs = await svc.queueVideos(c.projectId, ids ?? "missing", a.mode === "t2v" ? "t2v" : "i2v", { model: a.model });
      return { queued: jobs.length };
    },
  },
  get_progress: {
    schema: S("Live generation status: queued/running/failed jobs with errors."),
    impl: async (_, c) => {
      const jobs = await db.job.findMany({ where: { projectId: c.projectId }, orderBy: { updatedAt: "desc" }, take: 60, include: { shot: { select: { order: true, title: true } } } });
      const count = (s: string) => jobs.filter((j) => j.status === s).length;
      return {
        queued: count("QUEUED"), running: count("RUNNING"), failed: count("FAILED"), succeeded: count("SUCCEEDED"),
        active: jobs.filter((j) => ["QUEUED", "RUNNING"].includes(j.status)).map((j) => ({ id: j.id, type: j.type, shot: j.shot ? j.shot.order + 1 : null, progress: j.progress, step: j.step })),
        failures: jobs.filter((j) => j.status === "FAILED").map((j) => ({ id: j.id, type: j.type, shot: j.shot ? j.shot.order + 1 : null, error: j.error, attempts: j.attempts })),
      };
    },
  },
  retry_failed: {
    schema: S("Retry failed jobs.", { jobIds: strArr("Optional job ids; omit to retry all failed") }),
    impl: async (a, c) => ({ retried: await svc.retryFailed(c.projectId, a.jobIds) }),
  },
  list_characters: {
    schema: S("Characters with descriptions, lock state and reference image angles."),
    impl: async (_, c) => {
      const chars = await db.character.findMany({ where: { projectId: c.projectId }, include: { references: { select: { angle: true, url: true } } } });
      return chars.map((x) => ({ id: x.id, name: x.name, description: x.description, locked: x.locked, voiceId: x.voiceId, references: x.references.map((r) => r.angle ?? "unspecified") }));
    },
  },
  update_character: {
    schema: S("Create or update a character.", { name: str("Character name"), description: str("Visual description"), locked: { type: "boolean" }, voiceId: num("TTS voice id") }, ["name"]),
    impl: async (a, c) => {
      const existing = await db.character.findFirst({ where: { projectId: c.projectId, name: { equals: a.name, mode: "insensitive" } } });
      const data = { ...(a.description !== undefined && { description: a.description }), ...(a.locked !== undefined && { locked: a.locked }), ...(a.voiceId !== undefined && { voiceId: a.voiceId }) };
      const ch = existing
        ? await db.character.update({ where: { id: existing.id }, data })
        : await db.character.create({ data: { projectId: c.projectId, name: a.name, ...data } });
      publish(c.projectId, { type: "refresh", scope: "characters" });
      return { id: ch.id, created: !existing };
    },
  },
  set_style_lock: {
    schema: S("Set the global style lock applied to every generation.", {
      enabled: { type: "boolean" }, prompt: str("Overall look, e.g. '1970s anamorphic neo-noir, Kodak 5247 grain'"), mood: str(""), tone: str(""),
      palette: strArr("Colour names or hex"), lighting: str(""), camera: str("Lens / camera language"), negative: str("Things to avoid"),
    }),
    impl: async (a, c) => {
      const p = await db.project.findUniqueOrThrow({ where: { id: c.projectId } });
      const next = { ...(p.styleLock as StyleLock), ...a, enabled: a.enabled ?? true };
      await db.project.update({ where: { id: c.projectId }, data: { styleLock: next } });
      publish(c.projectId, { type: "refresh", scope: "project" });
      return { ok: true, styleLock: next };
    },
  },
  report_finding: {
    schema: S("Log an issue or note on the project/shot (appears in the Agents panel).", {
      shot: str("Shot id or number (optional)"), severity: str("info|warn|error"), message: str("What is wrong"), suggestion: str("How to fix"),
      fixPrompt: str("Optional corrected image prompt the user can apply with one click"),
    }, ["message"]),
    impl: async (a, c) => {
      const shotId = a.shot ? await resolveShot(c.projectId, a.shot).catch(() => null) : null;
      const f = await db.agentFinding.create({
        data: { projectId: c.projectId, shotId, agent: c.agent, severity: a.severity ?? "warn", message: a.message, suggestion: a.suggestion, fix: a.fixPrompt ? { action: "regenerate_image", prompt: a.fixPrompt } : undefined },
      });
      publish(c.projectId, { type: "finding", finding: f as never });
      return { ok: true };
    },
  },
  generate_voiceover: {
    schema: S("Generate dialogue voiceover (TTS) for shots and place it on the timeline.", { shots: strArr("Shot ids or numbers; omit for all shots with dialogue and no voice yet") }),
    impl: async (a, c) => {
      let ids = await shotIdsFromRefs(c.projectId, a.shots);
      if (!ids) {
        const voiced = await db.asset.findMany({ where: { projectId: c.projectId, role: "VOICEOVER" }, select: { shotId: true } });
        const done = new Set(voiced.map((v) => v.shotId));
        ids = (await db.shot.findMany({ where: { projectId: c.projectId, dialogue: { not: null } }, select: { id: true } })).map((s) => s.id).filter((id) => !done.has(id));
      }
      let n = 0;
      for (const id of ids) {
        await svc.queueVoiceover(c.projectId, id).then(() => n++).catch(() => {});
      }
      return { queued: n };
    },
  },
  generate_music: {
    schema: S("Generate a music cue and place it on the music track.", { prompt: str("Genre, mood, instruments, tempo"), durationSec: num("10-300"), start: num("Timeline start in seconds") }, ["prompt"]),
    impl: async (a, c) => {
      await svc.queueMusic(c.projectId, a.prompt, a.durationSec ?? 30, a.start ?? 0);
      return { queued: 1 };
    },
  },
  generate_sfx: {
    schema: S("Generate a sound effect and place it on the SFX track.", { prompt: str("Source, surface, perspective"), durationSec: num("1-30"), start: num("Timeline start (s)"), shot: str("Or: align to the start of this shot") }, ["prompt"]),
    impl: async (a, c) => {
      let start = a.start ?? 0;
      if (a.shot) {
        const id = await resolveShot(c.projectId, a.shot);
        const clip = await db.timelineClip.findFirst({ where: { shotId: id, track: "VIDEO" } });
        start = clip?.start ?? start;
      }
      await svc.queueSfx(c.projectId, a.prompt, a.durationSec ?? 3, start);
      return { queued: 1 };
    },
  },
  set_stage: {
    schema: S("Move the production to a pipeline stage.", { stage: str("SCRIPT|STORYBOARD|VIDEO|AUDIO|EXPORT") }, ["stage"]),
    impl: async (a, c) => {
      await db.project.update({ where: { id: c.projectId }, data: { stage: a.stage as Stage } });
      publish(c.projectId, { type: "refresh", scope: "project" });
      return { ok: true };
    },
  },
  export_film: {
    schema: S("Render the timeline to MP4."),
    impl: async (_, c) => {
      const j = await enqueue({ projectId: c.projectId, type: "EXPORT_MP4", maxAttempts: 1 });
      return { jobId: j.id };
    },
  },
  export_storyboard_pdf: {
    schema: S("Export the storyboard as a PDF."),
    impl: async (_, c) => {
      const j = await enqueue({ projectId: c.projectId, type: "EXPORT_PDF", maxAttempts: 1 });
      return { jobId: j.id };
    },
  },
  memory_search: {
    schema: S("Search the shared project memory (all agents and the user share it). Omit query to list everything.", {
      query: str("Words to look for in keys and content"), category: str("decision|preference|character|style|continuity|note"),
    }),
    impl: async (a, c) => {
      const rows = await listMemory(c.projectId, { query: a.query, category: a.category });
      return rows.map((e) => ({ key: e.key, category: e.category, content: e.content, pinned: e.pinned, version: e.version, updatedBy: e.updatedBy, updatedAt: e.updatedAt }));
    },
  },
  memory_write: {
    schema: S(
      "Add or update a shared memory entry so every agent (and future conversations) remember it. Use for lasting decisions, user preferences, character/continuity facts and style rules, not for progress updates.",
      {
        key: str("Short unique name, e.g. 'maya-wardrobe'. Reusing a key updates that entry."), content: str("The fact, in one to three sentences"),
        category: str("decision|preference|character|style|continuity|note"), mode: str("replace (default) or append"),
        pinned: { type: "boolean", description: "Pin so it always stays at the top" },
        expectedVersion: num("Optional: the version you read; the write fails if someone changed it since"),
      },
      ["key", "content"],
    ),
    impl: async (a, c) => {
      const e = await writeMemory(c.projectId, a as never, c.agent);
      return { ok: true, key: e.key, version: e.version };
    },
  },
  memory_delete: {
    schema: S("Delete a shared memory entry that is wrong or no longer true.", { key: str("Entry key") }, ["key"]),
    impl: async (a, c) => ({ deleted: await deleteMemory(c.projectId, a.key) }),
  },
  spawn_subagent: {
    schema: S("Delegate a task to a specialist sub-agent and get its report back.", {
      agent: str("CONSISTENCY | MOOD | MONITOR | AUDIO"), task: str("What the sub-agent should do"),
    }, ["agent", "task"]),
    impl: async (a, c) => {
      if (c.depth > 1) return { error: "Sub-agents cannot spawn further sub-agents." };
      const kind = String(a.agent).toUpperCase();
      if (!["CONSISTENCY", "MOOD", "MONITOR", "AUDIO"].includes(kind)) return { error: "Unknown agent" };
      return { report: await c.spawn(kind as never, a.task) };
    },
  },
};

export function toolDefs(allowed: string[]): ToolDef[] {
  const names = allowed.includes("*") ? Object.keys(DEFS) : allowed;
  return names.filter((n) => DEFS[n]).map((name) => ({ type: "function", function: { name, ...DEFS[name].schema } }));
}

export async function runTool(name: string, rawArgs: string, ctx: ToolCtx, allowed: string[]) {
  if (!allowed.includes("*") && !allowed.includes(name)) return { error: `Tool ${name} is not available to this agent` };
  const def = DEFS[name];
  if (!def) return { error: `Unknown tool ${name}` };
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { error: "Arguments were not valid JSON" };
  }
  try {
    return await def.impl(args, ctx);
  } catch (e) {
    return { error: (e as Error).message };
  }
}

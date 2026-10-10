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
    schema: S("List shots in storyboard order with prompts and statuses. On long films always filter by scene or sequence.", {
      scene: num("Optional 1-based scene index to filter"), sequence: num("Optional 1-based sequence index to filter"),
    }),
    impl: async (a, c) => {
      const shots = await db.shot.findMany({
        where: { projectId: c.projectId, ...(a.scene ? { scene: { index: a.scene - 1 } } : a.sequence ? { scene: { sequence: { index: a.sequence - 1 } } } : {}) },
        take: 300,
        orderBy: { order: "asc" },
        include: { characters: { include: { character: { select: { name: true } } } }, scene: { select: { index: true, heading: true } } },
      });
      return shots.map((s) => ({
        id: s.id, number: s.order + 1, scene: s.scene ? `${s.scene.index + 1}. ${s.scene.heading}` : null, title: s.title,
        description: s.description.slice(0, 300), prompt: s.prompt.slice(0, 400), shotType: s.shotType, cameraMove: s.cameraMove, durationSec: s.durationSec,
        dialogue: s.dialogue, speaker: s.speaker, characters: s.characters.map((x) => x.character.name),
        image: s.imageStatus, video: s.videoStatus, approved: s.approved, imageModel: s.imageModel, videoModel: s.videoModel,
        motion: s.motionPrompt?.slice(0, 200) ?? null, refMode: s.refMode, continuity: s.continuity,
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
        motionPrompt: str("How the shot moves: action and camera, for the video model"),
        refMode: str("auto | frame (animate the storyboard frame) | reference (identity references, frame as a reference) | text"),
        continuity: str("cut | continuous (starts from the previous shot's last frame) | extend (continues the previous clip)"),
        colorPreset: str("Colour grade id: natural, moody, vibrant, vintage, teal-orange, bleach, golden, noir"),
        styleOverride: { type: "object", description: "Per-shot style override (same fields as set_style_lock), or {} to clear" },
      },
      ["shot"],
    ),
    impl: async (a, c) => {
      const id = await resolveShot(c.projectId, a.shot);
      const { shot: _s, characters, ...rest } = a;
      void _s;
      const allowed = ["title", "description", "prompt", "negativePrompt", "shotType", "cameraMove", "durationSec", "dialogue", "speaker", "imageModel", "videoModel", "styleOverride", "motionPrompt", "refMode", "continuity", "colorPreset"];
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
      shots: strArr("Shot ids or numbers. Omit for every shot without a clip."),
      mode: str("auto (default: picks frame or reference mode per model), frame, reference or text"), model: str("Optional video model slug"),
    }),
    impl: async (a, c) => {
      const ids = await shotIdsFromRefs(c.projectId, a.shots);
      const jobs = await svc.queueVideos(c.projectId, ids ?? "missing", a.mode === "i2v" ? "frame" : a.mode === "t2v" ? "text" : a.mode, { model: a.model });
      return { queued: jobs.length };
    },
  },
  write_film: {
    schema: S("Write the film from the synopsis: acts and sequences, then scenes and shots for each sequence. Replaces the current storyboard.", {
      outlineOnly: { type: "boolean", description: "Only write the outline (acts and sequences) so the user can review it first" },
    }),
    impl: async (a, c) => ({ jobId: (await svc.writeFilm(c.projectId, !a.outlineOnly)).id }),
  },
  write_sequences: {
    schema: S("Write scenes and shots for sequences (default: every sequence not yet written).", { sequences: { type: "array", items: { type: "number" }, description: "1-based sequence numbers" } }),
    impl: async (a, c) => {
      const seqs = await db.sequence.findMany({ where: { projectId: c.projectId }, orderBy: { index: "asc" } });
      const ids = a.sequences?.length ? a.sequences.map((n: number) => seqs[n - 1]?.id).filter(Boolean) : undefined;
      return { queued: (await svc.writeSequences(c.projectId, ids)).length };
    },
  },
  design_sheet: {
    schema: S("Generate an AI design sheet: a character turnaround (front, three-quarter, side, back) cut into reference angles, a named wardrobe look, or a film set / prop plate.", {
      character: str("Character name"), set: str("Film set or prop name"), kind: str("turnaround | wardrobe | plate"), look: str("Wardrobe look name"), lookDescription: str("What they wear in this look"),
    }),
    impl: async (a, c) => {
      const ch = a.character ? await db.character.findFirst({ where: { projectId: c.projectId, name: { equals: a.character, mode: "insensitive" } } }) : null;
      const el = a.set ? await db.element.findFirst({ where: { projectId: c.projectId, name: { equals: a.set, mode: "insensitive" } } }) : null;
      if (!ch && !el) throw new Error("Unknown character or set. Use get_project_overview for names.");
      const job = await svc.queueDesignSheet(c.projectId, { characterId: ch?.id, elementId: el?.id, kind: a.kind || (ch ? "turnaround" : "plate"), look: a.look, lookDescription: a.lookDescription });
      return { jobId: job.id };
    },
  },
  create_set: {
    schema: S("Add a film set (location) or prop so every shot that uses it gets its reference images.", { name: str(""), kind: str("location | prop"), description: str("Visual description") }, ["name"]),
    impl: async (a, c) => {
      const { handleOf } = await import("../script/writer");
      const el = await db.element.upsert({
        where: { projectId_kind_name: { projectId: c.projectId, kind: a.kind === "prop" ? "prop" : "location", name: a.name } },
        create: { projectId: c.projectId, kind: a.kind === "prop" ? "prop" : "location", name: a.name, description: a.description ?? "", handle: handleOf(a.name) },
        update: { description: a.description ?? undefined },
      });
      publish(c.projectId, { type: "refresh", scope: "characters" });
      return { id: el.id };
    },
  },
  generate_contact_sheets: {
    schema: S("Draw storyboard frames scene by scene as contact sheets (up to 9 shots in one image, then cut into frames). Cheaper and more consistent than single frames.", {
      shots: strArr("Shot ids or numbers"), sequence: num("1-based sequence number"), all: { type: "boolean", description: "Redraw frames that already exist" },
    }),
    impl: async (a, c) => {
      const ids = await shotIdsFromRefs(c.projectId, a.shots);
      const seq = a.sequence ? await db.sequence.findFirst({ where: { projectId: c.projectId, index: a.sequence - 1 } }) : null;
      return { queued: (await svc.queueContactSheets(c.projectId, { shotIds: ids, sequenceId: seq?.id, missing: a.all ? undefined : "image" })).length };
    },
  },
  generate_multishot: {
    schema: S("Generate scene clips with multi-shot models: consecutive shots of a scene in one call, so faces, light and set match across cuts.", {
      shots: strArr("Shot ids or numbers"), sequence: num("1-based sequence number"), model: str("Multi-shot video model slug (default Seedance 2.5)"),
    }),
    impl: async (a, c) => {
      const ids = await shotIdsFromRefs(c.projectId, a.shots);
      const seq = a.sequence ? await db.sequence.findFirst({ where: { projectId: c.projectId, index: a.sequence - 1 } }) : null;
      return { queued: (await svc.queueMultishot(c.projectId, { shotIds: ids, sequenceId: seq?.id, missing: ids ? undefined : "video", model: a.model })).length };
    },
  },
  lip_sync: {
    schema: S("Re-sync shots' clips to their voiceover so mouths match the dialogue (needs a clip and a voiceover).", { shots: strArr("Shot ids or numbers") }, ["shots"]),
    impl: async (a, c) => {
      const ids = (await shotIdsFromRefs(c.projectId, a.shots)) ?? [];
      for (const id of ids) await enqueue({ projectId: c.projectId, shotId: id, type: "LIPSYNC" });
      return { queued: ids.length };
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

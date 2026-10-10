import { db } from "../db";
import { publish } from "../events";
import { chatJson, isLlmConfigured, type ChatMessage } from "../llm";
import { memoryPrompt } from "../memory";
import { FORMATS, LOOKS } from "../generation/catalog";
import type { StyleLock } from "../prompt-builder";

/**
 * Long-form writer. A film from 30 seconds to 3 hours is written top-down so every call stays small:
 *   1. outline   → acts and sequences (title, summary, target length), plus the cast and film sets it needs
 *   2. sequence  → scenes (heading, set, beats, cast)                      — one call per sequence
 *   3. scene     → shots (framing, action, motion, dialogue, cast, props)   — one call per scene
 * Each call gets the synopsis, the whole outline in one line per sequence, the cast bible, the sets, shared memory
 * and what happened just before, so names, wardrobe and continuity hold across hundreds of scenes.
 * Without an AI model, a structural skeleton is built from the synopsis so the pipeline still works.
 */

const SEQ_COLORS = ["#f59e0b", "#22d3ee", "#a78bfa", "#f472b6", "#34d399", "#fb7185", "#60a5fa", "#facc15"];
const CHAR_COLORS = ["#f59e0b", "#22d3ee", "#a78bfa", "#f472b6", "#34d399", "#fb7185", "#60a5fa", "#facc15", "#4ade80", "#c084fc"];

export interface OutlineJson {
  title?: string;
  logline?: string;
  acts: { act: number; title: string; summary: string; sequences: { title: string; summary: string; targetSec: number }[] }[];
  characters?: { name: string; role?: string; age?: string; gender?: string; description: string }[];
  locations?: { name: string; description: string }[];
  props?: { name: string; description: string }[];
}

interface SceneJson {
  heading: string;
  location?: string;
  timeOfDay?: string;
  summary: string;
  beats?: string[];
  characters?: string[];
  targetSec?: number;
}

interface ShotJson {
  title: string;
  description: string;
  prompt?: string;
  motionPrompt?: string;
  shotType?: string;
  cameraMove?: string;
  durationSec?: number;
  dialogue?: string;
  speaker?: string;
  characters?: string[];
  props?: string[];
  continuous?: boolean;
}

export function handleOf(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "char";
}

/** Shot lengths the agent may choose from. The story decides; these are only the bounds. */
export const SHOT_MIN = 3;
export const SHOT_MAX = 15;

/**
 * Fits the agent's chosen shot lengths to a target total without flattening the rhythm:
 * scales them proportionally, clamps each to 3–15 s, then spreads any remainder over the shots
 * that still have room. Returns the lengths rounded to 0.5 s.
 */
export function fitDurations(wanted: number[], targetSec: number): number[] {
  if (!wanted.length) return [];
  const raw = wanted.map((d) => (Number.isFinite(d) && d > 0 ? d : 6));
  const goal = Math.min(targetSec, raw.length * SHOT_MAX);
  const sum = raw.reduce((a, b) => a + b, 0);
  let out = raw.map((d) => Math.min(SHOT_MAX, Math.max(SHOT_MIN, (d * goal) / sum)));
  for (let pass = 0; pass < 6; pass++) {
    const diff = goal - out.reduce((a, b) => a + b, 0);
    if (Math.abs(diff) < 0.25) break;
    const room = out.map((d) => (diff > 0 ? SHOT_MAX - d : d - SHOT_MIN));
    const total = room.reduce((a, b) => a + b, 0);
    if (total <= 0) break;
    out = out.map((d, i) => d + (diff * room[i]) / total);
  }
  return out.map((d) => Math.min(SHOT_MAX, Math.max(SHOT_MIN, Math.round(d * 2) / 2)));
}

/** Story-led pacing for the offline skeleton: establishing shots hold, inserts and reactions are short. */
const SKELETON_PACE: Record<string, number> = { EXTREME_WIDE: 9, WIDE: 8, FULL: 6, MEDIUM: 6, MEDIUM_CLOSE: 5, CLOSE_UP: 4, EXTREME_CLOSE_UP: 3, OVER_SHOULDER: 5, POV: 4, INSERT: 3, AERIAL: 10 };

/**
 * How a runtime splits into acts and sequences. ~3.5 min per sequence for features, fewer for shorts.
 * Shot counts here are only a sizing estimate; the writer agent decides the real count and each
 * shot's length (3–15 s) from the story.
 */
export function structureFor(format: string, runtimeSec: number) {
  const f = FORMATS.find((x) => x.id === format) ?? FORMATS[1];
  const acts = runtimeSec <= 90 ? 1 : f.acts;
  const seqLen = runtimeSec <= 120 ? runtimeSec / Math.max(1, Math.round(runtimeSec / 30)) : runtimeSec <= 900 ? 60 : runtimeSec <= 3600 ? 150 : 210;
  const sequences = Math.max(1, Math.round(runtimeSec / seqLen));
  const shotsPerSeq = Math.max(2, Math.round(runtimeSec / sequences / f.typicalShot));
  return { acts, sequences, seqLen: runtimeSec / sequences, typicalShot: f.typicalShot, pace: f.pace, shotsPerSeq, scenesPerSeq: runtimeSec <= 120 ? 1 : Math.min(5, Math.max(1, Math.round(runtimeSec / sequences / 70))) };
}

async function bible(projectId: string) {
  const [project, chars, els] = await Promise.all([
    db.project.findUniqueOrThrow({ where: { id: projectId }, include: { sequences: { orderBy: { index: "asc" } } } }),
    db.character.findMany({ where: { projectId } }),
    db.element.findMany({ where: { projectId } }),
  ]);
  const style = (project.styleLock as StyleLock) ?? {};
  const look = LOOKS.find((l) => l.id === style.look);
  const lines = [
    `Film: "${project.title}" · format ${project.format} · runtime ${Math.round(project.targetRuntimeSec / 60)} min · ${project.aspectRatio} · language ${project.language}`,
    project.synopsis && `Synopsis: ${project.synopsis}`,
    project.logline && `Logline: ${project.logline}`,
    (look || style.prompt) && `Look: ${look?.name ?? ""} ${style.prompt ?? ""}`.trim(),
    chars.length && `Cast (use these exact names; refer to them by name in every shot they appear in):\n${chars.map((c) => `- ${c.name} (${c.role}${c.age ? `, ${c.age}` : ""}${c.gender ? `, ${c.gender}` : ""}): ${c.description}`).join("\n")}`,
    els.filter((e) => e.kind === "location").length && `Film sets (reuse them; set "location" to one of these names):\n${els.filter((e) => e.kind === "location").map((e) => `- ${e.name}: ${e.description}`).join("\n")}`,
    els.filter((e) => e.kind === "prop").length && `Key props:\n${els.filter((e) => e.kind === "prop").map((e) => `- ${e.name}: ${e.description}`).join("\n")}`,
    project.sequences.length && `Outline:\n${project.sequences.map((s) => `${s.index + 1}. [Act ${s.act}] ${s.title}: ${s.summary}`).join("\n")}`,
    await songNote(projectId),
    await memoryPrompt(projectId, 2500),
  ];
  return { project, chars, els, text: lines.filter(Boolean).join("\n\n") };
}

/** A music video cut to the user's own song: pace and length follow the track. */
async function songNote(projectId: string) {
  const song = await db.asset.findFirst({ where: { projectId, role: "MUSIC", meta: { path: ["song"], equals: true } }, orderBy: { createdAt: "desc" } });
  if (!song) return null;
  return `Soundtrack: the film is cut to the user's song "${song.name}" (${Math.round(song.durationSec ?? 0)} s). Match the runtime exactly, cut on the beat, build energy toward choruses, and leave dialogue out unless the story needs it.`;
}

const WRITER_SYSTEM = `You are a professional screenwriter and storyboard artist writing an AI-generated film.
Write vivid, visual, filmable material. Keep characters, wardrobe, props and places consistent with the bible.
Every shot must be producible by an AI image/video model from a single prompt: describe what is visible, not thoughts.
Reply with JSON only.`;

// ---------------- 1. outline ----------------

export async function writeOutline(projectId: string, onProgress: (pct: number, step: string) => void | Promise<void>) {
  const { project, text } = await bible(projectId);
  const st = structureFor(project.format, project.targetRuntimeSec);
  await onProgress(10, `Outlining ${st.sequences} sequence(s) in ${st.acts} act(s)`);
  let outline: OutlineJson;
  if (await isLlmConfigured()) {
    outline = await chatJson<OutlineJson>(
      [
        { role: "system", content: WRITER_SYSTEM },
        {
          role: "user",
          content: `${text}\n\nWrite the outline for this ${project.format} of ${Math.round(project.targetRuntimeSec)} seconds: ${st.acts} act(s), ${st.sequences} sequences in total (about ${Math.round(st.seqLen)} seconds each on average; give each sequence the length its story needs in "targetSec", all adding up to ${Math.round(project.targetRuntimeSec)} seconds).
Also list the main characters (with a precise visual description: age, ethnicity, face, hair, build, signature wardrobe), the recurring film sets (locations) and key props. Keep existing cast and sets.
JSON: {"title":"","logline":"","acts":[{"act":1,"title":"","summary":"","sequences":[{"title":"","summary":"2-3 sentences: what happens, who, where","targetSec":${Math.round(st.seqLen)}}]}],"characters":[{"name":"","role":"protagonist|antagonist|supporting|extra","age":"","gender":"","description":""}],"locations":[{"name":"","description":""}],"props":[{"name":"","description":""}]}`,
        },
      ],
      { agent: "DIRECTOR", temperature: 0.7 },
    );
  } else {
    outline = skeletonOutline(project.synopsis || project.logline || project.title, st.acts, st.sequences, st.seqLen);
  }
  // Keep the writer's weighting between sequences, but land exactly on the runtime the user set.
  const seqs = (outline.acts ?? []).flatMap((a) => a.sequences ?? []);
  const sum = seqs.reduce((a, s) => a + (Number(s.targetSec) > 0 ? Number(s.targetSec) : st.seqLen), 0);
  for (const s of seqs) s.targetSec = Math.round((((Number(s.targetSec) > 0 ? Number(s.targetSec) : st.seqLen) * project.targetRuntimeSec) / (sum || 1)) * 10) / 10;
  await onProgress(70, "Saving outline");
  await applyOutline(projectId, outline);
  return outline;
}

/** Classic beat names for the offline skeleton. */
const BEATS_3 = [
  ["Opening image", "Setup", "Inciting incident", "Debate"],
  ["Break into two", "Fun and games", "Midpoint", "Bad guys close in", "All is lost", "Dark night"],
  ["Break into three", "Finale", "Final image"],
];

function skeletonOutline(idea: string, acts: number, sequences: number, seqLen: number): OutlineJson {
  const perAct = acts === 1 ? [sequences] : acts === 3 ? [Math.max(1, Math.round(sequences * 0.25)), 0, Math.max(1, Math.round(sequences * 0.25))] : Array.from({ length: acts }, () => Math.floor(sequences / acts));
  if (acts === 3) perAct[1] = Math.max(1, sequences - perAct[0] - perAct[2]);
  else if (acts > 1) perAct[acts - 1] += sequences - perAct.reduce((a, b) => a + b, 0);
  return {
    acts: perAct.map((n, a) => ({
      act: a + 1,
      title: acts === 1 ? "The film" : `Act ${a + 1}`,
      summary: idea,
      sequences: Array.from({ length: n }, (_, i) => {
        const names = acts === 3 ? BEATS_3[a] : BEATS_3.flat();
        const beat = names[Math.min(names.length - 1, Math.floor((i / n) * names.length))];
        return { title: beat, summary: `${beat}: ${idea}`, targetSec: seqLen };
      }),
    })),
  };
}

export async function applyOutline(projectId: string, o: OutlineJson) {
  await db.$transaction(
    async (tx) => {
      await tx.timelineClip.deleteMany({ where: { projectId, shotId: { not: null } } });
      await tx.shot.deleteMany({ where: { projectId } });
      await tx.scene.deleteMany({ where: { projectId } });
      await tx.sequence.deleteMany({ where: { projectId } });
      let i = 0;
      for (const act of o.acts ?? []) {
        for (const s of act.sequences ?? []) {
          await tx.sequence.create({
            data: { projectId, index: i, act: Number(act.act) || 1, title: String(s.title || `Sequence ${i + 1}`).slice(0, 120), summary: s.summary ?? "", targetDurationSec: Number(s.targetSec) || 60, color: SEQ_COLORS[i % SEQ_COLORS.length] },
          });
          i++;
        }
      }
      const existing = await tx.character.findMany({ where: { projectId } });
      let ci = existing.length;
      for (const c of o.characters ?? []) {
        if (!c.name || existing.some((e) => e.name.toLowerCase() === c.name.toLowerCase())) continue;
        await tx.character.create({
          data: { projectId, name: c.name, description: c.description ?? "", role: c.role ?? "supporting", age: c.age, gender: c.gender, handle: handleOf(c.name), color: CHAR_COLORS[ci++ % CHAR_COLORS.length] },
        });
      }
      const els = await tx.element.findMany({ where: { projectId } });
      for (const [kind, list] of [["location", o.locations ?? []], ["prop", o.props ?? []]] as const) {
        for (const e of list) {
          if (!e.name || els.some((x) => x.kind === kind && x.name.toLowerCase() === e.name.toLowerCase())) continue;
          await tx.element.create({ data: { projectId, kind, name: e.name.slice(0, 80), description: e.description ?? "", handle: handleOf(e.name) } });
        }
      }
      await tx.project.update({
        where: { id: projectId },
        data: { outline: o as never, stage: "SCRIPT", ...(o.logline ? { logline: o.logline } : {}) },
      });
    },
    { timeout: 60_000 },
  );
  publish(projectId, { type: "refresh", scope: "all" });
}

// ---------------- 2 + 3. sequence → scenes → shots ----------------

export async function writeSequence(sequenceId: string, onProgress: (pct: number, step: string) => void | Promise<void>) {
  const seq = await db.sequence.findUniqueOrThrow({ where: { id: sequenceId } });
  const { project, chars, els, text } = await bible(seq.projectId);
  const st = structureFor(project.format, project.targetRuntimeSec);
  await db.sequence.update({ where: { id: seq.id }, data: { status: "writing" } });
  publish(project.id, { type: "refresh", scope: "shots" });

  const prevSeq = await db.sequence.findFirst({ where: { projectId: project.id, index: seq.index - 1 }, include: { scenes: { orderBy: { index: "desc" }, take: 1, include: { shots: { orderBy: { order: "desc" }, take: 2 } } } } });
  const before = prevSeq?.scenes[0] ? `Just before this sequence: ${prevSeq.scenes[0].heading} — ${prevSeq.scenes[0].summary ?? ""} Last shots: ${prevSeq.scenes[0].shots.map((s) => s.description).join(" / ")}` : "This is the opening sequence.";
  const llm = await isLlmConfigured();
  const nScenes = st.scenesPerSeq;

  await onProgress(8, `Writing scenes for “${seq.title}”`);
  let scenes: SceneJson[];
  if (llm) {
    const r = await chatJson<{ scenes: SceneJson[] }>(
      [
        { role: "system", content: WRITER_SYSTEM },
        {
          role: "user",
          content: `${text}\n\n${before}\n\nNow write sequence ${seq.index + 1} (Act ${seq.act}): "${seq.title}" — ${seq.summary}\nTarget length ${Math.round(seq.targetDurationSec)} seconds, about ${nScenes} scene(s). Give each scene the screen time its story needs in "targetSec" (they should add up to ${Math.round(seq.targetDurationSec)}).
JSON: {"scenes":[{"heading":"INT. PLACE - DAY","location":"name of a film set from the bible, or a new one","timeOfDay":"DAY|NIGHT|DAWN|DUSK","summary":"","beats":["what happens, in order"],"characters":["names"],"targetSec":0}]}`,
        },
      ],
      { agent: "DIRECTOR", temperature: 0.7 },
    );
    scenes = r.scenes?.length ? r.scenes : [{ heading: seq.title.toUpperCase(), summary: seq.summary }];
  } else {
    scenes = Array.from({ length: nScenes }, (_, i) => ({ heading: `${seq.title.toUpperCase()}${nScenes > 1 ? ` — PART ${i + 1}` : ""}`, summary: seq.summary, beats: [seq.summary], targetSec: seq.targetDurationSec / nScenes }));
  }
  // The writer may weight scenes unevenly; keep its proportions but make them add up to the sequence.
  const sceneWant = scenes.map((sc) => Number(sc.targetSec) > 0 ? Number(sc.targetSec) : seq.targetDurationSec / scenes.length);
  const wantSum = sceneWant.reduce((a, b) => a + b, 0);
  scenes.forEach((sc, i) => (sc.targetSec = (sceneWant[i] * seq.targetDurationSec) / wantSum));

  // Replace this sequence's scenes.
  const old = await db.scene.findMany({ where: { sequenceId: seq.id }, select: { id: true } });
  const oldShots = await db.shot.findMany({ where: { sceneId: { in: old.map((o) => o.id) } }, select: { id: true } });
  await db.timelineClip.deleteMany({ where: { shotId: { in: oldShots.map((o) => o.id) } } });
  await db.shot.deleteMany({ where: { id: { in: oldShots.map((o) => o.id) } } });
  await db.scene.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });

  const byName = new Map(chars.map((c) => [c.name.toLowerCase(), c]));
  const sets = els.filter((e) => e.kind === "location");
  const props = els.filter((e) => e.kind === "prop");
  let lastShots = "";
  for (const [si, sc] of scenes.entries()) {
    await onProgress(15 + Math.round((si / scenes.length) * 80), `Boarding scene ${si + 1}/${scenes.length}: ${sc.heading}`);
    let set = sets.find((e) => e.name.toLowerCase() === (sc.location ?? "").toLowerCase());
    if (!set && sc.location) {
      set = await db.element.upsert({
        where: { projectId_kind_name: { projectId: project.id, kind: "location", name: sc.location.slice(0, 80) } },
        create: { projectId: project.id, kind: "location", name: sc.location.slice(0, 80), description: sc.heading, handle: handleOf(sc.location) },
        update: {},
      });
      sets.push(set);
    }
    const scene = await db.scene.create({
      data: {
        projectId: project.id, sequenceId: seq.id, index: seq.index * 1000 + si, heading: sc.heading.slice(0, 200), location: sc.location, locationId: set?.id,
        timeOfDay: sc.timeOfDay, summary: sc.summary, beats: (sc.beats ?? []) as never, targetDurationSec: sc.targetSec!,
      },
    });
    const sceneSec = sc.targetSec!;
    const minShots = Math.max(1, Math.ceil(sceneSec / SHOT_MAX));
    const maxShots = Math.max(minShots, Math.floor(sceneSec / SHOT_MIN));
    let shots: ShotJson[];
    if (llm) {
      const boardMsgs: ChatMessage[] = [
          { role: "system", content: WRITER_SYSTEM },
          {
            role: "user",
            content: `${text}\n\nSequence "${seq.title}": ${seq.summary}\n${lastShots ? `Previous shots: ${lastShots}\n` : `${before}\n`}
Board this scene: ${sc.heading} — ${sc.summary}\nBeats: ${(sc.beats ?? []).join(" / ")}
Screen time for this scene: ${Math.round(sceneSec)} seconds. You decide how many shots it needs (between ${minShots} and ${maxShots}) and how long each one runs, from 3 to 15 seconds, based on the story: quick 3–4 s cuts for action, tension and reactions; 5–8 s for dialogue and coverage; 9–15 s holds for establishing shots, emotional beats, reveals and continuous camera moves. Pacing for this ${project.format}: ${st.pace}. The shot durations should add up to about ${Math.round(sceneSec)} s.
Rules: name every character in frame in "characters" (exact cast names). "prompt" is a single image prompt for the storyboard frame (subject, action, framing, set, light). "motionPrompt" says how the shot moves (camera and action) for video. Vary framing (wide, medium, close-up, inserts) like a real edit; cut on action. Set "continuous": true when a shot must continue the previous one without a cut in time.
JSON: {"shots":[{"title":"","description":"","prompt":"","motionPrompt":"","shotType":"EXTREME_WIDE|WIDE|FULL|MEDIUM|MEDIUM_CLOSE|CLOSE_UP|EXTREME_CLOSE_UP|OVER_SHOULDER|POV|INSERT|AERIAL","cameraMove":"static|pushIn|pullOut|panLeft|panRight|tiltUp|tiltDown|truckLeft|truckRight|craneUp|craneDown|orbitLeft|orbitRight|handheld|whipPan|fpvDrone","durationSec":6,"dialogue":"","speaker":"","characters":[],"props":[],"continuous":false}]}`,
          },
      ];
      const r = await chatJson<{ shots: ShotJson[] }>(boardMsgs, { agent: "DIRECTOR", temperature: 0.6 });
      shots = r.shots ?? [];
      // Too few shots can't fill the scene even at 15 s each: ask once more for a fuller board.
      if (shots.length < minShots) {
        const again = await chatJson<{ shots: ShotJson[] }>(
          [...boardMsgs, { role: "assistant", content: JSON.stringify({ shots }) }, { role: "user", content: `That is ${shots.length} shot(s); the scene runs ${Math.round(sceneSec)} s and no shot may be longer than 15 s. Board it again with at least ${minShots} shots, same JSON.` }],
          { agent: "DIRECTOR", temperature: 0.6 },
        ).catch(() => null);
        if ((again?.shots?.length ?? 0) > shots.length) shots = again!.shots;
      }
    } else {
      const cast = (sc.characters ?? chars.slice(0, 2).map((c) => c.name)).filter(Boolean);
      const types = ["WIDE", "MEDIUM", "CLOSE_UP", "OVER_SHOULDER", "INSERT", "MEDIUM_CLOSE"];
      const n = Math.min(maxShots, Math.max(minShots, Math.round(sceneSec / st.typicalShot)));
      shots = Array.from({ length: n }, (_, i) => ({
        title: `${sc.heading.split(" — ")[0]} · ${i + 1}`,
        description: `${sc.summary} (${types[i % types.length].toLowerCase().replace("_", " ")})`,
        shotType: types[i % types.length],
        cameraMove: i === 0 ? "pushIn" : "static",
        durationSec: SKELETON_PACE[types[i % types.length]] ?? 6,
        characters: i === 0 || i % 2 ? cast : cast.slice(0, 1),
      }));
    }
    const lengths = fitDurations(shots.map((sh) => Number(sh.durationSec)), sceneSec);
    let order = 0;
    for (const [k, sh] of shots.entries()) {
      const linked = (sh.characters ?? []).map((n) => byName.get(String(n).toLowerCase())).filter(Boolean);
      const propIds = (sh.props ?? []).map((n) => props.find((p) => p.name.toLowerCase() === String(n).toLowerCase())?.id).filter((x): x is string => !!x);
      await db.shot.create({
        data: {
          projectId: project.id, sceneId: scene.id, order: seq.index * 100000 + si * 1000 + order++,
          title: (sh.title || sh.description || "Shot").slice(0, 120), description: sh.description ?? "", prompt: sh.prompt ?? "", motionPrompt: sh.motionPrompt ?? "",
          shotType: sh.shotType, cameraMove: sh.cameraMove, durationSec: lengths[k],
          dialogue: sh.dialogue || null, speaker: sh.speaker || null, continuity: sh.continuous ? "continuous" : "cut",
          characters: { create: linked.map((c) => ({ characterId: c!.id })) },
          elements: { create: propIds.map((elementId) => ({ elementId })) },
        },
      });
    }
    lastShots = shots.slice(-2).map((s) => s.description).join(" / ");
  }
  await renumber(project.id);
  await db.sequence.update({ where: { id: seq.id }, data: { status: "written" } });
  await db.project.update({ where: { id: project.id }, data: { stage: "STORYBOARD" } });
  publish(project.id, { type: "refresh", scope: "all" });
  return { scenes: scenes.length, method: llm ? "ai" : "skeleton" };
}

/** Keeps scene.index and shot.order dense and in story order (sequence → scene → shot). */
export async function renumber(projectId: string) {
  const scenes = await db.scene.findMany({ where: { projectId }, include: { sequence: { select: { index: true } }, shots: { select: { id: true, order: true } } } });
  scenes.sort((a, b) => (a.sequence?.index ?? 1e9) - (b.sequence?.index ?? 1e9) || a.index - b.index);
  let order = 0;
  const loose = await db.shot.findMany({ where: { projectId, sceneId: null }, select: { id: true, order: true } });
  const ops = [];
  for (const [i, sc] of scenes.entries()) {
    if (sc.index !== i) ops.push(db.scene.update({ where: { id: sc.id }, data: { index: i } }));
    for (const sh of [...sc.shots].sort((a, b) => a.order - b.order)) {
      if (sh.order !== order) ops.push(db.shot.update({ where: { id: sh.id }, data: { order } }));
      order++;
    }
  }
  for (const sh of loose.sort((a, b) => a.order - b.order)) ops.push(db.shot.update({ where: { id: sh.id }, data: { order: order++ } }));
  for (let i = 0; i < ops.length; i += 200) await db.$transaction(ops.slice(i, i + 200));
}

/**
 * After importing a long script, groups its scenes into sequences (~4 scenes or ~3.5 minutes each),
 * so a feature imported from PDF gets the same act/sequence board as a written one.
 */
export async function autoSequences(projectId: string) {
  const scenes = await db.scene.findMany({ where: { projectId }, orderBy: { index: "asc" }, include: { shots: { select: { durationSec: true } } } });
  if (scenes.length < 6 || scenes.some((s) => s.sequenceId)) return 0;
  await db.sequence.deleteMany({ where: { projectId } });
  const total = scenes.reduce((a, s) => a + s.shots.reduce((x, y) => x + y.durationSec, 0), 0);
  const groups: (typeof scenes)[] = [];
  let cur: typeof scenes = [];
  let dur = 0;
  for (const s of scenes) {
    cur.push(s);
    dur += s.shots.reduce((x, y) => x + y.durationSec, 0);
    if (cur.length >= 4 || dur >= 210) {
      groups.push(cur);
      cur = [];
      dur = 0;
    }
  }
  if (cur.length) groups.push(cur);
  let elapsed = 0;
  for (const [i, g] of groups.entries()) {
    const gd = g.reduce((a, s) => a + s.shots.reduce((x, y) => x + y.durationSec, 0), 0);
    const act = total > 0 ? (elapsed / total < 0.25 ? 1 : elapsed / total < 0.75 ? 2 : 3) : 1;
    elapsed += gd;
    const seq = await db.sequence.create({
      data: { projectId, index: i, act, title: g[0].heading.slice(0, 80), summary: g.map((s) => s.summary).filter(Boolean).join(" ").slice(0, 400), targetDurationSec: gd, status: "written", color: SEQ_COLORS[i % SEQ_COLORS.length] },
    });
    await db.scene.updateMany({ where: { id: { in: g.map((s) => s.id) } }, data: { sequenceId: seq.id } });
  }
  return groups.length;
}

/** Imported scripts: turn scene headings ("INT. KITCHEN - NIGHT") into film sets so recurring places share references. */
export async function linkLocations(projectId: string) {
  const scenes = await db.scene.findMany({ where: { projectId, locationId: null }, select: { id: true, heading: true } });
  let linked = 0;
  for (const s of scenes) {
    const name = s.heading
      .replace(/^\s*(\d+\.?\s*)?(INT\.?\/EXT\.?|EXT\.?\/INT\.?|INT\.?|EXT\.?|I\/E\.?)\s*/i, "")
      .split(/\s+[-–—]\s+/)[0]
      .trim();
    if (!name || name.length > 60) continue;
    const pretty = name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    const el = await db.element.upsert({
      where: { projectId_kind_name: { projectId, kind: "location", name: pretty } },
      create: { projectId, kind: "location", name: pretty, handle: handleOf(pretty), description: "" },
      update: {},
    });
    await db.scene.update({ where: { id: s.id }, data: { locationId: el.id } });
    linked++;
  }
  return linked;
}

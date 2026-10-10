import { db } from "../db";
import { publish } from "../events";
import { chatJson, isLlmConfigured } from "../llm";
import { memoryPrompt } from "../memory";
import { logActivity } from "../activity";

/**
 * Story score: before a film is produced, the Script Doctor rates the idea / outline / script out of 10.
 *  - below 6   → the user is asked to change the story before anything is written or generated
 *  - 6 to 8.5  → "Improve" rewrites the treatment, re-scoring each round, until it reaches 8.5
 *  - 8.5+      → ready for full autopilot
 */
export const SCORE_BLOCK = 6;
export const SCORE_READY = 8.5;

export const CRITERIA = [
  { id: "premise", name: "Premise & hook", weight: 1.2 },
  { id: "structure", name: "Structure & pacing", weight: 1.2 },
  { id: "characters", name: "Characters & arcs", weight: 1.1 },
  { id: "conflict", name: "Conflict & stakes", weight: 1.1 },
  { id: "visual", name: "Visual storytelling (filmable by AI)", weight: 1 },
  { id: "emotion", name: "Emotional impact", weight: 1 },
  { id: "originality", name: "Originality", weight: 0.9 },
  { id: "fit", name: "Fits the runtime & format", weight: 0.8 },
  { id: "consistency", name: "Clarity & consistency", weight: 0.7 },
] as const;

export interface StoryScore {
  score: number;
  verdict: "rework" | "improve" | "ready";
  breakdown: { criterion: string; name: string; score: number; note: string }[];
  strengths: string[];
  fixes: string[];
  summary: string;
  source: "idea" | "outline" | "script";
  method: "ai" | "estimate";
  at: string;
  rounds?: number;
  history?: { score: number; at: string; synopsis?: string | null }[];
}

export function verdictFor(score: number): StoryScore["verdict"] {
  return score < SCORE_BLOCK ? "rework" : score < SCORE_READY ? "improve" : "ready";
}

const DOCTOR = `You are the SCRIPT DOCTOR of an AI film studio: a senior story editor who has developed hundreds of films.
You judge stories honestly and specifically. You never inflate scores: 5 is an average amateur idea, 7 is solid professional work,
8.5 is a strong, distinctive, producible film, 9.5+ is exceptional. Every fix must be concrete and actionable. Reply with JSON only.`;

/** Everything the writer has so far, from the one-line idea to the full outline and script. */
async function storyText(projectId: string) {
  const p = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { sequences: { orderBy: { index: "asc" } }, characters: true },
  });
  const source: StoryScore["source"] = p.scriptText?.trim() ? "script" : p.sequences.length ? "outline" : "idea";
  const parts = [
    `Title: ${p.title}`,
    `Format: ${p.format} · runtime ${Math.round(p.targetRuntimeSec / 60)} min (${p.targetRuntimeSec}s) · language ${p.language}`,
    p.logline && `Logline: ${p.logline}`,
    p.synopsis && `Story / synopsis:\n${p.synopsis}`,
    p.brief && `The filmmaker's brief to the crew:\n${p.brief}`,
    p.characters.length && `Characters:\n${p.characters.map((c) => `- ${c.name} (${c.role}): ${c.description}`).join("\n")}`,
    p.sequences.length && `Outline:\n${p.sequences.map((s) => `${s.index + 1}. [Act ${s.act}, ${Math.round(s.targetDurationSec)}s] ${s.title}: ${s.summary}`).join("\n")}`,
    p.scriptText?.trim() && `Script (excerpt):\n${p.scriptText.slice(0, 12000)}`,
  ].filter(Boolean);
  return { project: p, source, text: parts.join("\n\n") };
}

function weighted(breakdown: { criterion: string; score: number }[]) {
  let sum = 0;
  let w = 0;
  for (const c of CRITERIA) {
    const b = breakdown.find((x) => x.criterion === c.id);
    if (!b) continue;
    sum += Math.min(10, Math.max(0, Number(b.score) || 0)) * c.weight;
    w += c.weight;
  }
  return w ? Math.round((sum / w) * 10) / 10 : 0;
}

/** Offline estimate when no AI is configured: rewards a developed, specific story with people, conflict and an ending. */
function estimate(text: string, source: StoryScore["source"]): Omit<StoryScore, "at" | "verdict"> {
  const words = text.split(/\s+/).length;
  const has = (re: RegExp) => re.test(text);
  const b = (criterion: string, score: number, note: string) => ({ criterion, name: CRITERIA.find((c) => c.id === criterion)!.name, score, note });
  const breakdown = [
    b("premise", words > 40 ? 7 : words > 15 ? 5.5 : 4, words > 40 ? "There is a clear idea." : "The idea is only a line; say who wants what and why it matters."),
    b("structure", source !== "idea" ? 7 : has(/\b(then|until|finally|ends?|after)\b/i) ? 6 : 4.5, "Give it a beginning, a turn and an ending."),
    b("characters", has(/\b[A-Z][a-z]+\b.*\b(wants?|needs?|must|fears?)\b/) ? 7 : 5, "Name the hero and what they want."),
    b("conflict", has(/\b(but|against|threat|storm|fight|lose|risk|enemy|chase|danger|must)\b/i) ? 7 : 4.5, "What stands in the way, and what is lost if they fail?"),
    b("visual", has(/\b(light|night|rain|sea|city|fire|desert|forest|storm|street|room)\b/i) ? 7.5 : 5.5, "Anchor scenes in vivid places."),
    b("emotion", has(/\b(love|grief|hope|fear|joy|loss|lonely|reunite|sacrifice)\b/i) ? 7 : 5, "Name the feeling the audience should leave with."),
    b("originality", 6, "Add a specific twist only this film has."),
    b("fit", 7, "Scope looks right for the runtime."),
    b("consistency", 7, "Clear enough to produce."),
  ];
  return {
    score: weighted(breakdown),
    breakdown,
    strengths: breakdown.filter((x) => x.score >= 7).map((x) => x.name),
    fixes: breakdown.filter((x) => x.score < 7).map((x) => x.note),
    summary: "Estimated without an AI model (add one in Settings for a real story review).",
    source,
    method: "estimate",
  };
}

async function save(projectId: string, s: StoryScore) {
  await db.project.update({ where: { id: projectId }, data: { storyScore: s as never } });
  publish(projectId, { type: "refresh", scope: "project" });
}

export async function scoreStory(projectId: string, opts: { round?: number; history?: StoryScore["history"] } = {}): Promise<StoryScore> {
  const { project, source, text } = await storyText(projectId);
  if (!project.synopsis?.trim() && !project.logline?.trim() && source === "idea") throw new Error("Add your story idea first, then the Script Doctor can score it.");
  let r: Omit<StoryScore, "at" | "verdict">;
  if (await isLlmConfigured()) {
    const out = await chatJson<{ breakdown: { criterion: string; score: number; note: string }[]; strengths: string[]; fixes: string[]; summary: string }>(
      [
        { role: "system", content: DOCTOR },
        {
          role: "user",
          content: `${await memoryPrompt(projectId, 2000)}\n\nScore this ${source} out of 10 on each criterion:\n${CRITERIA.map((c) => `- ${c.id}: ${c.name}`).join("\n")}\n\n${text}\n\nJSON: {"breakdown":[{"criterion":"premise","score":7.5,"note":"one sentence: why, and what would raise it"}],"strengths":["..."],"fixes":["concrete change 1","..."],"summary":"2 sentences for the filmmaker"}`,
        },
      ],
      { agent: "WRITER", temperature: 0.2 },
    );
    const breakdown = CRITERIA.map((c) => {
      const b = (out.breakdown ?? []).find((x) => x.criterion === c.id || x.criterion?.toLowerCase() === c.name.toLowerCase());
      return { criterion: c.id, name: c.name, score: Math.min(10, Math.max(0, Number(b?.score) || 0)), note: String(b?.note ?? "") };
    }).filter((b) => b.score > 0);
    r = { score: weighted(breakdown), breakdown, strengths: out.strengths ?? [], fixes: out.fixes ?? [], summary: out.summary ?? "", source, method: "ai" };
  } else {
    r = estimate(text, source);
  }
  const s: StoryScore = { ...r, verdict: verdictFor(r.score), at: new Date().toISOString(), rounds: opts.round, history: [...(opts.history ?? []), { score: r.score, at: new Date().toISOString(), synopsis: project.synopsis }].slice(-8) };
  await save(projectId, s);
  await logActivity(projectId, {
    kind: "agent",
    level: s.verdict === "rework" ? "warn" : s.verdict === "ready" ? "success" : "info",
    actor: "Script Doctor",
    message: `Story scored ${s.score.toFixed(1)}/10 (${s.verdict === "rework" ? "needs your changes" : s.verdict === "ready" ? "ready for autopilot" : "can be improved"})`,
    data: { breakdown: s.breakdown, fixes: s.fixes },
  });
  return s;
}

/**
 * Rewrites the treatment (logline + synopsis) round by round until it scores 8.5+ (or rounds run out).
 * Keeps the filmmaker's idea, characters and brief; only the craft improves. An existing outline is
 * marked for rewriting so the improved story reaches the board.
 */
export async function improveStory(projectId: string, opts: { target?: number; maxRounds?: number; onProgress?: (pct: number, step: string) => void | Promise<void> } = {}) {
  const target = opts.target ?? SCORE_READY;
  const maxRounds = opts.maxRounds ?? 4;
  let s = ((await db.project.findUniqueOrThrow({ where: { id: projectId } })).storyScore as unknown as StoryScore | null) ?? (await scoreStory(projectId));
  let round = 0;
  while (s.score < target && round < maxRounds) {
    round++;
    await opts.onProgress?.(Math.round((round / (maxRounds + 1)) * 90), `Round ${round}: rewriting the story to fix ${s.fixes.length} issue(s) (now ${s.score.toFixed(1)}/10)`);
    if (!(await isLlmConfigured())) break;
    const { project, text } = await storyText(projectId);
    const out = await chatJson<{ title?: string; logline: string; synopsis: string; changes: string[] }>(
      [
        { role: "system", content: DOCTOR },
        {
          role: "user",
          content: `${await memoryPrompt(projectId, 2000)}\n\n${text}\n\nCurrent score ${s.score.toFixed(1)}/10. Weak points:\n${s.breakdown.filter((b) => b.score < target).map((b) => `- ${b.name} ${b.score}: ${b.note}`).join("\n")}\nFixes to apply:\n${s.fixes.map((f) => `- ${f}`).join("\n")}

Rewrite the logline and synopsis (a full treatment: beginning, middle, end, with the turning points) so the story scores ${target}+ on every criterion.
Keep the filmmaker's core idea, setting, named characters and everything in their brief and memory. Make it fit ${Math.round(project.targetRuntimeSec / 60)} minutes and be filmable shot by shot.
JSON: {"logline":"","synopsis":"","changes":["what you changed and why"]}`,
        },
      ],
      { agent: "WRITER", temperature: 0.6 },
    );
    if (!out.synopsis?.trim()) break;
    await db.project.update({ where: { id: projectId }, data: { synopsis: out.synopsis.trim(), logline: out.logline?.trim() || project.logline } });
    await logActivity(projectId, { kind: "agent", actor: "Script Doctor", message: `Round ${round}: rewrote the story`, data: { changes: out.changes } });
    s = await scoreStory(projectId, { round, history: s.history });
  }
  if (round && (await db.sequence.count({ where: { projectId } }))) {
    await logActivity(projectId, { kind: "system", level: "warn", actor: "Script Doctor", message: "The story changed after the outline was written; rewrite the film to use the improved story." });
  }
  return s;
}

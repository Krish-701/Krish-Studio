import type { ModelInfo, RefType } from "./generation/catalog";
import type { RefImage } from "./generation/types";

/**
 * Reference planner. Given what a shot has (storyboard frame, cast with turnaround sheets and wardrobe looks,
 * the film set, props, style images and videos, colour palette, motion and audio references) and what the chosen
 * model accepts (types, per-type limits, whether keyframes exclude references), it decides exactly which
 * references go into the call, in priority order, and explains anything it had to leave out.
 *
 * The same plan is shown in the shot editor ("References this prompt attaches") and sent to the provider.
 */

export type RefRole = "frame" | "end_frame" | "previous" | "character" | "sheet" | "location" | "environment" | "prop" | "mood" | "style" | "style_video" | "palette" | "motion" | "audio";

export interface Candidate {
  role: RefRole;
  ref: RefImage;
  /** Character / element this ref belongs to (round-robin so everyone gets a slot). */
  owner?: string;
}

export interface PlanInput {
  kind: "image" | "video";
  /** auto | frame | reference | text */
  mode?: string;
  /** Start from the previous shot's last frame (continuity "continuous"). */
  continuous?: boolean;
  candidates: Candidate[];
}

export interface RefPlan {
  mode: "frame" | "reference" | "text";
  start?: RefImage | null;
  end?: RefImage | null;
  refs: RefImage[];
  dropped: { label: string; reason: string }[];
  /** Lines added to the prompt so the model knows what each reference is. */
  promptNotes: string[];
}

/** Which reference types to try for each role, best first. */
const ROLE_TYPES: Record<RefRole, RefType[]> = {
  frame: ["image"],
  end_frame: ["image"],
  previous: ["image"],
  character: ["character", "image"],
  sheet: ["character", "image"],
  location: ["image"],
  environment: ["image"],
  prop: ["product", "image"],
  mood: ["style", "color", "image"],
  style: ["style", "image"],
  style_video: ["video"],
  palette: ["color", "style"],
  motion: ["video"],
  audio: ["audio"],
};

/** Order references are filled in: composition, identity, place, look, motion, sound. */
const ROLE_ORDER: RefRole[] = ["frame", "previous", "character", "sheet", "location", "environment", "prop", "style", "palette", "mood", "style_video", "motion", "audio"];

/** Roles that are interleaved by owner, so every character / set / environment / prop gets a slot. */
const SHARED_ROLES: RefRole[] = ["character", "sheet", "location", "environment", "prop"];

const ROLE_WORD: Record<RefRole, string> = {
  frame: "storyboard frame (composition)",
  end_frame: "end frame",
  previous: "previous shot's last frame (continuity)",
  character: "character",
  sheet: "character turnaround sheet",
  location: "film set",
  environment: "environment",
  prop: "prop",
  mood: "colour & mood board",
  style: "style",
  style_video: "style video",
  palette: "colour palette",
  motion: "motion reference",
  audio: "audio reference",
};

function totalCapacity(model: ModelInfo) {
  return Object.values(model.refLimits).reduce((a, b) => a + (b ?? 0), 0);
}

/** Interleaves candidates by owner: everyone's first ref, then everyone's second, ... */
function roundRobin(list: Candidate[]) {
  const byOwner = new Map<string, Candidate[]>();
  for (const c of list) {
    const k = c.owner ?? c.ref.label ?? "";
    byOwner.set(k, [...(byOwner.get(k) ?? []), c]);
  }
  const out: Candidate[] = [];
  for (let i = 0; out.length < list.length; i++) for (const arr of byOwner.values()) if (arr[i]) out.push(arr[i]);
  return out;
}

export function planReferences(model: ModelInfo, input: PlanInput): RefPlan {
  const dropped: RefPlan["dropped"] = [];
  const of = (role: RefRole) => input.candidates.filter((c) => c.role === role);
  const frame = of("frame")[0]?.ref ?? null;
  const prev = of("previous")[0]?.ref ?? null;
  const endFrame = of("end_frame")[0]?.ref ?? null;
  const identity = input.candidates.some((c) => ["character", "sheet", "location", "environment", "prop"].includes(c.role));
  const canRef = totalCapacity(model) > 0;

  let mode: RefPlan["mode"];
  const want = input.mode ?? "auto";
  if (input.kind === "image") mode = "reference";
  else if (want === "text") mode = "text";
  else if (want === "frame") mode = model.startFrame && (frame || prev) ? "frame" : canRef ? "reference" : "text";
  else if (want === "reference") mode = canRef ? "reference" : model.startFrame && frame ? "frame" : "text";
  else if (input.continuous && prev && model.startFrame) mode = "frame";
  else if (model.keyframesExclusive && canRef && identity) mode = "reference";
  else if (frame && model.startFrame) mode = "frame";
  else if (canRef && (identity || frame)) mode = "reference";
  else mode = "text";

  const plan: RefPlan = { mode, refs: [], dropped, promptNotes: [] };
  if (mode === "frame") {
    plan.start = input.continuous && prev ? prev : frame ?? prev;
    if (endFrame && model.endFrame) plan.end = endFrame;
    else if (endFrame) dropped.push({ label: endFrame.label ?? "end frame", reason: `${model.name} has no end frame` });
  }

  // References: skipped in text mode, and in frame mode when the model can't combine them with keyframes.
  const refsAllowed = mode === "reference" || (mode === "frame" && !model.keyframesExclusive);
  const used: Partial<Record<RefType, number>> = {};
  const max = model.maxRefs ?? totalCapacity(model);
  const pool: Candidate[] = [];
  for (const role of ROLE_ORDER) {
    let list = of(role);
    // In frame mode the start image is already the frame; don't send it twice.
    if (mode === "frame" && (role === "frame" || role === "previous")) list = list.filter((c) => c.ref !== plan.start);
    if (mode === "reference" && role === "previous" && !input.continuous) list = [];
    pool.push(...(SHARED_ROLES.includes(role) ? roundRobin(list) : list));
  }

  // The film's colour & mood board comes last but keeps one slot free for itself when the model can take it,
  // so a cast that fills every slot can't push the look of the film out.
  const moodFits = (c: Candidate) => ROLE_TYPES.mood.some((t) => (model.refLimits[t] ?? 0) > 0 && (c.ref.media ?? "image") === "image");
  let reserve = refsAllowed && pool.some((c) => c.role === "mood" && moodFits(c)) ? 1 : 0;

  // Characters come first, but several characters with many angles each could fill every slot. Keep room for
  // the set (2), an environment (1) and a prop (1) when the shot has them; each character still gets 2+ refs.
  const owners = (roles: RefRole[]) => new Set(pool.filter((c) => roles.includes(c.role)).map((c) => c.owner ?? c.ref.label ?? "")).size;
  const sceneNeed = Math.min(2, of("location").length) + Math.min(1, of("environment").length) + Math.min(1, of("prop").length);
  const castCap = Math.max(owners(["character", "sheet"]) * 2, max - reserve - sceneNeed);
  let cast = 0;
  // Likewise the set keeps to 2 plates when an environment or prop also needs a slot.
  const setCap = of("environment").length || of("prop").length ? 2 : Infinity;
  let sets = 0;
  for (const c of pool) {
    const label = c.ref.label ?? ROLE_WORD[c.role];
    if (refsAllowed && (c.role === "character" || c.role === "sheet") && cast >= castCap) {
      dropped.push({ label, reason: "kept slots for the set, environment and props" });
      continue;
    }
    if (refsAllowed && c.role === "location" && sets >= setCap) {
      dropped.push({ label, reason: "kept slots for the environment and props" });
      continue;
    }
    if (!refsAllowed) {
      if (mode !== "text" || canRef) dropped.push({ label, reason: mode === "frame" ? `${model.name} can't combine references with a start frame` : "text-only generation" });
      else dropped.push({ label, reason: `${model.name} takes no references` });
      continue;
    }
    const media = c.ref.media ?? "image";
    const type = ROLE_TYPES[c.role].find((t) => {
      if ((model.refLimits[t] ?? 0) <= (used[t] ?? 0)) return false;
      if (t === "video") return media === "video";
      if (t === "audio") return media === "audio";
      return media === "image";
    });
    if (!type) {
      const supported = ROLE_TYPES[c.role].some((t) => model.refLimits[t]);
      dropped.push({ label, reason: supported ? `limit reached for this model` : `${model.name} doesn't take ${ROLE_WORD[c.role]} references` });
      continue;
    }
    if (plan.refs.length >= max - (c.role === "mood" ? 0 : reserve)) {
      dropped.push({ label, reason: `${model.name} takes at most ${max} references` });
      continue;
    }
    used[type] = (used[type] ?? 0) + 1;
    if (c.role === "character" || c.role === "sheet") cast++;
    if (c.role === "location") sets++;
    plan.refs.push({ ...c.ref, type });
    if (c.role === "mood") reserve = 0;
  }

  // Tell the model what each reference is, in order.
  if (plan.refs.length) {
    plan.promptNotes.push(
      "References: " +
        plan.refs
          .map((r, i) => {
            const c = pool.find((p) => p.ref.assetId === r.assetId && p.ref.label === r.label);
            return `${r.media === "video" ? "video" : r.media === "audio" ? "audio" : "image"} ${i + 1} = ${r.label ?? ROLE_WORD[c?.role ?? "style"]}`;
          })
          .join("; ") +
        ". Keep every character's face, hair, build and wardrobe identical to their references, and the set's layout and props as shown." +
        (pool.some((c) => c.role === "mood" && plan.refs.some((r) => r.assetId === c.ref.assetId)) ? " Match the colour & mood board's palette, lighting and texture (it shows the look only, not content)." : ""),
    );
  }
  if (plan.start && input.continuous && plan.start === prev) plan.promptNotes.push("Continue seamlessly from the first frame: same positions, lighting and wardrobe.");
  return plan;
}

/** Short human summary, e.g. "Reference mode · 6 refs (3 character, 2 image, 1 style) · 2 left out". */
export function describePlan(plan: RefPlan) {
  const counts: Record<string, number> = {};
  for (const r of plan.refs) counts[r.type] = (counts[r.type] ?? 0) + 1;
  const parts = Object.entries(counts).map(([t, n]) => `${n} ${t}`);
  const head = plan.mode === "frame" ? `Start frame${plan.end ? " + end frame" : ""}` : plan.mode === "reference" ? "Reference mode" : "Text only";
  return [head, plan.refs.length ? `${plan.refs.length} refs (${parts.join(", ")})` : "", plan.dropped.length ? `${plan.dropped.length} left out` : ""].filter(Boolean).join(" · ");
}

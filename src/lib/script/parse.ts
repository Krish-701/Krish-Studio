import { chatJson, llmConfig } from "../llm";

export interface ParsedShot {
  title: string;
  description: string;
  shotType?: string;
  cameraMove?: string;
  durationSec?: number;
  dialogue?: string;
  speaker?: string;
  characters: string[];
  prompt?: string;
}

export interface ParsedScene {
  heading: string;
  location?: string;
  timeOfDay?: string;
  summary?: string;
  shots: ParsedShot[];
}

export interface ParsedScript {
  title?: string;
  logline?: string;
  characters: { name: string; description: string }[];
  scenes: ParsedScene[];
  method: "ai" | "heuristic";
}

const HEADING = /^\s*(?:\d+[A-Z]?\s*[.)]?\s*)?((?:INT|EXT|EST|INT\.?\s*\/\s*EXT|I\/E)[.\s][^\n]*)$/i;
const ALT_HEADING = /^\s*(SCENE\s+\d+[^\n]*|CHAPTER\s+[\w\d]+[^\n]*)$/i;
const TRANSITION = /^\s*(FADE (IN|OUT|TO)[^\n]*|CUT TO:?|DISSOLVE TO:?|SMASH CUT[^\n]*|MATCH CUT[^\n]*|THE END)\s*$/i;
const CUE = /^\s*([A-Z][A-Z0-9 .'\-]{1,30}?)(\s*\((?:V\.?O\.?|O\.?S\.?|O\.?C\.?|CONT'?D|CONT)\))*\s*$/;
const PAREN = /^\s*\(.*\)\s*$/;

function cleanName(s: string) {
  return s.replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
}

function titleCase(s: string) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function splitHeading(h: string) {
  const body = h.replace(/^\s*(?:\d+[A-Z]?\s*[.)]?\s*)?/, "").trim();
  const m = body.match(/^(INT\.?\s*\/\s*EXT\.?|I\/E\.?|INT\.?|EXT\.?|EST\.?)\s*(.*?)(?:\s+[-–—]\s+(.*))?$/i);
  if (!m) return { location: body, timeOfDay: undefined };
  return { location: titleCase(m[2] || ""), timeOfDay: m[3] ? titleCase(m[3]) : undefined };
}

function sentences(p: string) {
  return p.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [p];
}

function guessShotType(text: string, hasDialogue: boolean) {
  const t = text.toLowerCase();
  if (/\b(close on|close-up|closeup|we see (his|her|their) (eyes|face|hand))\b/.test(t)) return "CLOSE_UP";
  if (/\b(insert|detail)\b/.test(t)) return "INSERT";
  if (/\b(aerial|bird'?s[- ]eye|overhead|drone)\b/.test(t)) return "AERIAL";
  if (/\b(pov|point of view)\b/.test(t)) return "POV";
  if (/\b(establishing|skyline|landscape|city|horizon|vast)\b/.test(t)) return "EXTREME_WIDE";
  if (hasDialogue) return "MEDIUM_CLOSE";
  return "WIDE";
}

function guessMove(text: string) {
  const t = text.toLowerCase();
  if (/\b(runs?|chases?|races?|sprints?|flees?)\b/.test(t)) return "handheld";
  if (/\b(approach|walks? toward|moves? closer|leans? in)\b/.test(t)) return "pushIn";
  if (/\b(reveal|turns? to see)\b/.test(t)) return "orbitRight";
  if (/\b(rises?|ascends?|climbs?)\b/.test(t)) return "craneUp";
  return "static";
}

/** Rule-based parser for screenplay formatting (Fountain/PDF exports) with a prose fallback. */
export function heuristicParse(raw: string): ParsedScript {
  const text = raw.replace(/\t/g, "    ").replace(/ /g, " ");
  const lines = text.split("\n");
  const isScreenplay = lines.filter((l) => HEADING.test(l)).length >= 1;

  const scenes: ParsedScene[] = [];
  const charCount = new Map<string, number>();
  const charDesc = new Map<string, string>();
  let scene: ParsedScene | null = null;
  const knownNames = new Set<string>();

  const ensureScene = () => {
    if (!scene) {
      scene = { heading: "OPENING", shots: [] };
      scenes.push(scene);
    }
    return scene;
  };

  const addAction = (para: string) => {
    const s = ensureScene();
    const sents = sentences(para.replace(/\s+/g, " ").trim());
    // ~2 sentences per shot keeps shots short and visual.
    for (let i = 0; i < sents.length; i += 2) {
      const chunk = sents.slice(i, i + 2).join(" ");
      if (chunk.length < 3) continue;
      const chars = [...knownNames].filter((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(chunk));
      // Character introductions: "JOHN (40s), weathered..." → description
      for (const m of chunk.matchAll(/\b([A-Z][A-Z]{2,}(?: [A-Z]{2,})?)\s*\(([^)]*\d[^)]*)\)\s*,?\s*([^.]*)/g)) {
        const n = titleCase(m[1]);
        knownNames.add(n);
        if (!charDesc.has(n)) charDesc.set(n, `${m[2]}${m[3] ? ", " + m[3] : ""}`.trim());
        if (!chars.includes(n)) chars.push(n);
      }
      s.shots.push({
        title: chunk.split(/[,.;:]/)[0].slice(0, 60),
        description: chunk,
        shotType: guessShotType(chunk, false),
        cameraMove: guessMove(chunk),
        durationSec: Math.min(8, Math.max(3, Math.round(chunk.split(" ").length / 4))),
        characters: chars,
      });
    }
  };

  if (isScreenplay) {
    let i = 0;
    let para: string[] = [];
    const flush = () => {
      if (para.length) addAction(para.join(" "));
      para = [];
    };
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) {
        flush();
        i++;
        continue;
      }
      if (!scene && !HEADING.test(trimmed)) {
        // Title page / front matter before the first scene heading.
        i++;
        continue;
      }
      if (HEADING.test(trimmed)) {
        flush();
        const { location, timeOfDay } = splitHeading(trimmed);
        scene = { heading: trimmed.replace(/^\d+[A-Z]?\s*[.)]?\s*/, "").replace(/\s+\d+[A-Z]?\s*$/, "").toUpperCase(), location, timeOfDay, shots: [] };
        scenes.push(scene);
        i++;
        continue;
      }
      if (TRANSITION.test(trimmed)) {
        flush();
        i++;
        continue;
      }
      const next = lines[i + 1]?.trim() ?? "";
      if (CUE.test(trimmed) && trimmed === trimmed.toUpperCase() && next && !HEADING.test(next) && trimmed.split(" ").length <= 4 && /[A-Z]/.test(trimmed)) {
        flush();
        const name = titleCase(cleanName(trimmed));
        knownNames.add(name);
        charCount.set(name, (charCount.get(name) ?? 0) + 1);
        i++;
        const dl: string[] = [];
        let parenthetical = "";
        while (i < lines.length && lines[i].trim()) {
          const l = lines[i].trim();
          if (PAREN.test(l)) parenthetical = l;
          else dl.push(l);
          i++;
        }
        const dialogue = dl.join(" ");
        const s = ensureScene();
        s.shots.push({
          title: `${name}: “${dialogue.slice(0, 40)}${dialogue.length > 40 ? "…" : ""}”`,
          description: `${name} speaks${parenthetical ? " " + parenthetical : ""}.`,
          dialogue,
          speaker: name,
          shotType: "MEDIUM_CLOSE",
          cameraMove: "static",
          durationSec: Math.min(12, Math.max(2, Math.round(dialogue.split(" ").length / 2.5))),
          characters: [name],
        });
        continue;
      }
      para.push(trimmed);
      i++;
    }
    flush();
  } else {
    // Prose / treatment: chapters or blank-line paragraph groups become scenes.
    const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    let n = 0;
    for (const b of blocks) {
      if (ALT_HEADING.test(b.split("\n")[0])) {
        scene = { heading: b.split("\n")[0].trim().toUpperCase(), shots: [] };
        scenes.push(scene);
        const rest = b.split("\n").slice(1).join(" ");
        if (rest) addAction(rest);
        continue;
      }
      if (!scene || scene.shots.length >= 8) {
        n++;
        scene = { heading: `SCENE ${scenes.length + 1}`, shots: [] };
        scenes.push(scene);
      }
      addAction(b);
    }
    // Proper nouns that repeat are likely characters.
    const counts = new Map<string, number>();
    for (const m of text.matchAll(/\b([A-Z][a-z]{2,})\b/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    const stop = new Set(["The", "And", "But", "She", "Her", "His", "They", "Then", "When", "This", "That", "There", "With", "From", "What", "Chapter", "Scene", "Int", "Ext"]);
    for (const [w, c] of counts) if (c >= 3 && !stop.has(w)) charCount.set(w, c);
    for (const s of scenes) for (const sh of s.shots) sh.characters = [...charCount.keys()].filter((c) => sh.description.includes(c));
    void n;
  }

  for (const s of scenes) {
    s.summary = s.shots.slice(0, 3).map((x) => x.dialogue ? `${x.speaker}: ${x.dialogue}` : x.description).join(" ").slice(0, 240);
  }

  const names = new Set([...charCount.keys(), ...knownNames]);
  const characters = [...names]
    .filter((n) => n.length > 1 && !/^(Int|Ext|Fade|Cut|The End|Continued|More)$/i.test(n))
    .map((name) => ({ name, description: charDesc.get(name) ?? "" }));

  return {
    title: lines.find((l) => l.trim())?.trim().slice(0, 80),
    characters,
    scenes: scenes.filter((s) => s.shots.length),
    method: "heuristic",
  };
}

const SYSTEM = `You are a first assistant director and storyboard artist. Break the script into scenes and camera shots for an AI-generated film.
Return ONLY JSON: {"title": string, "logline": string,
 "characters": [{"name": string, "description": "visual description: age, build, face, hair, wardrobe"}],
 "scenes": [{"heading": "INT. LOCATION - TIME", "location": string, "timeOfDay": string, "summary": string,
   "shots": [{"title": "short label", "description": "what happens on screen", "shotType": "EXTREME_WIDE|WIDE|FULL|MEDIUM|MEDIUM_CLOSE|CLOSE_UP|EXTREME_CLOSE_UP|OVER_SHOULDER|POV|INSERT|AERIAL",
     "cameraMove": "static|pushIn|pullOut|panLeft|panRight|tiltUp|tiltDown|truckLeft|truckRight|craneUp|craneDown|orbitLeft|orbitRight|handheld|whipPan|fpvDrone",
     "durationSec": number (2-10), "dialogue": string|null, "speaker": string|null, "characters": [names in frame],
     "prompt": "a vivid, self-contained image-generation prompt for this frame: subject, action, setting, lighting, lens, composition. Refer to characters by name."}]}]}
Rules: 3-10 shots per scene, every dialogue line gets a shot, keep character names consistent, never invent characters not in the script.`;

/** AI breakdown when an LLM is configured; heuristic parse otherwise or on failure. */
export async function parseScript(text: string, onProgress?: (pct: number, step: string) => Promise<void> | void): Promise<ParsedScript> {
  const heuristic = heuristicParse(text);
  if (!(await llmConfig("DIRECTOR"))) return heuristic;

  // Chunk on scene boundaries so long features fit any context window.
  const chunks: string[] = [];
  const parts = text.split(/\n(?=\s*(?:\d+[A-Z]?\s*[.)]?\s*)?(?:INT|EXT|EST|I\/E)[.\s])/i);
  let cur = "";
  for (const p of parts) {
    if ((cur + p).length > 12000 && cur) {
      chunks.push(cur);
      cur = "";
    }
    cur += "\n" + p;
  }
  if (cur.trim()) chunks.push(cur);

  try {
    const out: ParsedScript = { characters: [], scenes: [], method: "ai" };
    const knownChars = new Map<string, string>();
    for (let i = 0; i < chunks.length; i++) {
      await onProgress?.(10 + Math.round((i / chunks.length) * 80), `Director agent breaking down part ${i + 1}/${chunks.length}`);
      const r = await chatJson<ParsedScript>(
        [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: `${knownChars.size ? `Characters already established: ${[...knownChars.keys()].join(", ")}\n\n` : ""}SCRIPT PART ${i + 1}/${chunks.length}:\n${chunks[i]}`,
          },
        ],
        { agent: "DIRECTOR" },
      );
      if (i === 0) {
        out.title = r.title;
        out.logline = r.logline;
      }
      for (const c of r.characters ?? []) if (c?.name && !knownChars.has(c.name)) knownChars.set(c.name, c.description ?? "");
      for (const s of r.scenes ?? []) {
        if (!s?.shots?.length) continue;
        out.scenes.push({ ...s, shots: s.shots.map((sh) => ({ ...sh, characters: sh.characters ?? [] })) });
      }
    }
    out.characters = [...knownChars].map(([name, description]) => ({ name, description }));
    if (!out.scenes.length) return heuristic;
    return out;
  } catch (e) {
    console.warn("[parse] AI breakdown failed, using heuristic parser:", (e as Error).message);
    return { ...heuristic, method: "heuristic" };
  }
}

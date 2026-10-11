import { AsyncLocalStorage } from "async_hooks";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import path from "path";

/**
 * File store used when Postgres is turned off (KRISH_NO_DB=1).
 * One JSON file, same calls the rest of the app already makes on Prisma.
 */

type Row = Record<string, any>;
type Where = Record<string, any>;

interface Rel {
  model: string;
  fk: string;
  /** The foreign key lives on this row (points at the other model). */
  one?: boolean;
}

const REL: Record<string, Record<string, Rel>> = {
  project: {
    sequences: { model: "sequence", fk: "projectId" },
    scenes: { model: "scene", fk: "projectId" },
    shots: { model: "shot", fk: "projectId" },
    characters: { model: "character", fk: "projectId" },
    elements: { model: "element", fk: "projectId" },
    assets: { model: "asset", fk: "projectId" },
    jobs: { model: "job", fk: "projectId" },
    clips: { model: "timelineClip", fk: "projectId" },
    messages: { model: "agentMessage", fk: "projectId" },
    findings: { model: "agentFinding", fk: "projectId" },
    memory: { model: "memoryEntry", fk: "projectId" },
    activity: { model: "activityLog", fk: "projectId" },
  },
  sequence: {
    project: { model: "project", fk: "projectId", one: true },
    scenes: { model: "scene", fk: "sequenceId" },
  },
  scene: {
    project: { model: "project", fk: "projectId", one: true },
    sequence: { model: "sequence", fk: "sequenceId", one: true },
    locationEl: { model: "element", fk: "locationId", one: true },
    shots: { model: "shot", fk: "sceneId" },
  },
  shot: {
    project: { model: "project", fk: "projectId", one: true },
    scene: { model: "scene", fk: "sceneId", one: true },
    characters: { model: "shotCharacter", fk: "shotId" },
    elements: { model: "shotElement", fk: "shotId" },
    assets: { model: "asset", fk: "shotId" },
    jobs: { model: "job", fk: "shotId" },
    findings: { model: "agentFinding", fk: "shotId" },
  },
  character: {
    project: { model: "project", fk: "projectId", one: true },
    references: { model: "asset", fk: "characterId" },
    shots: { model: "shotCharacter", fk: "characterId" },
  },
  shotCharacter: {
    shot: { model: "shot", fk: "shotId", one: true },
    character: { model: "character", fk: "characterId", one: true },
  },
  asset: {
    project: { model: "project", fk: "projectId", one: true },
    character: { model: "character", fk: "characterId", one: true },
    element: { model: "element", fk: "elementId", one: true },
    shot: { model: "shot", fk: "shotId", one: true },
    clips: { model: "timelineClip", fk: "assetId" },
  },
  job: {
    project: { model: "project", fk: "projectId", one: true },
    shot: { model: "shot", fk: "shotId", one: true },
  },
  timelineClip: {
    project: { model: "project", fk: "projectId", one: true },
    asset: { model: "asset", fk: "assetId", one: true },
  },
  agentMessage: { project: { model: "project", fk: "projectId", one: true } },
  agentFinding: {
    project: { model: "project", fk: "projectId", one: true },
    shot: { model: "shot", fk: "shotId", one: true },
  },
  memoryEntry: { project: { model: "project", fk: "projectId", one: true } },
  element: {
    project: { model: "project", fk: "projectId", one: true },
    references: { model: "asset", fk: "elementId" },
    scenes: { model: "scene", fk: "locationId" },
    shots: { model: "shotElement", fk: "elementId" },
  },
  shotElement: {
    shot: { model: "shot", fk: "shotId", one: true },
    element: { model: "element", fk: "elementId", one: true },
  },
  activityLog: { project: { model: "project", fk: "projectId", one: true } },
  appSettings: {},
};

const DEFAULTS: Record<string, Row> = {
  project: { logline: null, stage: "SCRIPT", aspectRatio: "16:9", format: "short", targetRuntimeSec: 60, resolution: "720p", fps: 24, language: "English", synopsis: null, outline: null, setupDone: true, wizardStep: 0, brief: null, storyScore: null, autopilot: null, scriptText: null, styleLock: {}, defaults: {} },
  sequence: { act: 1, summary: "", color: "#f59e0b", status: "outlined", targetDurationSec: 60 },
  scene: { sequenceId: null, location: null, locationId: null, timeOfDay: null, summary: null, beats: null, targetDurationSec: null, status: "written" },
  shot: { sceneId: null, description: "", dialogue: null, speaker: null, shotType: null, cameraMove: null, durationSec: 5, prompt: "", negativePrompt: null, styleOverride: null, imageModel: null, videoModel: null, imageStatus: "IDLE", videoStatus: "IDLE", audioStatus: "IDLE", approved: false, motionPrompt: "", refMode: "auto", continuity: "cut", multishotGroup: null, motionRefAssetId: null, endFrameAssetId: null, colorPreset: null, withSound: true, imageAssetId: null, videoAssetId: null, notes: null },
  character: { description: "", locked: true, voiceId: null, color: "#f59e0b", role: "supporting", age: null, gender: null, handle: null, providerRef: null, sheetAssetId: null },
  shotCharacter: { look: null },
  asset: { name: null, storageKey: null, mimeType: null, angle: null, characterId: null, elementId: null, shotId: null, providerRef: null, durationSec: null, meta: {} },
  job: { shotId: null, status: "QUEUED", progress: 0, step: null, provider: null, input: {}, output: null, error: null, attempts: 0, maxAttempts: 3 },
  timelineClip: { lane: 0, assetId: null, shotId: null, label: null, inPoint: 0, transition: "none", volume: 1 },
  agentMessage: { toolCalls: null, toolCallId: null, reasoning: null },
  agentFinding: { shotId: null, severity: "info", suggestion: null, fix: null, resolved: false },
  memoryEntry: { category: "note", pinned: false, updatedBy: "USER", version: 1 },
  element: { kind: "location", description: "", handle: null, locked: true, color: "#22d3ee", providerRef: null },
  shotElement: {},
  activityLog: { level: "info", actor: null, data: null, jobId: null, shotId: null },
  appSettings: { llmBaseUrl: "https://openrouter.ai/api/v1", llmApiKey: null, llmModel: "qwen/qwen3.8-omni-flash", agentModels: {}, autoAgents: true, llmReasoning: true, visionModel: "", llmCaps: null, modelCatalog: null, concurrency: 3, mcpServers: [], mcpAuth: null },
};

const HAS_ID = new Set(Object.keys(DEFAULTS).filter((m) => m !== "shotCharacter" && m !== "shotElement"));
const STAMPED = new Set(["project", "shot", "character", "asset", "job", "agentMessage", "agentFinding", "memoryEntry", "element", "activityLog"]);
const TOUCHED = new Set(["project", "shot", "job", "memoryEntry", "appSettings"]);

const FILE = path.join(process.cwd(), "data", "studio.json");

/**
 * Next compiles the boot worker and the request handlers as separate copies of this module.
 * A module-level cache made the worker read a snapshot from before the request saved the job,
 * so the job stayed QUEUED forever. One cache on globalThis is shared by every copy.
 */
type StoreState = { data: Record<string, Row[]> | null; chain: Promise<void>; als: AsyncLocalStorage<boolean>; mtime: number };
const gStore = globalThis as typeof globalThis & { __krishStore?: StoreState };
function store(): StoreState {
  if (!gStore.__krishStore) gStore.__krishStore = { data: null, chain: Promise.resolve(), als: new AsyncLocalStorage<boolean>(), mtime: 0 };
  return gStore.__krishStore;
}

function empty(): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  for (const m of Object.keys(DEFAULTS)) out[m] = [];
  out.appSettings.push({ id: "global", ...DEFAULTS.appSettings, updatedAt: new Date() });
  return out;
}

function revive(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === "object") {
    const o = v as Row;
    for (const k of Object.keys(o)) {
      const val = o[k];
      if (typeof val === "string" && /At$/.test(k) && /^\d{4}-\d{2}-\d{2}T/.test(val)) o[k] = new Date(val);
      else if (val && typeof val === "object") revive(val);
    }
  }
  return v;
}

function fileMtime() {
  try {
    return statSync(FILE).mtimeMs;
  } catch {
    return 0;
  }
}

function load() {
  const s = store();
  const mtime = fileMtime();
  // Another copy saved the file: drop this snapshot and read the new one.
  if (s.data && mtime && mtime <= s.mtime) return s.data;
  try {
    s.data = revive(JSON.parse(readFileSync(FILE, "utf8"))) as Record<string, Row[]>;
    for (const m of Object.keys(DEFAULTS)) s.data[m] ??= [];
  } catch {
    s.data = empty();
  }
  if (!s.data.appSettings.some((r) => r.id === "global")) s.data.appSettings.push({ id: "global", ...DEFAULTS.appSettings, updatedAt: new Date() });
  s.mtime = mtime || Date.now();
  return s.data;
}

function save() {
  const s = store();
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(load()));
  s.mtime = fileMtime() || Date.now();
}

function locked<T>(fn: () => T): Promise<T> {
  const s = store();
  if (s.als.getStore()) return Promise.resolve().then(fn);
  const run = s.chain.then(() => s.als.run(true, fn));
  s.chain = run.then(() => undefined, () => undefined);
  return run;
}

function nid() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function rows(model: string) {
  return load()[model] ?? (load()[model] = []);
}

const OPS = new Set(["in", "not", "lt", "lte", "gt", "gte", "equals", "contains", "startsWith", "endsWith", "mode", "path"]);

function isOp(v: unknown): v is Row {
  return !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && Object.keys(v as Row).some((k) => OPS.has(k));
}

function time(v: unknown) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).getTime();
  return v;
}

function cmp(a: unknown, b: unknown) {
  const ta = time(a);
  const tb = time(b);
  if (typeof ta === "number" && typeof tb === "number") return ta - tb;
  if (typeof a === "boolean" || typeof b === "boolean") return (a ? 1 : 0) - (b ? 1 : 0);
  return String(a ?? "").localeCompare(String(b ?? ""));
}

function jsonAt(obj: unknown, p: (string | number)[]) {
  let cur = obj as Row | undefined;
  for (const k of p) {
    if (cur == null) return undefined;
    cur = (cur as Row)[k as string];
  }
  return cur;
}

function fieldOk(value: unknown, cond: unknown): boolean {
  if (cond === null) return value == null;
  if (!isOp(cond)) return time(value) === time(cond) && value === cond || (value instanceof Date && cond instanceof Date && value.getTime() === cond.getTime()) || value === cond;
  if ("path" in cond) return fieldOk(jsonAt(value, cond.path), { equals: cond.equals });
  if ("equals" in cond) {
    if (cond.mode === "insensitive" && typeof value === "string" && typeof cond.equals === "string") return value.toLowerCase() === cond.equals.toLowerCase();
    return value === cond.equals;
  }
  if ("contains" in cond) {
    const s = String(value ?? "");
    const q = String(cond.contains ?? "");
    return cond.mode === "insensitive" ? s.toLowerCase().includes(q.toLowerCase()) : s.includes(q);
  }
  if ("startsWith" in cond) return String(value ?? "").startsWith(String(cond.startsWith));
  if ("endsWith" in cond) return String(value ?? "").endsWith(String(cond.endsWith));
  if ("in" in cond) return (cond.in as unknown[]).some((x) => x === value);
  if ("lt" in cond && !(cmp(value, cond.lt) < 0)) return false;
  if ("lte" in cond && !(cmp(value, cond.lte) <= 0)) return false;
  if ("gt" in cond && !(cmp(value, cond.gt) > 0)) return false;
  if ("gte" in cond && !(cmp(value, cond.gte) >= 0)) return false;
  if ("not" in cond) {
    if (cond.not && typeof cond.not === "object" && "in" in cond.not) return !(cond.not.in as unknown[]).some((x) => x === value);
    return !fieldOk(value, cond.not);
  }
  return true;
}

function children(rel: Rel, row: Row): Row[] {
  if (rel.one) {
    const id = row[rel.fk];
    if (id == null) return [];
    const hit = rows(rel.model).find((r) => r.id === id);
    return hit ? [hit] : [];
  }
  return rows(rel.model).filter((r) => r[rel.fk] === row.id);
}

function match(model: string, row: Row, where?: Where): boolean {
  if (!where) return true;
  if (where.AND) return (where.AND as Where[]).every((w) => match(model, row, w));
  if (where.OR && !(where.OR as Where[]).some((w) => match(model, row, w))) return false;
  if (where.NOT && match(model, row, where.NOT)) return false;
  for (const [k, v] of Object.entries(where)) {
    if (k === "AND" || k === "OR" || k === "NOT") continue;
    const rel = REL[model]?.[k];
    if (rel) {
      const kids = children(rel, row);
      if (rel.one) {
        if (!kids[0] || !match(rel.model, kids[0], v)) return false;
      } else if (v?.some) {
        if (!kids.some((c) => match(rel.model, c, v.some))) return false;
      } else if (!kids.some((c) => match(rel.model, c, v))) return false;
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !isOp(v)) {
      if (!match(model, row, v)) return false;
      continue;
    }
    if (!fieldOk(row[k], v)) return false;
  }
  return true;
}

function sortRows(list: Row[], orderBy: unknown) {
  const keys = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  if (!keys.length) return list;
  return [...list].sort((a, b) => {
    for (const spec of keys) {
      const [k, dir] = Object.entries(spec as Row)[0];
      const c = cmp(a[k], b[k]);
      if (c) return dir === "desc" ? -c : c;
    }
    return 0;
  });
}

function shape(model: string, row: Row, q?: { select?: Row; include?: Row }): Row {
  const src = { ...row };
  const include = q?.include;
  const select = q?.select;
  const base: Row = {};
  if (select) {
    for (const [k, v] of Object.entries(select)) {
      if (k === "_count") base._count = counts(model, row, v);
      else if (v === true) base[k] = src[k];
      else if (v && typeof v === "object") base[k] = relate(model, row, k, v as Row);
    }
    return base;
  }
  Object.assign(base, src);
  if (include) {
    for (const [k, v] of Object.entries(include)) {
      if (k === "_count") base._count = counts(model, row, v);
      else base[k] = relate(model, row, k, v === true ? {} : (v as Row));
    }
  }
  return base;
}

function counts(model: string, row: Row, spec: unknown) {
  const select = (spec as Row)?.select ?? {};
  const out: Row = {};
  for (const k of Object.keys(select)) {
    const rel = REL[model]?.[k];
    out[k] = rel ? children(rel, row).length : 0;
  }
  return out;
}

function relate(model: string, row: Row, key: string, q: Row) {
  const rel = REL[model]?.[key];
  if (!rel) return null;
  let list = children(rel, row).filter((r) => match(rel.model, r, q.where));
  list = sortRows(list, q.orderBy);
  if (q.take) list = list.slice(0, q.take);
  const shaped = list.map((r) => shape(rel.model, r, q));
  return rel.one ? shaped[0] ?? null : shaped;
}

function apply(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v === undefined) continue;
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      if ("increment" in v) {
        row[k] = (row[k] ?? 0) + Number(v.increment);
        continue;
      }
      if ("decrement" in v) {
        row[k] = (row[k] ?? 0) - Number(v.decrement);
        continue;
      }
    }
    row[k] = v;
  }
}

function cascade(model: string, gone: Row[]) {
  if (!gone.length) return;
  const ids = new Set(gone.map((r) => r.id).filter(Boolean));
  if (model === "project") {
    const shotIds = new Set(rows("shot").filter((s) => ids.has(s.projectId)).map((s) => s.id));
    const charIds = new Set(rows("character").filter((s) => ids.has(s.projectId)).map((s) => s.id));
    const elIds = new Set(rows("element").filter((s) => ids.has(s.projectId)).map((s) => s.id));
    load().shotCharacter = rows("shotCharacter").filter((r) => !shotIds.has(r.shotId) && !charIds.has(r.characterId));
    load().shotElement = rows("shotElement").filter((r) => !shotIds.has(r.shotId) && !elIds.has(r.elementId));
    for (const m of Object.keys(DEFAULTS)) {
      if (m === "project" || m === "appSettings" || m === "shotCharacter" || m === "shotElement") continue;
      load()[m] = rows(m).filter((r) => !ids.has(r.projectId));
    }
    return;
  }
  const drop = (m: string, fk: string) => {
    const list = rows(m);
    const dead = list.filter((r) => ids.has(r[fk]));
    load()[m] = list.filter((r) => !ids.has(r[fk]));
    if (dead.length && HAS_ID.has(m)) cascade(m, dead);
  };
  const clear = (m: string, fk: string) => {
    for (const r of rows(m)) if (ids.has(r[fk])) r[fk] = null;
  };
  if (model === "shot") {
    load().shotCharacter = rows("shotCharacter").filter((r) => !ids.has(r.shotId));
    load().shotElement = rows("shotElement").filter((r) => !ids.has(r.shotId));
    drop("asset", "shotId");
    drop("job", "shotId");
    drop("agentFinding", "shotId");
  } else if (model === "character") {
    load().shotCharacter = rows("shotCharacter").filter((r) => !ids.has(r.characterId));
    drop("asset", "characterId");
  } else if (model === "element") {
    load().shotElement = rows("shotElement").filter((r) => !ids.has(r.elementId));
    drop("asset", "elementId");
    clear("scene", "locationId");
  } else if (model === "sequence") clear("scene", "sequenceId");
  else if (model === "asset") clear("timelineClip", "assetId");
}

function query(model: string, q: { where?: Where; orderBy?: unknown; take?: number; distinct?: string[]; select?: Row; include?: Row } = {}) {
  let list = rows(model).filter((r) => match(model, r, q.where));
  list = sortRows(list, q.orderBy);
  if (q.distinct?.length) {
    const seen = new Set<string>();
    list = list.filter((r) => {
      const k = q.distinct!.map((d) => String(r[d])).join("|");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  if (q.take) list = list.slice(0, q.take);
  return list.map((r) => shape(model, r, q));
}

function modelApi(model: string) {
  const name = model[0].toUpperCase() + model.slice(1);
  return {
    findMany: (q: Parameters<typeof query>[1] = {}) => locked(() => query(model, q)),
    findFirst: (q: Parameters<typeof query>[1] = {}) => locked(() => query(model, { ...q, take: 1 })[0] ?? null),
    findUnique: (q: Parameters<typeof query>[1]) => locked(() => query(model, q)[0] ?? null),
    findUniqueOrThrow: async (q: Parameters<typeof query>[1]) => {
      const row = await modelApi(model).findUnique(q);
      if (!row) throw new Error(`No ${name} found`);
      return row;
    },
    create: (q: { data: Row }) => locked(() => {
      const row: Row = { ...(HAS_ID.has(model) ? { id: nid() } : {}), ...structuredClone(DEFAULTS[model] ?? {}) };
      if (STAMPED.has(model)) row.createdAt = new Date();
      if (TOUCHED.has(model)) row.updatedAt = new Date();
      apply(row, q.data);
      rows(model).push(row);
      save();
      return shape(model, row);
    }),
    createMany: (q: { data: Row[] }) => locked(() => {
      for (const data of q.data) {
        const row: Row = { ...(HAS_ID.has(model) ? { id: nid() } : {}), ...structuredClone(DEFAULTS[model] ?? {}) };
        if (STAMPED.has(model)) row.createdAt = new Date();
        if (TOUCHED.has(model)) row.updatedAt = new Date();
        apply(row, data);
        rows(model).push(row);
      }
      save();
      return { count: q.data.length };
    }),
    update: (q: { where: Where; data: Row }) => locked(() => {
      const row = rows(model).find((r) => match(model, r, q.where));
      if (!row) throw new Error(`No ${name} found`);
      apply(row, q.data);
      if (TOUCHED.has(model)) row.updatedAt = new Date();
      save();
      return shape(model, row);
    }),
    updateMany: (q: { where?: Where; data: Row }) => locked(() => {
      const list = rows(model).filter((r) => match(model, r, q.where));
      for (const row of list) {
        apply(row, q.data);
        if (TOUCHED.has(model)) row.updatedAt = new Date();
      }
      save();
      return { count: list.length };
    }),
    upsert: (q: { where: Where; create: Row; update: Row }) => locked(() => {
      const row = rows(model).find((r) => match(model, r, q.where));
      if (row) {
        apply(row, q.update);
        if (TOUCHED.has(model)) row.updatedAt = new Date();
        save();
        return shape(model, row);
      }
      const made: Row = { ...(HAS_ID.has(model) ? { id: nid() } : {}), ...structuredClone(DEFAULTS[model] ?? {}) };
      if (STAMPED.has(model)) made.createdAt = new Date();
      if (TOUCHED.has(model)) made.updatedAt = new Date();
      apply(made, { ...flattenWhere(q.where), ...q.create });
      rows(model).push(made);
      save();
      return shape(model, made);
    }),
    delete: (q: { where: Where }) => locked(() => {
      const row = rows(model).find((r) => match(model, r, q.where));
      if (!row) throw new Error(`No ${name} found`);
      load()[model] = rows(model).filter((r) => r !== row);
      cascade(model, [row]);
      save();
      return shape(model, row);
    }),
    deleteMany: (q: { where?: Where } = {}) => locked(() => {
      const list = rows(model).filter((r) => match(model, r, q.where));
      const drop = new Set(list);
      load()[model] = rows(model).filter((r) => !drop.has(r));
      cascade(model, list);
      save();
      return { count: list.length };
    }),
    count: (q: { where?: Where } = {}) => locked(() => rows(model).filter((r) => match(model, r, q.where)).length),
    aggregate: (q: { where?: Where; _sum?: Row }) => locked(() => {
      const list = rows(model).filter((r) => match(model, r, q.where));
      const _sum: Row = {};
      for (const k of Object.keys(q._sum ?? {})) {
        const nums = list.map((r) => r[k]).filter((n) => typeof n === "number");
        _sum[k] = nums.length ? nums.reduce((a, b) => a + b, 0) : null;
      }
      return { _sum };
    }),
    groupBy: (q: { by: string[]; where?: Where; _count?: boolean }) => locked(() => {
      const list = rows(model).filter((r) => match(model, r, q.where));
      const map = new Map<string, Row>();
      for (const r of list) {
        const key = q.by.map((k) => String(r[k])).join("|");
        const cur = map.get(key) ?? { ...Object.fromEntries(q.by.map((k) => [k, r[k]])), _count: 0 };
        cur._count++;
        map.set(key, cur);
      }
      return [...map.values()];
    }),
  };
}

function flattenWhere(where: Where): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(where)) {
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !isOp(v)) Object.assign(out, v);
    else out[k] = v;
  }
  return out;
}

async function transaction(arg: unknown) {
  if (typeof arg === "function") return locked(() => (arg as (tx: typeof localDb) => unknown)(localDb));
  return Promise.all(arg as Promise<unknown>[]);
}

export const localDb = new Proxy({} as Record<string, ReturnType<typeof modelApi>>, {
  get(_t, prop) {
    if (prop === "$transaction") return transaction;
    if (prop === "$queryRaw" || prop === "$executeRaw") return () => locked(() => 1);
    if (typeof prop !== "string") return undefined;
    return modelApi(prop);
  },
});

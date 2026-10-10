"use client";
import * as React from "react";
import { ChevronDown, ChevronRight, Clapperboard, Film, Grid3x3, ImageIcon, Loader2, MapPin, PenLine, Rows3 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { NativeSelect, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import { useStudio, type Scene, type Sequence, type Shot } from "./store";
import { runtimeLabel } from "./film-wizard";
import { useModels, refSummary } from "./use-models";
import { CLIP_MODES } from "./shot-motion";

export interface Scope {
  sceneId?: string;
  sequenceId?: string;
  label: string;
  shots: Shot[];
}

const dur = (shots: Shot[]) => shots.reduce((a, s) => a + s.durationSec, 0);

/** Acts → sequences → scenes, each with its own batch actions. Long films start collapsed. */
export function SceneBoard({ shots, grid }: { shots: Shot[]; grid: (list: Shot[]) => React.ReactNode }) {
  const { state } = useStudio();
  const [check, setCheck] = React.useState<Scope | null>(null);
  const big = state!.shots.length > 150;
  const [open, setOpen] = React.useState<Set<string>>(() => new Set(big ? state!.sequences.slice(0, 1).map((s) => s.id) : state!.sequences.map((s) => s.id)));
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const byScene = new Map<string, Shot[]>();
  for (const s of shots) byScene.set(s.sceneId ?? "", [...(byScene.get(s.sceneId ?? "") ?? []), s]);
  const scenesOf = (seqId: string | null) => state!.scenes.filter((sc) => (sc.sequenceId ?? null) === seqId);
  const acts = [...new Set(state!.sequences.map((s) => s.act))].sort();
  const loose = scenesOf(null);
  const unsorted = byScene.get("") ?? [];

  return (
    <div className="space-y-6">
      {state!.sequences.length > 1 && <OutlineStrip open={open} onJump={(id) => { setOpen((o) => new Set(o).add(id)); document.getElementById(`seq-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }} />}
      {acts.map((act) => (
        <div key={act} className="space-y-4">
          {acts.length > 1 && <div className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-dim">Act {act}</div>}
          {state!.sequences.filter((q) => q.act === act).map((q) => (
            <SequenceBlock key={q.id} q={q} open={open.has(q.id)} onToggle={() => toggle(q.id)} scenes={scenesOf(q.id)} byScene={byScene} grid={grid} onCheck={setCheck} />
          ))}
        </div>
      ))}
      {loose.map((sc) => {
        const list = byScene.get(sc.id) ?? [];
        return list.length ? <SceneBlock key={sc.id} sc={sc} list={list} color="#64748b" grid={grid} onCheck={setCheck} /> : null;
      })}
      {unsorted.length > 0 && (
        <div className="space-y-3">
          <div className="text-xs font-semibold uppercase tracking-widest text-dim">Not in a scene</div>
          {grid(unsorted)}
        </div>
      )}
      <CheckShotsDialog scope={check} onClose={() => setCheck(null)} />
    </div>
  );
}

function OutlineStrip({ open, onJump }: { open: Set<string>; onJump: (id: string) => void }) {
  const { state } = useStudio();
  const total = Math.max(1, state!.sequences.reduce((a, q) => a + q.targetDurationSec, 0));
  return (
    <div className="space-y-1.5">
      <div className="flex h-9 overflow-hidden rounded-xl border border-line">
        {state!.sequences.map((q) => {
          const shots = state!.shots.filter((s) => state!.scenes.find((sc) => sc.id === s.sceneId)?.sequenceId === q.id);
          const done = shots.length ? shots.filter((s) => s.videoAssetId).length / shots.length : 0;
          return (
            <button
              key={q.id}
              title={`${q.index + 1}. ${q.title} · ${q.status} · ${shots.length} shots`}
              onClick={() => onJump(q.id)}
              className={cn("relative min-w-[6px] border-r border-black/30 transition hover:brightness-125", open.has(q.id) && "ring-1 ring-inset ring-white/50")}
              style={{ flexGrow: q.targetDurationSec || 1, flexBasis: 0, background: `${q.color}${q.status === "written" ? "cc" : "44"}` }}
            >
              <span className="absolute inset-x-0 bottom-0 h-1 bg-black/40"><span className="block h-full bg-white/80" style={{ width: `${done * 100}%` }} /></span>
              {q.status === "writing" && <Loader2 className="absolute inset-0 m-auto size-3 animate-spin text-white" />}
            </button>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-dim">
        <span>{state!.sequences.length} sequences · {state!.sequences.filter((q) => q.status === "written").length} written</span>
        <span>{runtimeLabel(total)}</span>
      </div>
    </div>
  );
}

function SequenceBlock({ q, open, onToggle, scenes, byScene, grid, onCheck }: {
  q: Sequence; open: boolean; onToggle: () => void; scenes: Scene[]; byScene: Map<string, Shot[]>; grid: (l: Shot[]) => React.ReactNode; onCheck: (s: Scope) => void;
}) {
  const { projectId } = useStudio();
  const shots = scenes.flatMap((sc) => byScene.get(sc.id) ?? []);
  const frames = shots.filter((s) => s.imageAssetId).length;
  const clips = shots.filter((s) => s.videoAssetId).length;
  return (
    <section id={`seq-${q.id}`} className="scroll-mt-20 overflow-hidden rounded-2xl border border-line bg-panel/40">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3" style={{ borderLeft: `4px solid ${q.color}` }}>
        <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {open ? <ChevronDown className="size-4 shrink-0 text-dim" /> : <ChevronRight className="size-4 shrink-0 text-dim" />}
          <span className="font-mono text-xs" style={{ color: q.color }}>SEQ {String(q.index + 1).padStart(2, "0")}</span>
          <span className="truncate font-display font-semibold">{q.title}</span>
        </button>
        <span className="text-[11px] text-dim">{scenes.length} scenes · {shots.length} shots · {runtimeLabel(shots.length ? dur(shots) : q.targetDurationSec)}{shots.length ? ` · ${frames} frames · ${clips} clips` : ""}</span>
        {q.status === "outlined" && <Button size="xs" onClick={() => api(`/api/projects/${projectId}/write`, { body: { what: "sequences", sequenceIds: [q.id] } }).then(() => toast.success(`Writing ${q.title}`))}><PenLine /> Write scenes & shots</Button>}
        {q.status === "writing" && <Badge tone="accent"><Loader2 className="size-3 animate-spin" /> writing</Badge>}
        {shots.length > 0 && <ScopeActions scope={{ sequenceId: q.id, label: q.title, shots }} onCheck={onCheck} />}
      </div>
      {!open && q.summary && <p className="px-5 pb-3 text-xs text-muted">{q.summary}</p>}
      {open && (
        <div className="space-y-5 border-t border-line p-4">
          {q.summary && <p className="text-xs text-muted">{q.summary}</p>}
          {scenes.map((sc) => {
            const list = byScene.get(sc.id) ?? [];
            return list.length ? <SceneBlock key={sc.id} sc={sc} list={list} color={q.color} grid={grid} onCheck={onCheck} /> : null;
          })}
          {!shots.length && q.status !== "writing" && <p className="text-sm text-dim">Not written yet.</p>}
        </div>
      )}
    </section>
  );
}

function SceneBlock({ sc, list, color, grid, onCheck }: { sc: Scene; list: Shot[]; color: string; grid: (l: Shot[]) => React.ReactNode; onCheck: (s: Scope) => void }) {
  const { state } = useStudio();
  const set = state!.elements.find((e) => e.id === sc.locationId);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5" style={{ background: `${color}14` }}>
        <span className="font-mono text-xs font-semibold" style={{ color }}>{String(sc.index + 1).padStart(2, "0")}</span>
        <span className="font-display text-sm font-semibold tracking-wide">{sc.heading}</span>
        {set && <span className="flex items-center gap-1 text-[11px] text-muted"><MapPin className="size-3" />{set.name}{!set.references.length && <span className="text-warn">(no plates)</span>}</span>}
        <span className="text-[11px] text-dim">{list.length} shots · {runtimeLabel(dur(list))}</span>
        <div className="ml-auto"><ScopeActions scope={{ sceneId: sc.id, label: sc.heading, shots: list }} onCheck={onCheck} compact /></div>
      </div>
      {grid(list)}
    </div>
  );
}

function ScopeActions({ scope, onCheck, compact }: { scope: Scope; onCheck: (s: Scope) => void; compact?: boolean }) {
  const { projectId } = useStudio();
  const body = { sceneId: scope.sceneId, sequenceId: scope.sequenceId };
  const missingFrames = scope.shots.filter((s) => !s.imageAssetId).length;
  const go = async (kind: string, label: string, extra: Record<string, unknown> = {}) => {
    const r = await api<{ jobs: number }>(`/api/projects/${projectId}/generate`, { body: { kind, ...body, ...extra } });
    toast.success(r.jobs ? `${label}: ${r.jobs} queued` : "Nothing missing here");
  };
  return (
    <div className="flex flex-wrap gap-1">
      <Button size="xs" variant="ghost" title="Draw up to 9 shots of a scene in one image, then cut it into frames" onClick={() => go("contact_sheet", "Contact sheets", missingFrames ? {} : { scope: "all" })}>
        <Grid3x3 /> {compact ? "Sheet" : "Contact sheets"}
      </Button>
      {!compact && <Button size="xs" variant="ghost" onClick={() => go("image", "Frames")}><ImageIcon /> Frames</Button>}
      <Button size="xs" variant="ghost" onClick={() => onCheck(scope)}><Clapperboard /> {compact ? "Clips" : "Check & make clips"}</Button>
    </div>
  );
}

/** Review shot prompts and motion before spending credits on clips, then generate them per shot or as multi-shot scene clips. */
function CheckShotsDialog({ scope, onClose }: { scope: Scope | null; onClose: () => void }) {
  const { state, projectId } = useStudio();
  const { video } = useModels();
  const defaults = (state?.project.defaults as Record<string, string>) ?? {};
  const [model, setModel] = React.useState(defaults.video ?? "bytedance-seedance-pro-2.5");
  const [how, setHow] = React.useState<"multishot" | "video">("multishot");
  const [mode, setMode] = React.useState("auto");
  const [onlyMissing, setOnlyMissing] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const m = video.find((x) => x.slug === model);
  React.useEffect(() => { if (m && !m.multishot) setHow("video"); }, [m]);
  if (!scope) return null;
  const shots = scope.shots.filter((s) => !onlyMissing || !s.videoAssetId);
  const perScene = new Map<string, number>();
  for (const s of shots) perScene.set(s.sceneId ?? "", (perScene.get(s.sceneId ?? "") ?? 0) + 1);
  const groups = how === "multishot" && m?.multishot ? [...perScene.values()].reduce((a, n) => a + Math.ceil(n / m.multishot!.limit), 0) : shots.length;
  const run = async () => {
    setBusy(true);
    try {
      const r = await api<{ jobs: number }>(`/api/projects/${projectId}/generate`, {
        body: { kind: how, shotIds: shots.map((s) => s.id), model, mode, scope: "all" },
      });
      toast.success(`${r.jobs} ${how === "multishot" ? "scene clip" : "clip"}${r.jobs === 1 ? "" : "s"} queued`);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Check the shots" description={`${scope.label} · ${shots.length} shots · ${runtimeLabel(dur(shots))}`} className="max-w-3xl">
        <div className="max-h-[50vh] space-y-2 overflow-y-auto p-5">
          {shots.map((s) => <CheckRow key={s.id} s={s} />)}
          {!shots.length && <p className="text-sm text-dim">Every shot here already has a clip. Untick &quot;only missing&quot; to redo them.</p>}
        </div>
        <div className="space-y-3 border-t border-line p-5">
          <div className="grid gap-2 sm:grid-cols-3">
            <NativeSelect className="h-8 text-xs" value={model} onChange={(e) => setModel(e.target.value)}>
              {video.map((v) => <option key={v.slug} value={v.slug}>{v.name}{v.multishot ? " · multi-shot" : ""}</option>)}
            </NativeSelect>
            <div className="flex rounded-lg border border-line-2 p-0.5">
              <button disabled={!m?.multishot} onClick={() => setHow("multishot")} className={cn("flex-1 rounded-md px-2 text-[11px] disabled:opacity-40", how === "multishot" ? "bg-panel-3 text-fg" : "text-dim")}>Scene clips</button>
              <button onClick={() => setHow("video")} className={cn("flex-1 rounded-md px-2 text-[11px]", how === "video" ? "bg-panel-3 text-fg" : "text-dim")}>One per shot</button>
            </div>
            {how === "video" ? (
              <NativeSelect className="h-8 text-xs" value={mode} onChange={(e) => setMode(e.target.value)}>
                {CLIP_MODES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </NativeSelect>
            ) : <div className="self-center text-[11px] text-dim">Up to {m?.multishot?.limit} shots per call share faces, light and set.</div>}
          </div>
          {m && <p className="text-[11px] text-dim">{m.name} takes {refSummary(m)}.</p>}
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> Only shots without a clip</label>
            <Button className="ml-auto" disabled={busy || !shots.length} onClick={run}>
              {busy ? <Loader2 className="animate-spin" /> : how === "multishot" ? <Rows3 /> : <Film />} Generate {groups} {how === "multishot" ? `scene clip${groups === 1 ? "" : "s"}` : `video clip${groups === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CheckRow({ s }: { s: Shot }) {
  const { state } = useStudio();
  const [motion, setMotion] = React.useState(s.motionPrompt ?? "");
  const chars = state!.characters.filter((c) => s.characterIds.includes(c.id));
  return (
    <div className="flex gap-3 rounded-xl border border-line bg-panel-2 p-2.5">
      <div className="w-28 shrink-0 overflow-hidden rounded-lg bg-black">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {s.imageUrl ? <img src={s.imageUrl} alt="" className="aspect-video w-full object-cover" /> : <div className="grid aspect-video place-items-center text-[10px] text-dim">no frame</div>}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-mono text-dim">#{s.order + 1}</span>
          <span className="truncate font-medium">{s.title}</span>
          <span className="text-dim">{s.durationSec}s</span>
          {s.continuity !== "cut" && <Badge tone="cyan">{s.continuity}</Badge>}
          {chars.map((c) => <span key={c.id} className="text-[10px]" style={{ color: c.color }}>@{c.handle ?? c.name}</span>)}
        </div>
        <p className="line-clamp-2 text-[11px] text-muted">{s.description || s.prompt}</p>
        <Textarea rows={1} className="min-h-0 py-1 text-[11px]" value={motion} onChange={(e) => setMotion(e.target.value)} onBlur={() => motion !== (s.motionPrompt ?? "") && api(`/api/shots/${s.id}`, { method: "PATCH", body: { motionPrompt: motion || null } })} placeholder="How this shot moves" />
      </div>
    </div>
  );
}

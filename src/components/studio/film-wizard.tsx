"use client";
import * as React from "react";
import { ArrowLeft, ArrowRight, Check, Clapperboard, FileText, ImagePlus, Loader2, MapPin, Monitor, Music, Plus, Smartphone, Sparkles, Trash2, Upload, Users, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import { estimateShots } from "@/lib/generation/catalog";
import { BriefBox, StoryGate } from "./autopilot-view";
import type { StyleLock } from "@/lib/prompt-builder";
import { useStudio } from "./store";
import { useModels } from "./use-models";

const STEPS = ["Your film", "Your story", "Your look", "Cast & film sets", "Write it"];
const ORIENTATIONS = [
  { ar: "16:9", label: "Landscape", icon: Monitor },
  { ar: "21:9", label: "Cinemascope", icon: Monitor },
  { ar: "9:16", label: "Vertical", icon: Smartphone },
  { ar: "1:1", label: "Square", icon: Monitor },
];
const LANGUAGES = ["English", "Tamil", "Hindi", "Telugu", "Malayalam", "Kannada", "Spanish", "French", "German", "Japanese", "Korean", "Mandarin", "Arabic", "Portuguese"];

export function runtimeLabel(sec: number) {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return s ? `${m}m ${s}s` : `${m} min`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Rough production shape for a runtime, mirroring the server's structure (sequences of ~3.5 min). */
function shape(format: string, runtime: number, acts: number) {
  const shots = estimateShots(format, runtime);
  const sequences = runtime <= 180 ? 1 : Math.max(2, Math.round(runtime / 210));
  const scenes = Math.max(1, Math.round(runtime / (runtime > 1200 ? 90 : 40)));
  return { shots, sequences, scenes, acts: runtime < 60 ? 1 : acts };
}

/** Log-scale slider position ↔ seconds, so 30 s and 3 h are both easy to hit. */
const toPos = (sec: number, min: number, max: number) => (Math.log(sec / min) / Math.log(max / min)) * 1000;
const fromPos = (pos: number, min: number, max: number) => {
  const raw = min * Math.pow(max / min, pos / 1000);
  const step = raw < 120 ? 5 : raw < 900 ? 30 : raw < 3600 ? 60 : 300;
  return Math.round(raw / step) * step;
};

export function FilmWizard() {
  const { state, projectId } = useStudio();
  const p = state!.project;
  const [step, setStep] = React.useState(Math.min(p.wizardStep ?? 0, STEPS.length - 1));
  const go = async (n: number) => {
    setStep(n);
    api(`/api/projects/${projectId}`, { method: "PATCH", body: { wizardStep: n }, quiet: true }).catch(() => {});
  };
  const skip = () => api(`/api/projects/${projectId}`, { method: "PATCH", body: { setupDone: true } });

  return (
    <div className="mx-auto flex min-h-full max-w-5xl flex-col p-4 sm:p-8">
      <ol className="mb-8 flex flex-wrap items-center gap-2">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            {i > 0 && <span className="hidden h-px w-6 bg-line-2 sm:block" />}
            <button onClick={() => go(i)} className={cn("flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition", i === step ? "border-accent bg-accent/10 text-accent" : i < step ? "border-line-2 text-fg" : "border-line text-dim")}>
              <span className={cn("grid size-4 place-items-center rounded-full text-[10px] font-bold", i < step ? "bg-accent text-black" : "bg-panel-3")}>{i < step ? <Check className="size-2.5" strokeWidth={3} /> : i + 1}</span>
              {s}
            </button>
          </li>
        ))}
        <button onClick={skip} className="ml-auto text-xs text-dim hover:text-fg">Skip setup</button>
      </ol>

      <div className="flex-1">
        {step === 0 && <FilmStep />}
        {step === 1 && <StoryStep />}
        {step === 2 && <LookStep />}
        {step === 3 && <CastStep />}
        {step === 4 && <WriteStep />}
      </div>

      {step < 4 && (
        <div className="sticky bottom-0 mt-8 flex justify-between border-t border-line bg-bg/90 py-4 backdrop-blur">
          <Button variant="ghost" disabled={step === 0} onClick={() => go(step - 1)}><ArrowLeft /> Back</Button>
          <Button onClick={() => go(step + 1)}>Next: {STEPS[step + 1]} <ArrowRight /></Button>
        </div>
      )}
    </div>
  );
}

function usePatch() {
  const { projectId } = useStudio();
  return React.useCallback((body: Record<string, unknown>) => api(`/api/projects/${projectId}`, { method: "PATCH", body }), [projectId]);
}

function FilmStep() {
  const { state } = useStudio();
  const { formats } = useModels();
  const patch = usePatch();
  const p = state!.project;
  const fmt = formats.find((f) => f.id === p.format) ?? formats[1];
  const [title, setTitle] = React.useState(p.title);
  const [runtime, setRuntime] = React.useState(p.targetRuntimeSec);
  React.useEffect(() => setRuntime(p.targetRuntimeSec), [p.targetRuntimeSec]);
  const sh = shape(fmt.id, runtime, fmt.acts);
  const SLIDER_MIN = 15;
  const SLIDER_MAX = 10800;

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_300px]">
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-3xl font-bold">What are you making?</h1>
          <p className="mt-1 text-sm text-muted">From a 30-second spot to a three-hour feature. Long films are written in acts and sequences so every scene keeps the same cast, sets and look.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {formats.map((f) => (
            <button
              key={f.id}
              onClick={() => { setRuntime(f.runtime); patch({ format: f.id, targetRuntimeSec: f.runtime }); }}
              className={cn("rounded-2xl border p-4 text-left transition", p.format === f.id ? "border-accent bg-accent/5" : "border-line bg-panel hover:border-line-2")}
            >
              <div className="font-display text-base font-semibold">{f.name}</div>
              <div className="mt-1 text-xs text-muted">{f.desc}</div>
              <div className="mt-3 text-[11px] text-dim">≈ {estimateShots(f.id, f.runtime)} shots · {runtimeLabel(f.runtime)}</div>
            </button>
          ))}
        </div>
        <div className="space-y-1.5">
          <Label>Film name</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== p.title && patch({ title })} placeholder="The Last Lighthouse" />
        </div>
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <Label>Runtime</Label>
            <span className="font-display text-lg font-semibold text-accent">{runtimeLabel(runtime)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={1000}
            value={toPos(Math.max(SLIDER_MIN, runtime), SLIDER_MIN, SLIDER_MAX)}
            onChange={(e) => setRuntime(fromPos(Number(e.target.value), SLIDER_MIN, SLIDER_MAX))}
            onPointerUp={() => patch({ targetRuntimeSec: runtime })}
            onKeyUp={() => patch({ targetRuntimeSec: runtime })}
            className="w-full accent-[var(--color-accent,#f5a524)]"
            aria-label="Runtime"
          />
          <div className="flex justify-between text-[10px] text-dim"><span>15s</span><span>1 min</span><span>10 min</span><span>1 h</span><span>3 h</span></div>
          {(runtime < fmt.min || runtime > fmt.max) && <p className="text-xs text-warn">{fmt.name}s usually run {runtimeLabel(fmt.min)} to {runtimeLabel(fmt.max)}.</p>}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label>Frame</Label>
            <div className="flex flex-wrap gap-1.5">
              {ORIENTATIONS.map((o) => (
                <button key={o.ar} onClick={() => patch({ aspectRatio: o.ar })} className={cn("flex items-center gap-1 rounded-lg border px-2 py-1 text-xs", p.aspectRatio === o.ar ? "border-accent text-accent" : "border-line-2 text-muted")}>
                  <o.icon className="size-3" /> {o.label}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Resolution</Label>
            <div className="flex gap-1.5">
              {["720p", "1080p", "4k"].map((r) => (
                <button key={r} onClick={() => patch({ resolution: r })} className={cn("rounded-lg border px-2.5 py-1 text-xs", p.resolution === r ? "border-accent text-accent" : "border-line-2 text-muted")}>{r}</button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Language</Label>
            <NativeSelect className="h-8 text-xs" value={p.language} onChange={(e) => patch({ language: e.target.value })}>
              {LANGUAGES.map((l) => <option key={l}>{l}</option>)}
            </NativeSelect>
          </div>
        </div>
      </div>

      <aside className="h-fit space-y-3 rounded-2xl border border-line bg-panel p-5 lg:sticky lg:top-4">
        <div className="font-display text-sm font-semibold">You&apos;ll get</div>
        <Stat label="Runtime" value={runtimeLabel(runtime)} />
        <Stat label="Shots" value={`≈ ${sh.shots.toLocaleString()}`} hint="3–15 s each, chosen by the agent from the story" />
        <Stat label="Scenes" value={`≈ ${sh.scenes.toLocaleString()}`} />
        {sh.sequences > 1 && <Stat label="Sequences" value={`≈ ${sh.sequences}`} hint={`in ${sh.acts} acts, written one at a time`} />}
        <Stat label="Format" value={`${p.aspectRatio} · ${p.resolution}`} />
        {runtime > 1800 && (
          <p className="rounded-lg bg-accent/5 p-2.5 text-[11px] text-muted">
            Long films are boarded scene by scene with contact sheets and rendered as multi-shot scene clips, so the same faces and sets carry through all {sh.shots.toLocaleString()} shots.
          </p>
        )}
      </aside>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line pb-2 last:border-0">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-right">
        <span className="font-display text-sm font-semibold">{value}</span>
        {hint && <span className="block text-[10px] text-dim">{hint}</span>}
      </span>
    </div>
  );
}

function StoryStep() {
  const { state, projectId, setView } = useStudio();
  const patch = usePatch();
  const p = state!.project;
  const [synopsis, setSynopsis] = React.useState(p.synopsis ?? "");
  const [logline, setLogline] = React.useState(p.logline ?? "");
  const [busy, setBusy] = React.useState(false);
  const importScript = async (file: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      await api(`/api/projects/${projectId}/script`, { form });
      await patch({ setupDone: true });
      setView("script");
      toast.success("Script imported. Breaking it into scenes and shots…");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="font-display text-3xl font-bold">What happens in your film?</h1>
        <p className="mt-1 text-sm text-muted">A paragraph is enough for a short. For a feature, give the beginning, the turns and the ending; the writer builds acts, sequences, scenes and shots from it.</p>
      </div>
      <div className="space-y-1.5">
        <Label>Logline</Label>
        <Input value={logline} onChange={(e) => setLogline(e.target.value)} onBlur={() => logline !== (p.logline ?? "") && patch({ logline })} placeholder="One sentence: who wants what, and what stands in the way." />
      </div>
      <div className="space-y-1.5">
        <Label>Story</Label>
        <Textarea rows={12} value={synopsis} onChange={(e) => setSynopsis(e.target.value)} onBlur={() => synopsis !== (p.synopsis ?? "") && patch({ synopsis })} placeholder="A lighthouse keeper on a remote island finds a stranger washed ashore the night the storm of the century arrives…" />
        <div className="text-right text-[10px] text-dim">{synopsis.trim().split(/\s+/).filter(Boolean).length} words</div>
      </div>
      <SongPicker />
      <div className="rounded-2xl border border-dashed border-line-2 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <FileText className="size-5 text-muted" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Already have a script?</div>
            <div className="text-xs text-muted">Import a PDF, Final Draft, Fountain or text file. Every scene and shot is broken down for you, and long scripts are grouped into sequences.</div>
          </div>
          <label className={cn("inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg border border-line-2 px-3 text-xs hover:border-accent/50", busy && "pointer-events-none opacity-50")}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} Import script
            <input type="file" accept=".pdf,.txt,.fountain,.fdx,.md,text/plain,application/pdf" className="hidden" onChange={(e) => e.target.files?.[0] && importScript(e.target.files[0])} />
          </label>
        </div>
      </div>
    </div>
  );
}

function LookStep() {
  const { state, projectId } = useStudio();
  const { looks, colorPresets } = useModels();
  const patch = usePatch();
  const lock = (state!.project.styleLock as StyleLock) || {};
  const styleRefs = state!.assets.filter((a) => (lock.referenceAssetIds ?? []).includes(a.id));
  const pick = (id: string) => {
    const l = looks.find((x) => x.id === id)!;
    patch({ styleLock: { ...lock, enabled: true, look: l.id, prompt: l.prompt, colorPreset: l.color ?? lock.colorPreset } });
  };
  const upload = async (files: FileList) => {
    const form = new FormData();
    form.append("role", "STYLE_REF");
    Array.from(files).forEach((f) => form.append("files", f));
    await api(`/api/projects/${projectId}/assets`, { form });
    toast.success("Style reference added to every shot");
  };
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-bold">Pick a look</h1>
        <p className="mt-1 text-sm text-muted">The look and colour grade are locked onto every frame and clip. Add reference images or a reference video to match a specific film.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {looks.map((l) => {
          const sw = colorPresets.find((c) => c.id === l.color)?.swatch ?? ["#333", "#555", "#777"];
          return (
            <button key={l.id} onClick={() => pick(l.id)} className={cn("overflow-hidden rounded-2xl border text-left transition", lock.look === l.id ? "border-accent ring-2 ring-accent/30" : "border-line hover:border-line-2")}>
              <div className="flex h-16">{sw.map((c) => <span key={c} className="flex-1" style={{ background: c }} />)}</div>
              <div className="p-3">
                <div className="flex items-center gap-1.5 font-display text-sm font-semibold">{lock.look === l.id && <Check className="size-3.5 text-accent" />}{l.name}</div>
                <div className="mt-0.5 text-[11px] text-muted">{l.desc}</div>
              </div>
            </button>
          );
        })}
      </div>
      <div className="space-y-2">
        <Label>Colour grade</Label>
        <div className="flex flex-wrap gap-2">
          {colorPresets.map((c) => (
            <button key={c.id} onClick={() => patch({ styleLock: { ...lock, colorPreset: c.id } })} className={cn("flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs", lock.colorPreset === c.id ? "border-accent text-fg" : "border-line-2 text-muted")}>
              <span className="flex overflow-hidden rounded">{c.swatch.map((s) => <span key={s} className="h-4 w-3" style={{ background: s }} />)}</span>
              {c.name}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        <Label>Style references</Label>
        <div className="flex flex-wrap gap-2">
          {styleRefs.map((a) => a.kind === "VIDEO" ? <video key={a.id} src={a.url} muted className="h-20 rounded-lg border border-line-2" /> : (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={a.id} src={a.url} alt="" className="h-20 rounded-lg border border-line-2" />
          ))}
          <label className="grid h-20 w-28 cursor-pointer place-items-center rounded-lg border border-dashed border-line-2 text-center text-[10px] text-dim hover:border-accent/50">
            <span><ImagePlus className="mx-auto mb-1 size-4" />Images or a video</span>
            <input type="file" accept="image/*,video/*" multiple className="hidden" onChange={(e) => e.target.files && upload(e.target.files)} />
          </label>
        </div>
      </div>
    </div>
  );
}

function CastStep() {
  const { state, projectId } = useStudio();
  const [name, setName] = React.useState("");
  const [desc, setDesc] = React.useState("");
  const [setName_, setSetName] = React.useState("");
  const designing = (key: string, id: string) => state!.jobs.some((j) => j.type === "DESIGN_SHEET" && ["QUEUED", "RUNNING"].includes(j.status) && (j.input as Record<string, string>)?.[key] === id);
  const addChar = async () => {
    if (!name.trim()) return;
    await api(`/api/projects/${projectId}/characters`, { body: { name, description: desc, role: state!.characters.length ? "supporting" : "lead" } });
    setName("");
    setDesc("");
  };
  const photo = async (characterId: string, file: File) => {
    const form = new FormData();
    form.append("role", "CHARACTER_REF");
    form.append("characterId", characterId);
    form.append("angle", "front");
    form.append("files", file);
    await api(`/api/projects/${projectId}/assets`, { form });
  };
  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-bold">Cast & film sets</h1>
        <p className="mt-1 text-sm text-muted">Optional. Add who must look a certain way and where the story happens. Anyone you skip is created by the writer, and you can design them after.</p>
      </div>
      <section className="space-y-3">
        <div className="flex items-center gap-2 font-display text-sm font-semibold"><Users className="size-4" /> Cast</div>
        <div className="grid gap-3 md:grid-cols-2">
          {state!.characters.map((c) => {
            const front = c.references.find((r) => r.role === "CHARACTER_REF");
            const sheet = c.references.find((r) => r.id === c.sheetAssetId);
            const busy = designing("characterId", c.id);
            return (
              <div key={c.id} className="flex gap-3 rounded-2xl border border-line bg-panel p-3">
                <div className="relative h-24 w-20 shrink-0 overflow-hidden rounded-xl bg-panel-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {front ? <img src={front.url} alt="" className="size-full object-cover" /> : <div className="grid size-full place-items-center text-2xl font-bold" style={{ color: c.color }}>{c.name[0]}</div>}
                  {busy && <div className="absolute inset-0 grid place-items-center bg-black/60"><Loader2 className="size-4 animate-spin text-accent" /></div>}
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-display font-semibold">{c.name}</span>
                    <Badge>{c.role ?? "supporting"}</Badge>
                    <button className="ml-auto text-dim hover:text-err" onClick={() => api(`/api/characters/${c.id}`, { method: "DELETE" })} aria-label="Remove"><Trash2 className="size-3.5" /></button>
                  </div>
                  <p className="line-clamp-2 text-xs text-muted">{c.description || "No description yet."}</p>
                  <div className="flex flex-wrap gap-1.5">
                    <label className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border border-line-2 px-2 text-[11px] text-muted hover:text-fg">
                      <ImagePlus className="size-3" /> Use my photo
                      <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && photo(c.id, e.target.files[0])} />
                    </label>
                    <Button size="xs" variant="outline" disabled={busy} onClick={() => api(`/api/projects/${projectId}/design`, { body: { characterId: c.id, kind: "turnaround" } })}>
                      <Sparkles /> {sheet ? "Redraw" : "Design sheet"}
                    </Button>
                  </div>
                  {sheet && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={sheet.url} alt="" className="h-10 rounded border border-line-2" />
                  )}
                </div>
              </div>
            );
          })}
          <div className="space-y-2 rounded-2xl border border-dashed border-line-2 p-3">
            <Input className="h-8" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
            <Textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Age, build, face, hair, what they wear" />
            <Button size="sm" variant="secondary" onClick={addChar} disabled={!name.trim()}><Plus /> Add to cast</Button>
          </div>
        </div>
      </section>
      <section className="space-y-3">
        <div className="flex items-center gap-2 font-display text-sm font-semibold"><MapPin className="size-4" /> Film sets</div>
        <div className="flex flex-wrap gap-2">
          {state!.elements.filter((e) => e.kind === "location").map((e) => (
            <div key={e.id} className="flex items-center gap-2 rounded-xl border border-line bg-panel p-1.5 pr-2.5">
              {e.references[0] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={e.references[0].url} alt="" className="h-10 w-16 rounded-lg object-cover" />
              ) : <div className="grid h-10 w-16 place-items-center rounded-lg bg-panel-2">{designing("elementId", e.id) ? <Loader2 className="size-3.5 animate-spin text-accent" /> : <MapPin className="size-3.5 text-dim" />}</div>}
              <span className="text-sm">{e.name}</span>
              <Button size="xs" variant="ghost" onClick={() => api(`/api/projects/${projectId}/design`, { body: { elementId: e.id, kind: "plate" } })}><Wand2 /> Draw</Button>
            </div>
          ))}
          <div className="flex gap-1.5">
            <Input className="h-9 w-44" value={setName_} onChange={(e) => setSetName(e.target.value)} placeholder="e.g. Lighthouse lamp room" onKeyDown={async (e) => { if (e.key === "Enter" && setName_.trim()) { await api(`/api/projects/${projectId}/elements`, { body: { name: setName_, kind: "location" } }); setSetName(""); } }} />
            <Button variant="secondary" disabled={!setName_.trim()} onClick={async () => { await api(`/api/projects/${projectId}/elements`, { body: { name: setName_, kind: "location" } }); setSetName(""); }}><Plus /></Button>
          </div>
        </div>
      </section>
    </div>
  );
}

function WriteStep() {
  const { state, projectId, setView } = useStudio();
  const { formats } = useModels();
  const p = state!.project;
  const fmt = formats.find((f) => f.id === p.format) ?? formats[1];
  const sh = shape(fmt.id, p.targetRuntimeSec, fmt.acts);
  const [busy, setBusy] = React.useState(false);
  const write = async (what: "film" | "outline") => {
    setBusy(true);
    try {
      await api(`/api/projects/${projectId}/write`, { body: { what } });
      setView("storyboard");
      toast.success(what === "film" ? "Writing your film. Sequences appear on the storyboard as they're written." : "Writing the outline");
    } finally {
      setBusy(false);
    }
  };
  const missing = !p.synopsis?.trim() && !p.logline?.trim();
  const score = p.storyScore as { score: number; method: string } | null;
  const blocked = !!score && score.method === "ai" && score.score < 6;
  return (
    <div className="mx-auto max-w-2xl space-y-6 text-center">
      <Clapperboard className="mx-auto size-10 text-accent" />
      <h1 className="font-display text-3xl font-bold">Ready to write {p.title}</h1>
      <p className="text-sm text-muted">
        A {runtimeLabel(p.targetRuntimeSec)} {fmt.name.toLowerCase()} in {p.aspectRatio}, about {sh.shots.toLocaleString()} shots
        {sh.sequences > 1 ? ` across ${sh.sequences} sequences` : ""}, with {state!.characters.length || "an AI-created"} cast and {state!.elements.filter((e) => e.kind === "location").length || "AI-created"} sets.
      </p>
      {missing && <p className="text-sm text-warn">Add a story or logline first so the writer knows what happens.</p>}
      {!missing && <StoryGate compact />}
      {!missing && <BriefBox className="text-left" />}
      {blocked && <p className="text-sm text-err">Your story scores under 6/10. Change it (or let the Script Doctor improve it) before writing.</p>}
      <div className="flex flex-wrap justify-center gap-3">
        <Button size="lg" variant={score && !blocked ? "secondary" : "default"} disabled={busy || missing || blocked} onClick={() => write("film")}>{busy ? <Loader2 className="animate-spin" /> : <Wand2 />} Write my film</Button>
        {sh.sequences > 1 && <Button size="lg" variant="secondary" disabled={busy || missing} onClick={() => write("outline")}>Outline first</Button>}
      </div>
      {sh.sequences > 1 && <p className="text-xs text-dim">&quot;Outline first&quot; writes the acts and sequences so you can review them, then you write each sequence from the storyboard.</p>}
    </div>
  );
}

/** "Use my own song": upload a track; the film is cut to it and runs as long as it does. */
function SongPicker() {
  const { state, projectId } = useStudio();
  const [busy, setBusy] = React.useState(false);
  const song = state!.assets.find((a) => a.role === "MUSIC" && (a.meta as { song?: boolean } | null)?.song);
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.append("role", "MUSIC");
      form.append("song", "true");
      form.append("lockStyle", "false");
      form.append("files", file);
      await api(`/api/projects/${projectId}/assets`, { form });
      toast.success("Song added. The film will be cut to it.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-2xl border border-dashed border-line-2 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Music className="size-5 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Use my own song</div>
          <div className="text-xs text-muted">{song ? `${song.name} · ${runtimeLabel(song.durationSec ?? 0)}. The runtime now matches the song and shots are cut to it.` : "Upload a track and the film is written to its length and cut to the music."}</div>
          {song && <audio src={song.url} controls className="mt-2 h-8 w-full max-w-sm" />}
        </div>
        <label className={cn("inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg border border-line-2 px-3 text-xs hover:border-accent/50", busy && "pointer-events-none opacity-50")}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} {song ? "Replace song" : "Upload song"}
          <input type="file" accept="audio/*" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
      </div>
    </div>
  );
}

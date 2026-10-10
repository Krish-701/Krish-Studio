"use client";
import * as React from "react";
import useSWR from "swr";
import { AlertTriangle, Clapperboard, Eye, Link2, Loader2, Upload, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";
import { api, fetcher } from "@/lib/client";
import { cn } from "@/lib/utils";
import { useStudio, type Shot } from "./store";
import { useModels, refSummary } from "./use-models";

export interface MotionFields {
  motionPrompt: string;
  refMode: string;
  continuity: string;
  colorPreset: string;
  withSound: boolean;
  elementIds: string[];
  looks: Record<string, string>;
  cameraMove: string;
}

export const CLIP_MODES = [
  { id: "auto", label: "Auto", hint: "Picks the best way for the chosen model" },
  { id: "frame", label: "Image → Video", hint: "Animates the storyboard frame exactly" },
  { id: "reference", label: "References", hint: "Characters, sets and the frame as references: best identity" },
  { id: "text", label: "Text → Video", hint: "Prompt only, plus character references if the model takes them" },
];

export const CONTINUITY = [
  { id: "cut", label: "Cut", hint: "A normal cut from the previous shot" },
  { id: "continuous", label: "Continuous", hint: "Starts on the last frame of the previous clip" },
  { id: "extend", label: "Extend", hint: "Continues the previous clip itself" },
];

interface PlanResponse {
  model: string;
  prompt: string;
  durationSec?: number;
  summary: string;
  plan: { mode: string; dropped: { label: string; reason: string }[]; refs: { label?: string; type: string; url: string; media?: string }[]; start: { url: string; label?: string } | null; end: { url: string } | null };
}

/** Motion, continuity, references and colour for a shot's clip. */
export function MotionPanel({ shot, f, set, videoModel }: { shot: Shot; f: MotionFields; set: (p: Partial<MotionFields>) => void; videoModel: string }) {
  const { state, projectId } = useStudio();
  const { motionTemplates, colorPresets, video } = useModels();
  const model = video.find((m) => m.slug === videoModel);
  const [preview, setPreview] = React.useState(false);
  const chars = state!.characters.filter((c) => shot.characterIds.includes(c.id));
  const sets = state!.elements.filter((e) => e.kind === "location");
  const props = state!.elements.filter((e) => e.kind === "prop");
  const scene = state!.scenes.find((s) => s.id === shot.sceneId);
  const motionRef = state!.assets.find((a) => a.id === shot.motionRefAssetId);

  const uploadMotion = async (file: File) => {
    const form = new FormData();
    form.append("role", "MOTION_REF");
    form.append("shotId", shot.id);
    form.append("lockStyle", "false");
    form.append("files", file);
    await api(`/api/projects/${projectId}/assets`, { form });
    toast.success("Reference video attached to this shot");
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>How the shot moves</Label>
        <Textarea rows={3} value={f.motionPrompt} onChange={(e) => set({ motionPrompt: e.target.value })} placeholder="Action and camera for the video model, e.g. She turns to the window as the camera pushes in." />
        <RewriteButton shotId={shot.id} target="motion" onText={(t) => set({ motionPrompt: t })} />
        <div className="flex flex-wrap gap-1">
          {motionTemplates.map((t) => (
            <button key={t.name} onClick={() => set({ motionPrompt: t.prompt, cameraMove: t.camera })} className={cn("rounded-md border px-2 py-0.5 text-[11px] transition", f.cameraMove === t.camera ? "border-accent/60 text-accent" : "border-line-2 text-muted hover:text-fg")}>
              {t.name}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label>Clip from</Label>
          <NativeSelect value={f.refMode} onChange={(e) => set({ refMode: e.target.value })}>
            {CLIP_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </NativeSelect>
          <p className="text-[10px] text-dim">{CLIP_MODES.find((m) => m.id === f.refMode)?.hint}</p>
        </div>
        <div className="space-y-1.5">
          <Label>Continuity</Label>
          <NativeSelect value={f.continuity} onChange={(e) => set({ continuity: e.target.value })}>
            {CONTINUITY.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </NativeSelect>
          <p className="text-[10px] text-dim">{CONTINUITY.find((m) => m.id === f.continuity)?.hint}</p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Colour</Label>
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => set({ colorPreset: "" })} className={cn("rounded-lg border px-2 py-1 text-[11px]", !f.colorPreset ? "border-accent/60 text-accent" : "border-line-2 text-muted")}>Film look</button>
          {colorPresets.map((c) => (
            <button key={c.id} onClick={() => set({ colorPreset: c.id })} className={cn("flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px]", f.colorPreset === c.id ? "border-accent/60 text-fg" : "border-line-2 text-muted hover:text-fg")}>
              <span className="flex overflow-hidden rounded-sm">{c.swatch.map((s) => <span key={s} className="h-3 w-2" style={{ background: s }} />)}</span>
              {c.name}
            </button>
          ))}
        </div>
      </div>

      {chars.length > 0 && (
        <div className="space-y-1.5">
          <Label>Wardrobe</Label>
          <div className="space-y-1">
            {chars.map((c) => {
              const looks = c.references.filter((r) => r.role === "WARDROBE_REF");
              return (
                <div key={c.id} className="flex items-center gap-2 text-xs">
                  <span className="size-2 rounded-full" style={{ background: c.color }} />
                  <span className="w-24 truncate">{c.name}</span>
                  <NativeSelect className="h-7 text-xs" value={f.looks[c.id] ?? ""} onChange={(e) => set({ looks: { ...f.looks, [c.id]: e.target.value } })}>
                    <option value="">Default look</option>
                    {looks.map((l) => <option key={l.id} value={l.name ?? ""}>{l.name}</option>)}
                  </NativeSelect>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <Label>Film set & props</Label>
        <div className="flex flex-wrap gap-1.5">
          {scene?.locationId && <Badge tone="cyan">◆ {sets.find((s) => s.id === scene.locationId)?.name} (scene set)</Badge>}
          {[...sets.filter((s) => s.id !== scene?.locationId), ...props].map((e) => {
            const on = f.elementIds.includes(e.id);
            return (
              <button key={e.id} onClick={() => set({ elementIds: on ? f.elementIds.filter((x) => x !== e.id) : [...f.elementIds, e.id] })} className={cn("rounded-lg border px-2 py-0.5 text-[11px]", on ? "border-accent/60 text-fg" : "border-line-2 text-dim hover:text-fg")}>
                {e.kind === "prop" ? "▣" : "◆"} {e.name}{!e.references.length && <AlertTriangle className="ml-1 inline size-3 text-warn" />}
              </button>
            );
          })}
          {!state!.elements.length && <span className="text-xs text-dim">Add sets and props on the Cast page.</span>}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Motion reference video</Label>
        {motionRef ? (
          <div className="flex items-center gap-2">
            <video src={motionRef.url} muted loop autoPlay playsInline className="h-14 rounded-md border border-line-2" />
            <Button size="xs" variant="ghost" onClick={() => api(`/api/shots/${shot.id}`, { method: "PATCH", body: { motionRefAssetId: null } })}><X /> Remove</Button>
          </div>
        ) : (
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-line-2 px-3 py-2 text-xs text-muted hover:text-fg">
            <Upload className="size-3.5" /> Upload a clip whose movement or choreography this shot should copy
            <input type="file" accept="video/*" className="hidden" onChange={(e) => e.target.files?.[0] && uploadMotion(e.target.files[0])} />
          </label>
        )}
        {motionRef && model && !model.refLimits.video && <p className="text-[10px] text-warn">{model.name} doesn't take video references; pick Seedance 2.x or Gemini Omni to use it.</p>}
      </div>

      <label className="flex items-center justify-between rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs">
        Generate sound with the clip <Switch checked={f.withSound} onCheckedChange={(v) => set({ withSound: v })} />
      </label>

      {model && <p className="text-[10px] text-dim">{model.name} references: {refSummary(model)}{model.multishot ? ` · multi-shot up to ${model.multishot.limit}` : ""}</p>}

      <Button size="sm" variant="outline" onClick={() => setPreview((p) => !p)}><Eye /> {preview ? "Hide" : "Check"} what this clip will send</Button>
      {preview && <PlanPreview shotId={shot.id} model={videoModel} mode={f.refMode} />}
    </div>
  );
}

/** "References this prompt attaches": the exact frames and references a generation will use. */
export function PlanPreview({ shotId, model, mode, kind = "video" }: { shotId: string; model?: string; mode?: string; kind?: "image" | "video" }) {
  const qs = new URLSearchParams({ kind, ...(model ? { model } : {}), ...(mode && mode !== "auto" ? { mode } : {}) });
  const { data, isLoading, error } = useSWR<PlanResponse>(`/api/shots/${shotId}/plan?${qs}`, fetcher, { revalidateOnFocus: false });
  if (isLoading) return <div className="flex items-center gap-2 text-xs text-muted"><Loader2 className="size-3.5 animate-spin" /> Planning references…</div>;
  if (error || !data) return <div className="text-xs text-err">Couldn&apos;t plan this shot.</div>;
  const items = [
    ...(data.plan.start ? [{ ...data.plan.start, type: "start frame", media: "image" }] : []),
    ...(data.plan.end ? [{ ...data.plan.end, type: "end frame", media: "image", label: "End frame" }] : []),
    ...data.plan.refs,
  ];
  return (
    <div className="space-y-2 rounded-xl border border-line bg-panel-2 p-3">
      <div className="flex items-center gap-2 text-xs">
        <Clapperboard className="size-3.5 text-accent" />
        <span className="font-medium">{data.model}</span>
        <Badge tone="accent">{data.plan.mode === "frame" ? "image → video" : data.plan.mode === "reference" ? "references" : "text"}</Badge>
      </div>
      {items.length > 0 ? (
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
          {items.map((r, i) => (
            <div key={i} className="space-y-0.5">
              <div className="aspect-square overflow-hidden rounded-md border border-line-2 bg-black">
                {r.media === "video" ? <video src={r.url} muted className="size-full object-cover" /> : r.media === "audio" ? <div className="grid size-full place-items-center text-[10px] text-dim">audio</div> : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.url} alt="" className="size-full object-cover" />
                )}
              </div>
              <div className="truncate text-[9px] text-dim" title={`${r.label ?? ""} (${r.type})`}>{r.label ?? r.type}</div>
            </div>
          ))}
        </div>
      ) : <div className="text-xs text-dim">No images attached: text only.</div>}
      {data.plan.dropped.length > 0 && (
        <div className="text-[10px] text-warn">Left out: {data.plan.dropped.map((d) => `${d.label} (${d.reason})`).join(", ")}</div>
      )}
      <details className="text-[11px] text-muted">
        <summary className="cursor-pointer text-fg"><Link2 className="mr-1 inline size-3" />Prompt</summary>
        <pre className="mt-1 whitespace-pre-wrap font-mono text-[10px]">{data.prompt}</pre>
      </details>
    </div>
  );
}


/** "Rewrite with AI": asks for a new image or motion prompt, with an optional note ("make it rainier"). */
export function RewriteButton({ shotId, target, onText, save }: { shotId: string; target: "prompt" | "motion"; onText: (t: string) => void; save?: () => Promise<void> }) {
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const go = async () => {
    setBusy(true);
    try {
      if (save) await save();
      const r = await api<{ text: string }>(`/api/shots/${shotId}/rewrite`, { body: { target, instruction: note || undefined } });
      onText(r.text);
      setOpen(false);
      setNote("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button size="xs" variant="ghost" disabled={busy} onClick={() => (open ? go() : setOpen(true))}>
        {busy ? <Loader2 className="animate-spin" /> : <Wand2 />} {open ? "Rewrite" : "Rewrite with AI"}
      </Button>
      {open && <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} placeholder="Optional: what to change" className="h-6 min-w-0 flex-1 rounded-md border border-line-2 bg-panel-2 px-2 text-[11px] outline-none" />}
    </div>
  );
}

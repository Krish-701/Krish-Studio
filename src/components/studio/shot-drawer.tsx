"use client";
import * as React from "react";
import useSWR from "swr";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Film, ImageIcon, Maximize2, Mic, Paintbrush, Save, Sparkles, Trash2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Switch, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";
import { api, fetcher } from "@/lib/client";
import { CAMERA_MOTIONS, SHOT_TYPES } from "@/lib/generation/catalog";
import { MotionPanel, CLIP_MODES } from "./shot-motion";
import { useModels } from "./use-models";
import type { StyleLock } from "@/lib/prompt-builder";
import { cn } from "@/lib/utils";
import { AGENTS } from "@/lib/agents/definitions";
import { JobRow } from "./right-panel";
import { MaskEditor } from "./mask-editor";
import { useStudio, type Asset, type Job } from "./store";

interface ShotDetail {
  id: string;
  assets: Asset[];
  jobs: Job[];
}

export function ShotDrawer() {
  const { openShotId, openShot, state } = useStudio();
  const shot = state?.shots.find((s) => s.id === openShotId);
  const idx = shot && state ? state.shots.indexOf(shot) : -1;
  return (
    <Dialog open={!!shot} onOpenChange={(o) => !o && openShot(null)}>
      {shot && state && (
        <DialogContent side="right" title={`Shot #${shot.order + 1} · ${shot.title}`} description={state.scenes.find((s) => s.id === shot.sceneId)?.heading}>
          <div className="absolute right-14 top-4 z-20 flex gap-1">
            <Button size="icon-sm" variant="ghost" disabled={idx <= 0} onClick={() => openShot(state.shots[idx - 1].id)} aria-label="Previous shot"><ChevronLeft /></Button>
            <Button size="icon-sm" variant="ghost" disabled={idx >= state.shots.length - 1} onClick={() => openShot(state.shots[idx + 1].id)} aria-label="Next shot"><ChevronRight /></Button>
          </div>
          <ShotEditor key={shot.id} shotId={shot.id} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function ShotEditor({ shotId }: { shotId: string }) {
  const { state, projectId, openShot } = useStudio();
  const shot = state!.shots.find((s) => s.id === shotId)!;
  const { data: detail, mutate } = useSWR<ShotDetail>(`/api/shots/${shotId}`, fetcher);
  const [f, setF] = React.useState(() => ({
    title: shot.title, description: shot.description, prompt: shot.prompt, negativePrompt: shot.negativePrompt ?? "", dialogue: shot.dialogue ?? "", speaker: shot.speaker ?? "",
    shotType: shot.shotType ?? "", cameraMove: shot.cameraMove ?? "static", durationSec: shot.durationSec, imageModel: shot.imageModel ?? "", videoModel: shot.videoModel ?? "", characterIds: shot.characterIds,
    motionPrompt: shot.motionPrompt ?? "", refMode: shot.refMode ?? "auto", continuity: shot.continuity ?? "cut", colorPreset: shot.colorPreset ?? "",
    withSound: shot.withSound, elementIds: shot.elementIds, looks: shot.looks as Record<string, string>,
  }));
  const { image: IMAGE_MODELS, video: VIDEO_MODELS } = useModels();
  const [clipMode, setClipMode] = React.useState(shot.refMode ?? "auto");
  const [override, setOverride] = React.useState<StyleLock | null>((shot.styleOverride as StyleLock) ?? null);
  const [dirty, setDirty] = React.useState(false);
  const [view, setView] = React.useState<"image" | "video">(shot.videoUrl ? "video" : "image");
  const [masking, setMasking] = React.useState(false);

  // Live updates on the shot (new frame/clip) refresh the version list.
  React.useEffect(() => {
    mutate();
  }, [shot.imageAssetId, shot.videoAssetId, shot.imageStatus, shot.videoStatus, mutate]);

  const set = (patch: Partial<typeof f>) => {
    setF((x) => ({ ...x, ...patch }));
    setDirty(true);
  };
  const save = async () => {
    await api(`/api/shots/${shotId}`, { method: "PATCH", body: { ...f, styleOverride: override && Object.keys(override).length ? override : null, imageModel: f.imageModel || null, videoModel: f.videoModel || null, shotType: f.shotType || null, dialogue: f.dialogue || null, speaker: f.speaker || null, motionPrompt: f.motionPrompt || null, colorPreset: f.colorPreset || null } });
    setDirty(false);
  };
  const run = async (body: Record<string, unknown>, msg: string) => {
    if (dirty) await save();
    await api(`/api/projects/${projectId}/generate`, { body: { shotIds: [shotId], ...body } });
    toast.success(msg);
  };

  const images = detail?.assets.filter((a) => a.role === "SHOT_IMAGE") ?? [];
  const videos = detail?.assets.filter((a) => a.role === "SHOT_VIDEO") ?? [];
  const meta = shot.imageMeta as { prompt?: string; provider?: string; model?: string; characters?: string[]; refs?: number; consistencyScore?: number; fallbackFrom?: string[] } | null;
  const findings = state!.findings.filter((x) => x.shotId === shotId);
  const [ar1, ar2] = state!.project.aspectRatio.split(":").map(Number);
  const idx = state!.shots.findIndex((s) => s.id === shotId);
  const vModel = VIDEO_MODELS.find((m) => m.slug === (f.videoModel || (state!.project.defaults as Record<string, string>)?.video));

  return (
    <div className="grid gap-0 xl:grid-cols-[1.25fr_1fr]">
      {/* Media */}
      <div className="space-y-4 border-b border-line p-5 xl:border-b-0 xl:border-r">
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-line-2 p-0.5">
            <button onClick={() => setView("image")} className={cn("flex items-center gap-1 rounded-md px-2.5 py-1 text-xs", view === "image" ? "bg-panel-3 text-fg" : "text-muted")}><ImageIcon className="size-3.5" /> Frame</button>
            <button onClick={() => setView("video")} className={cn("flex items-center gap-1 rounded-md px-2.5 py-1 text-xs", view === "video" ? "bg-panel-3 text-fg" : "text-muted")}><Film className="size-3.5" /> Clip</button>
          </div>
          <label className="ml-auto flex items-center gap-2 text-xs">
            Approved <Switch checked={shot.approved} onCheckedChange={(v) => api(`/api/shots/${shotId}`, { method: "PATCH", body: { approved: v } })} />
          </label>
        </div>

        {masking && shot.imageUrl ? (
          <MaskEditor
            src={shot.imageUrl}
            onCancel={() => setMasking(false)}
            onSubmit={async (blob, prompt) => {
              const form = new FormData();
              form.append("role", "MASK");
              form.append("shotId", shotId);
              form.append("files", new File([blob], "mask.png", { type: "image/png" }));
              const [mask] = await api<{ id: string }[]>(`/api/projects/${projectId}/assets`, { form });
              await api(`/api/projects/${projectId}/generate`, { body: { kind: "inpaint", shotId, assetId: shot.imageAssetId, maskAssetId: mask.id, prompt } });
              toast.success("Inpainting queued");
              setMasking(false);
            }}
          />
        ) : (
          <div className="letterbox relative overflow-hidden rounded-xl border border-line-2 bg-black" style={{ aspectRatio: `${ar1}/${ar2}` }}>
            {view === "video" && shot.videoUrl ? (
              <video key={shot.videoUrl} src={shot.videoUrl} poster={shot.imageUrl ?? undefined} controls autoPlay loop playsInline className="relative z-0 size-full object-contain" />
            ) : shot.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={shot.imageUrl} alt="" className="size-full object-contain" />
            ) : (
              <div className="grid size-full place-items-center text-sm text-dim">No {view === "video" ? "clip" : "frame"} yet</div>
            )}
            {shot.imageUrl && view === "image" && (
              <a href={shot.imageUrl} target="_blank" rel="noreferrer" className="absolute bottom-3 right-3 z-10 rounded-md bg-black/70 p-1.5 text-muted hover:text-fg"><Maximize2 className="size-3.5" /></a>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => run({ kind: "image" }, "Frame queued")}><Sparkles /> {shot.imageUrl ? "Regenerate frame" : "Generate frame"}</Button>
          <div className="flex overflow-hidden rounded-lg border border-line-2">
            <select value={clipMode} onChange={(e) => setClipMode(e.target.value)} className="bg-panel-3 px-2 text-xs text-fg outline-none" title="How to make the clip">
              {CLIP_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              {idx > 0 && <option value="extend">Extend previous clip</option>}
            </select>
            <Button variant="secondary" className="rounded-none border-0" onClick={async () => {
              if (clipMode === "extend") { await api(`/api/shots/${shotId}`, { method: "PATCH", body: { continuity: "extend" } }); return run({ kind: "video" }, "Extending the previous clip"); }
              return run({ kind: "video", mode: clipMode }, "Clip queued");
            }}><Film /> {shot.videoUrl ? "Regenerate clip" : "Make clip"}</Button>
          </div>
          {shot.imageAssetId && <Button variant="ghost" onClick={() => api(`/api/projects/${projectId}/generate`, { body: { kind: "upscale", shotId, assetId: shot.imageAssetId, scale: "2x" } }).then(() => toast.success("Upscale queued"))}><Maximize2 /> Upscale</Button>}
          {shot.imageAssetId && <Button variant="ghost" onClick={() => { setView("image"); setMasking(true); }}><Paintbrush /> Inpaint</Button>}
          {f.dialogue && <Button variant="ghost" onClick={() => run({ kind: "voice" }, "Voiceover queued")}><Mic /> Voice</Button>}
        </div>

        {meta && (
          <div className="flex flex-wrap gap-1.5 text-[10px]">
            {meta.provider && <Badge tone="accent">{meta.provider}</Badge>}
            {meta.model && <Badge>{meta.model}</Badge>}
            {meta.characters?.map((c) => <Badge key={c} tone="cyan">◆ {c}</Badge>)}
            {meta.refs ? <Badge>{meta.refs} refs injected</Badge> : null}
            {meta.consistencyScore !== undefined && <Badge tone={meta.consistencyScore >= 80 ? "ok" : "warn"}>consistency {meta.consistencyScore}</Badge>}
            {meta.fallbackFrom?.length ? <Badge tone="warn" title={meta.fallbackFrom.join("\n")}>fell back</Badge> : null}
          </div>
        )}

        {(view === "image" ? images : videos).length > 0 && (
          <div>
            <Label>Versions</Label>
            <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
              {(view === "image" ? images : videos).map((a) => {
                const current = a.id === (view === "image" ? shot.imageAssetId : shot.videoAssetId);
                return (
                  <button
                    key={a.id}
                    onClick={() => api(`/api/shots/${shotId}`, { method: "PATCH", body: view === "image" ? { imageAssetId: a.id } : { videoAssetId: a.id } })}
                    className={cn("relative h-16 shrink-0 overflow-hidden rounded-lg border-2", current ? "border-accent" : "border-transparent opacity-70 hover:opacity-100")}
                    style={{ aspectRatio: `${ar1}/${ar2}` }}
                  >
                    {a.kind === "VIDEO" ? <video src={a.url} muted className="size-full object-cover" /> : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={a.url} alt="" className="size-full object-cover" />
                    )}
                    {current && <span className="absolute right-0.5 top-0.5 rounded bg-accent p-0.5 text-black"><Check className="size-2.5" /></span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {findings.length > 0 && (
          <div className="space-y-2">
            <Label>Agent findings</Label>
            {findings.map((x) => {
              const fix = x.fix as { prompt?: string } | null;
              return (
                <div key={x.id} className="rounded-lg border border-warn/30 bg-warn/5 p-2.5 text-sm">
                  <div className="flex items-center gap-1.5 text-[10px]" style={{ color: AGENTS[x.agent as keyof typeof AGENTS]?.color }}><AlertTriangle className="size-3" /> {AGENTS[x.agent as keyof typeof AGENTS]?.name}</div>
                  <div className="mt-1">{x.message}</div>
                  {x.suggestion && <div className="mt-0.5 text-xs text-muted">{x.suggestion}</div>}
                  <div className="mt-2 flex gap-1.5">
                    {fix?.prompt && <Button size="xs" onClick={() => api(`/api/projects/${projectId}/findings/${x.id}`, { method: "PATCH", body: { action: "apply" } })}><Wand2 /> Apply fix</Button>}
                    <Button size="xs" variant="ghost" onClick={() => api(`/api/projects/${projectId}/findings/${x.id}`, { method: "PATCH", body: { action: "resolve" } })}>Dismiss</Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {detail?.jobs.length ? (
          <div className="space-y-1.5">
            <Label>Generation log</Label>
            {detail.jobs.slice(0, 5).map((j) => <JobRow key={j.id} j={state!.jobs.find((x) => x.id === j.id) ?? j} />)}
          </div>
        ) : null}
      </div>

      {/* Fields */}
      <div className="p-5">
        <Tabs defaultValue="shot">
          <TabsList className="-mx-2 mb-4">
            <TabsTrigger value="shot">Shot</TabsTrigger>
            <TabsTrigger value="motion">Motion & refs</TabsTrigger>
            <TabsTrigger value="prompt">Prompt</TabsTrigger>
            <TabsTrigger value="style">Style override {override && Object.keys(override).length ? <span className="size-1.5 rounded-full bg-accent" /> : null}</TabsTrigger>
          </TabsList>
          <TabsContent value="shot" className="space-y-3">
            <div className="space-y-1.5"><Label>Title</Label><Input value={f.title} onChange={(e) => set({ title: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Action / description</Label><Textarea rows={3} value={f.description} onChange={(e) => set({ description: e.target.value })} /></div>
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1.5">
                <Label>Shot type</Label>
                <NativeSelect value={f.shotType} onChange={(e) => set({ shotType: e.target.value })}>
                  <option value="">—</option>
                  {SHOT_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ").toLowerCase()}</option>)}
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <Label>Camera</Label>
                <NativeSelect value={f.cameraMove} onChange={(e) => set({ cameraMove: e.target.value })}>
                  {CAMERA_MOTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <Label>Seconds</Label>
                <Input type="number" min={1} max={30} step={0.5} value={f.durationSec} onChange={(e) => set({ durationSec: Number(e.target.value) })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Characters in frame</Label>
              <div className="flex flex-wrap gap-1.5">
                {state!.characters.map((c) => {
                  const on = f.characterIds.includes(c.id);
                  return (
                    <button key={c.id} onClick={() => set({ characterIds: on ? f.characterIds.filter((x) => x !== c.id) : [...f.characterIds, c.id] })} className={cn("flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition", on ? "border-transparent bg-panel-3 text-fg" : "border-line-2 text-dim hover:text-fg")} style={on ? { boxShadow: `inset 0 0 0 1px ${c.color}` } : undefined}>
                      <span className="size-2 rounded-full" style={{ background: c.color }} />
                      {c.name}
                      {on && !c.references.length && <AlertTriangle className="size-3 text-warn" />}
                    </button>
                  );
                })}
                {!state!.characters.length && <span className="text-xs text-dim">No characters yet.</span>}
              </div>
            </div>
            <div className="grid grid-cols-[1fr_2fr] gap-2">
              <div className="space-y-1.5"><Label>Speaker</Label><Input value={f.speaker} onChange={(e) => set({ speaker: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>Dialogue</Label><Input value={f.dialogue} onChange={(e) => set({ dialogue: e.target.value })} /></div>
            </div>
          </TabsContent>
          <TabsContent value="motion">
            <MotionPanel shot={shot} f={f} set={set} videoModel={f.videoModel || (state!.project.defaults as Record<string, string>)?.video || "bytedance-seedance-pro-2.5"} />
          </TabsContent>
          <TabsContent value="prompt" className="space-y-3">
            <div className="space-y-1.5">
              <Label>Image prompt</Label>
              <Textarea rows={7} value={f.prompt} onChange={(e) => set({ prompt: e.target.value })} placeholder="Leave empty to use the description. Character references and the style lock are added automatically." />
            </div>
            <div className="space-y-1.5"><Label>Avoid</Label><Input value={f.negativePrompt} onChange={(e) => set({ negativePrompt: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label>Image model</Label>
                <NativeSelect value={f.imageModel} onChange={(e) => set({ imageModel: e.target.value })}>
                  <option value="">Project default</option>
                  {IMAGE_MODELS.map((m) => <option key={m.slug} value={m.slug}>{m.name}</option>)}
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <Label>Video model</Label>
                <NativeSelect value={f.videoModel} onChange={(e) => set({ videoModel: e.target.value })}>
                  <option value="">Project default</option>
                  {VIDEO_MODELS.map((m) => <option key={m.slug} value={m.slug}>{m.name}</option>)}
                </NativeSelect>
              </div>
            </div>
            {vModel?.durations && !vModel.durations.includes(f.durationSec) && (
              <div className="text-xs text-warn">{vModel.name} renders {vModel.durations[0]}–{vModel.durations[vModel.durations.length - 1]}s clips; this shot will be snapped to the nearest length.</div>
            )}
            {meta?.prompt && (
              <details className="rounded-lg border border-line bg-panel-2 p-2.5 text-xs text-muted">
                <summary className="cursor-pointer text-fg">Last prompt sent to the model</summary>
                <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px]">{meta.prompt}</pre>
              </details>
            )}
          </TabsContent>
          <TabsContent value="style" className="space-y-3">
            <label className="flex items-center justify-between rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm">
              Override the project style for this shot
              <Switch checked={!!override} onCheckedChange={(v) => { setOverride(v ? { enabled: true } : null); setDirty(true); }} />
            </label>
            {override && (
              <>
                <div className="space-y-1.5"><Label>Visual style</Label><Textarea rows={3} value={override.prompt ?? ""} onChange={(e) => { setOverride({ ...override, prompt: e.target.value }); setDirty(true); }} placeholder="e.g. dream sequence, overexposed, soft focus" /></div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5"><Label>Mood</Label><Input value={override.mood ?? ""} onChange={(e) => { setOverride({ ...override, mood: e.target.value }); setDirty(true); }} /></div>
                  <div className="space-y-1.5"><Label>Lighting</Label><Input value={override.lighting ?? ""} onChange={(e) => { setOverride({ ...override, lighting: e.target.value }); setDirty(true); }} /></div>
                </div>
              </>
            )}
          </TabsContent>
        </Tabs>
        <div className="mt-6 flex items-center gap-2 border-t border-line pt-4">
          <Button variant="danger" size="sm" onClick={async () => { if (confirm("Delete this shot?")) { await api(`/api/shots/${shotId}`, { method: "DELETE" }); openShot(null); } }}><Trash2 /> Delete</Button>
          <Button className="ml-auto" onClick={async () => { await save(); toast.success("Shot saved"); }} disabled={!dirty}><Save /> Save</Button>
        </div>
      </div>
    </div>
  );
}

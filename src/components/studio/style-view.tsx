"use client";
import * as React from "react";
import { Check, Film, Globe, ImagePlus, Link2, Lock, Palette, Plus, Trash2, Video, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Section, Switch } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/client";
import { IMAGE_MODELS, VIDEO_MODELS } from "@/lib/generation/catalog";
import type { StyleLock } from "@/lib/prompt-builder";
import { cn } from "@/lib/utils";
import { useStudio } from "./store";

const PRESETS: { name: string; lock: StyleLock }[] = [
  { name: "Neo-noir", lock: { prompt: "neo-noir, anamorphic 2.39 lens, wet streets, deep shadows, Kodak Vision3 500T grain", mood: "tense, melancholic", tone: "brooding", palette: ["teal", "sodium orange", "ink black"], lighting: "hard practicals, rim light, haze" } },
  { name: "Golden-hour drama", lock: { prompt: "naturalistic 35mm film, shallow depth of field, soft halation", mood: "warm, hopeful", tone: "intimate", palette: ["amber", "honey", "olive"], lighting: "low golden sun, backlight, bounce fill" } },
  { name: "Sci-fi epic", lock: { prompt: "large-format IMAX sci-fi, monumental scale, practical-looking VFX, clean composition", mood: "awe", tone: "epic", palette: ["cold steel blue", "white", "signal orange"], lighting: "volumetric god rays, high contrast" } },
  { name: "A24 indie", lock: { prompt: "muted indie drama, 4:3 framing feel, static compositions, 16mm grain", mood: "quiet unease", tone: "understated", palette: ["desaturated green", "beige", "faded red"], lighting: "overcast natural light" } },
  { name: "Anime", lock: { prompt: "hand-painted anime film, cel shading, painterly backgrounds", mood: "nostalgic", tone: "earnest", palette: ["sky blue", "cream", "coral"], lighting: "soft diffuse, glowing highlights" } },
];

export function StyleView() {
  const { state, projectId } = useStudio();
  const [lock, setLock] = React.useState<StyleLock>((state?.project.styleLock as StyleLock) ?? {});
  const [paletteInput, setPaletteInput] = React.useState("");
  const [link, setLink] = React.useState("");
  const [dirty, setDirty] = React.useState(false);
  React.useEffect(() => {
    if (!dirty && state) setLock((state.project.styleLock as StyleLock) ?? {});
  }, [state, dirty]);
  if (!state) return null;
  const defaults = (state.project.defaults ?? {}) as Record<string, unknown>;

  const set = (patch: Partial<StyleLock>) => {
    setLock((l) => ({ ...l, ...patch }));
    setDirty(true);
  };
  const save = async (next = lock) => {
    await api(`/api/projects/${projectId}`, { method: "PATCH", body: { styleLock: next } });
    setDirty(false);
    toast.success(next.enabled ? "Style locked across all shots" : "Style saved");
  };
  const setDefaults = (patch: Record<string, unknown>) => api(`/api/projects/${projectId}`, { method: "PATCH", body: { defaults: { ...defaults, ...patch } } });

  const refs = state.assets.filter((a) => ["STYLE_REF", "MOODBOARD", "VIDEO_REF"].includes(a.role));
  const inLock = new Set(lock.referenceAssetIds ?? []);
  const toggleRef = (id: string) => {
    const next = { ...lock, referenceAssetIds: inLock.has(id) ? [...inLock].filter((x) => x !== id) : [...inLock, id] };
    setLock(next);
    save(next);
  };

  const upload = async (files: FileList, role: string) => {
    const form = new FormData();
    form.append("role", role);
    Array.from(files).forEach((f) => form.append("files", f));
    await api(`/api/projects/${projectId}/assets`, { form });
    toast.success("References added");
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Style & references</h1>
          <p className="max-w-2xl text-sm text-muted">Lock one look for the whole film. The lock and its reference images are added to every generation; any shot can override it.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 text-sm">
            <Lock className={cn("size-4", lock.enabled ? "text-accent" : "text-dim")} /> Style lock
            <Switch checked={!!lock.enabled} onCheckedChange={(v) => { const n = { ...lock, enabled: v }; setLock(n); save(n); }} />
          </span>
          <Button onClick={() => save()} disabled={!dirty}><Check /> Save</Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <Section title={<span className="flex items-center gap-2"><Palette className="size-4 text-accent" /> Look</span>}>
          <div className="mb-4 flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button key={p.name} onClick={() => set({ ...p.lock, enabled: true })} className="rounded-lg border border-line-2 px-2.5 py-1 text-xs text-muted transition hover:border-accent/50 hover:text-fg">
                {p.name}
              </button>
            ))}
          </div>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Visual style</Label>
              <Textarea rows={3} value={lock.prompt ?? ""} onChange={(e) => set({ prompt: e.target.value })} placeholder="e.g. 1970s anamorphic thriller, Kodak 5247 grain, practical lighting" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>Mood</Label><Input value={lock.mood ?? ""} onChange={(e) => set({ mood: e.target.value })} placeholder="tense, lonely" /></div>
              <div className="space-y-1.5"><Label>Tone</Label><Input value={lock.tone ?? ""} onChange={(e) => set({ tone: e.target.value })} placeholder="restrained, poetic" /></div>
              <div className="space-y-1.5"><Label>Lighting</Label><Input value={lock.lighting ?? ""} onChange={(e) => set({ lighting: e.target.value })} placeholder="low-key, motivated practicals" /></div>
              <div className="space-y-1.5"><Label>Camera / lens</Label><Input value={lock.camera ?? ""} onChange={(e) => set({ camera: e.target.value })} placeholder="40mm anamorphic, slow dolly" /></div>
            </div>
            <div className="space-y-1.5">
              <Label>Palette</Label>
              <div className="flex flex-wrap items-center gap-1.5">
                {(lock.palette ?? []).map((p) => (
                  <span key={p} className="flex items-center gap-1.5 rounded-lg border border-line-2 bg-panel-2 px-2 py-1 text-xs">
                    <span className="size-3 rounded-full border border-white/10" style={{ background: /^#|^rgb/.test(p) ? p : p.split(" ").pop() }} />
                    {p}
                    <button onClick={() => set({ palette: (lock.palette ?? []).filter((x) => x !== p) })} className="text-dim hover:text-err"><X className="size-3" /></button>
                  </span>
                ))}
                <Input
                  className="h-7 w-36 text-xs"
                  value={paletteInput}
                  onChange={(e) => setPaletteInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && paletteInput.trim()) {
                      set({ palette: [...(lock.palette ?? []), paletteInput.trim()] });
                      setPaletteInput("");
                    }
                  }}
                  placeholder="add colour + Enter"
                />
              </div>
            </div>
            <div className="space-y-1.5"><Label>Avoid</Label><Input value={lock.negative ?? ""} onChange={(e) => set({ negative: e.target.value })} placeholder="text, watermarks, extra fingers, cartoonish" /></div>
            <div className="space-y-1.5"><Label>Notes from style links</Label><Textarea rows={2} value={lock.linkNotes ?? ""} onChange={(e) => set({ linkNotes: e.target.value })} placeholder="The Mood agent can distil these from your pasted websites." /></div>
          </div>
        </Section>

        <div className="space-y-6">
          <Section title="Default models">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Image</Label>
                <NativeSelect value={(defaults.image as string) ?? "auto"} onChange={(e) => setDefaults({ image: e.target.value })}>
                  {IMAGE_MODELS.map((m) => <option key={m.slug} value={m.slug}>{m.name}</option>)}
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <Label>Video</Label>
                <NativeSelect value={(defaults.video as string) ?? "auto"} onChange={(e) => setDefaults({ video: e.target.value })}>
                  {VIDEO_MODELS.map((m) => <option key={m.slug} value={m.slug}>{m.name}</option>)}
                </NativeSelect>
              </div>
            </div>
            <label className="mt-3 flex items-center justify-between rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm">
              Native sound in clips (Seedance)
              <Switch checked={!!defaults.videoSound} onCheckedChange={(v) => setDefaults({ videoSound: v })} />
            </label>
          </Section>

          <Section title={<span className="flex items-center gap-2"><Globe className="size-4 text-accent" /> Website links</span>}>
            <div className="flex gap-2">
              <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://… (film still, Pinterest board, director’s site)" />
              <Button
                variant="secondary"
                onClick={async () => {
                  if (!link) return;
                  await api(`/api/projects/${projectId}/link`, { body: { url: link } });
                  setLink("");
                  toast.success("Link added. Its preview image joined the style references.");
                }}
              >
                <Link2 /> Add
              </Button>
            </div>
            <div className="mt-3 space-y-2">
              {state.assets.filter((a) => a.kind === "LINK").map((a) => {
                const m = a.meta as { description?: string; image?: string };
                return (
                  <div key={a.id} className="flex items-start gap-3 rounded-lg border border-line bg-panel-2 p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {m.image ? <img src={m.image} alt="" className="h-12 w-20 rounded object-cover" /> : <Globe className="m-3 size-5 text-dim" />}
                    <div className="min-w-0 flex-1">
                      <a href={a.url} target="_blank" rel="noreferrer" className="block truncate text-sm hover:text-accent">{a.name}</a>
                      <div className="line-clamp-2 text-xs text-muted">{m.description}</div>
                    </div>
                    <button onClick={() => api(`/api/assets/${a.id}`, { method: "DELETE" })} className="text-dim hover:text-err"><Trash2 className="size-3.5" /></button>
                  </div>
                );
              })}
            </div>
          </Section>
        </div>
      </div>

      <Section
        title="Reference library"
        actions={
          <>
            <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line-2 px-2.5 py-1 text-xs text-muted hover:text-fg">
              <ImagePlus className="size-3.5" /> Style images
              <input type="file" multiple accept="image/*" className="hidden" onChange={(e) => e.target.files && upload(e.target.files, "STYLE_REF")} />
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line-2 px-2.5 py-1 text-xs text-muted hover:text-fg">
              <Plus className="size-3.5" /> Mood board
              <input type="file" multiple accept="image/*" className="hidden" onChange={(e) => e.target.files && upload(e.target.files, "MOODBOARD")} />
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line-2 px-2.5 py-1 text-xs text-muted hover:text-fg">
              <Video className="size-3.5" /> Reference video
              <input type="file" multiple accept="video/*" className="hidden" onChange={(e) => e.target.files && upload(e.target.files, "VIDEO_REF")} />
            </label>
          </>
        }
      >
        <p className="mb-3 text-xs text-muted">Images marked <Lock className="inline size-3 text-accent" /> are sent as style references with every generation (up to 2 per frame). Reference videos contribute a keyframe.</p>
        {!refs.length && <div className="rounded-xl border border-dashed border-line-2 p-8 text-center text-sm text-dim">Drop in stills, mood boards or reference clips.</div>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {refs.filter((a) => a.kind !== "LINK").map((a) => (
            <div key={a.id} className={cn("group relative aspect-video overflow-hidden rounded-xl border bg-panel-2", inLock.has(a.id) ? "border-accent/60" : "border-line")}>
              {a.kind === "VIDEO" ? (
                <video src={a.url} muted loop playsInline className="size-full object-cover" onMouseEnter={(e) => e.currentTarget.play()} onMouseLeave={(e) => e.currentTarget.pause()} />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.url} alt={a.name ?? ""} className="size-full object-cover" />
              )}
              <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/90 to-transparent p-1.5 pt-6">
                <Badge className="bg-black/50">{a.role === "VIDEO_REF" ? <Film className="size-2.5" /> : null}{a.role.replace("_REF", "").toLowerCase()}</Badge>
                {a.kind === "IMAGE" && (
                  <button onClick={() => toggleRef(a.id)} className={cn("ml-auto rounded-md p-1", inLock.has(a.id) ? "bg-accent text-black" : "bg-black/60 text-muted hover:text-fg")} title={inLock.has(a.id) ? "In style lock" : "Add to style lock"}>
                    <Lock className="size-3" />
                  </button>
                )}
                <button onClick={() => api(`/api/assets/${a.id}`, { method: "DELETE" })} className={cn("rounded-md bg-black/60 p-1 text-muted hover:text-err", a.kind !== "IMAGE" && "ml-auto")} title="Delete">
                  <Trash2 className="size-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <AskMood />
        </div>
      </Section>
    </div>
  );
}

function AskMood() {
  const { projectId } = useStudio();
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api(`/api/projects/${projectId}/agent`, {
            body: { agent: "MOOD", message: "Look at the script, characters, style references and pasted links, then define and lock a cohesive visual style for the film with set_style_lock. Explain your choice briefly." },
          });
          toast.success("Mood & Tone agent updated the style lock");
        } finally {
          setBusy(false);
        }
      }}
    >
      <Wand2 /> {busy ? "Mood agent working…" : "Let the Mood agent define the look"}
    </Button>
  );
}

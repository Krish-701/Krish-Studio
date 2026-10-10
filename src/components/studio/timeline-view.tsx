"use client";
import * as React from "react";
import { Film, Mic, Music, Pause, Play, Scissors, SkipBack, Sparkles, Trash2, Volume2, Waves, ZoomIn, ZoomOut } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/misc";
import { api } from "@/lib/client";
import { cn, formatTime } from "@/lib/utils";
import { useStudio, type Clip } from "./store";

type Track = "VIDEO" | "VOICE" | "MUSIC" | "SFX";
const TRACKS: { key: Track; label: string; icon: React.ElementType; color: string }[] = [
  { key: "VIDEO", label: "Video", icon: Film, color: "#f5a524" },
  { key: "VOICE", label: "Voice", icon: Mic, color: "#22d3ee" },
  { key: "MUSIC", label: "Music", icon: Music, color: "#a78bfa" },
  { key: "SFX", label: "SFX", icon: Waves, color: "#f472b6" },
];
const TRANSITIONS = ["none", "crossfade", "fade", "dip", "wipe", "slide"];
const OVERLAP = 0.5;
const len = (c: { inPoint: number; outPoint: number }) => Math.max(0.1, c.outPoint - c.inPoint);

/** Packs the video track in order (ripple), mirroring the server's relayout. Voice clips follow their shot. */
function pack(clips: Clip[], shotOrder: Map<string, number>): Clip[] {
  const video = clips.filter((c) => c.track === "VIDEO").sort((a, b) => (shotOrder.get(a.shotId ?? "") ?? 1e9) - (shotOrder.get(b.shotId ?? "") ?? 1e9) || a.start - b.start);
  let t = 0;
  const starts = new Map<string, number>();
  const packed = new Map<string, Clip>();
  for (const c of video) {
    const start = Math.max(0, c.transition !== "none" && t > 0 ? t - OVERLAP : t);
    packed.set(c.id, { ...c, start });
    if (c.shotId) starts.set(c.shotId, start);
    t = start + len(c);
  }
  return clips.map((c) => packed.get(c.id) ?? (c.track === "VOICE" && c.shotId && starts.has(c.shotId) ? { ...c, start: starts.get(c.shotId)! + 0.2 } : c));
}

export function TimelineView() {
  const { state, projectId, refresh, openShot } = useStudio();
  const [clips, setClips] = React.useState<Clip[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [pps, setPps] = React.useState(60); // pixels per second
  const [t, setT] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [audioDialog, setAudioDialog] = React.useState<null | "music" | "sfx">(null);
  const dirty = React.useRef(false);
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (state && !dirty.current) setClips(state.clips);
  }, [state]);

  const shotOrder = React.useMemo(() => new Map(state?.shots.map((s) => [s.id, s.order]) ?? []), [state]);
  const assetDur = React.useMemo(() => new Map(state?.assets.map((a) => [a.id, a.durationSec ?? 0]) ?? []), [state]);
  const total = Math.max(10, ...clips.map((c) => c.start + len(c)));
  const sel = clips.find((c) => c.id === selected);

  const persist = React.useCallback(
    (next: Clip[]) => {
      dirty.current = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        setSaving(true);
        try {
          await api(`/api/projects/${projectId}/timeline`, { method: "PUT", body: { clips: next } });
        } finally {
          dirty.current = false;
          setSaving(false);
        }
      }, 500);
    },
    [projectId],
  );

  const update = (next: Clip[], repack = true) => {
    const out = repack ? pack(next, shotOrder) : next;
    setClips(out);
    persist(out);
  };

  // Playback clock
  React.useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setT((cur) => {
        const n = cur + dt;
        if (n >= total) {
          setPlaying(false);
          return total;
        }
        return n;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, total]);

  // Keyboard: space = play/pause, delete = remove clip
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,textarea,select")) return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        update(clips.filter((c) => c.id !== selected));
        setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!state) return null;

  const splitAtPlayhead = () => {
    if (!sel || t <= sel.start || t >= sel.start + len(sel)) return toast.error("Place the playhead inside the selected clip");
    const cut = sel.inPoint + (t - sel.start);
    const a = { ...sel, outPoint: cut };
    const b = { ...sel, id: undefined as unknown as string, inPoint: cut, start: t, transition: "none" };
    update([...clips.filter((c) => c.id !== sel.id), a, { ...b, id: `new-${Date.now()}` }], sel.track === "VIDEO");
  };

  return (
    <div className="flex h-full min-h-[600px] flex-col">
      <div className="grid min-h-0 flex-1 gap-4 p-4 sm:p-6 xl:grid-cols-[1fr_300px]">
        <Preview clips={clips} t={t} playing={playing} aspect={state.project.aspectRatio} posters={new Map(state.shots.map((s) => [s.id, s.imageUrl]))} />
        <div className="space-y-3">
          <div className="rounded-2xl border border-line bg-panel p-4">
            <div className="font-display text-sm font-semibold">Inspector</div>
            {!sel ? (
              <p className="mt-2 text-xs text-muted">Select a clip to trim, set transitions or volume. Space plays, Delete removes.</p>
            ) : (
              <div className="mt-3 space-y-3 text-sm">
                <div className="truncate text-xs text-muted">{sel.label || (sel.shotId ? `Shot #${(shotOrder.get(sel.shotId) ?? 0) + 1}` : sel.track)}</div>
                <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
                  <div><Label>Start</Label><div>{formatTime(sel.start)}</div></div>
                  <div><Label>In</Label><div>{formatTime(sel.inPoint)}</div></div>
                  <div><Label>Length</Label><div>{len(sel).toFixed(1)}s</div></div>
                </div>
                {sel.track === "VIDEO" ? (
                  <div className="space-y-1.5">
                    <Label>Transition in</Label>
                    <NativeSelect value={sel.transition} onChange={(e) => update(clips.map((c) => (c.id === sel.id ? { ...c, transition: e.target.value } : c)))}>
                      {TRANSITIONS.map((x) => <option key={x}>{x}</option>)}
                    </NativeSelect>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label className="flex items-center gap-1"><Volume2 className="size-3" /> Volume {Math.round(sel.volume * 100)}%</Label>
                    <input type="range" min={0} max={1.5} step={0.05} value={sel.volume} onChange={(e) => update(clips.map((c) => (c.id === sel.id ? { ...c, volume: +e.target.value } : c)), false)} className="w-full accent-[#f5a524]" />
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button size="xs" variant="secondary" onClick={splitAtPlayhead}><Scissors /> Split</Button>
                  {sel.shotId && <Button size="xs" variant="ghost" onClick={() => openShot(sel.shotId)}>Open shot</Button>}
                  <Button size="xs" variant="danger" onClick={() => { update(clips.filter((c) => c.id !== sel.id), sel.track === "VIDEO"); setSelected(null); }}><Trash2 /> Remove</Button>
                </div>
              </div>
            )}
          </div>
          <div className="rounded-2xl border border-line bg-panel p-4">
            <div className="font-display text-sm font-semibold">Add to the cut</div>
            <div className="mt-3 grid gap-2">
              <Button size="sm" variant="secondary" onClick={() => api<{ jobs: number }>(`/api/projects/${projectId}/generate`, { body: { kind: "video", scope: "missing" } }).then((r) => toast.success(`Queued ${r.jobs} clip(s)`))}><Film /> Animate missing clips</Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  const voiced = new Set(clips.filter((c) => c.track === "VOICE").map((c) => c.shotId));
                  const ids = state.shots.filter((s) => s.dialogue && !voiced.has(s.id)).map((s) => s.id);
                  if (!ids.length) return toast("Every dialogue line already has a voice");
                  await api(`/api/projects/${projectId}/generate`, { body: { kind: "voice", shotIds: ids } });
                  toast.success(`Voicing ${ids.length} line(s)`);
                }}
              >
                <Mic /> Voice all dialogue
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setAudioDialog("music")}><Music /> Score / music cue</Button>
              <Button size="sm" variant="secondary" onClick={() => setAudioDialog("sfx")}><Waves /> Sound effect at playhead</Button>
            </div>
          </div>
        </div>
      </div>

      {/* Transport */}
      <div className="flex items-center gap-2 border-y border-line bg-panel px-4 py-2">
        <Button size="icon-sm" variant="ghost" onClick={() => setT(0)} aria-label="To start"><SkipBack /></Button>
        <Button size="icon-sm" onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause" : "Play"}>{playing ? <Pause /> : <Play />}</Button>
        <span className="font-mono text-xs tabular-nums text-muted">{formatTime(t)} / {formatTime(total)}</span>
        <span className="ml-3 text-[11px] text-dim">{saving ? "Saving…" : "Saved"}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" onClick={() => setPps((p) => Math.max(10, p / 1.4))} aria-label="Zoom out"><ZoomOut /></Button>
          <input type="range" min={10} max={300} value={pps} onChange={(e) => setPps(+e.target.value)} className="w-24 accent-[#f5a524]" aria-label="Zoom" />
          <Button size="icon-sm" variant="ghost" onClick={() => setPps((p) => Math.min(300, p * 1.4))} aria-label="Zoom in"><ZoomIn /></Button>
        </div>
      </div>

      {/* Tracks */}
      {!clips.length ? (
        <div className="p-6">
          <Empty icon={<Film />} title="The timeline fills itself">Each clip you generate drops onto the video track in storyboard order. Voiceover follows its shot; music and SFX go where you put them.</Empty>
        </div>
      ) : (
        <div className="flex shrink-0 overflow-hidden bg-panel/40">
          <div className="w-24 shrink-0 border-r border-line">
            <div className="h-7 border-b border-line" />
            {TRACKS.map((tr) => (
              <div key={tr.key} className="flex h-14 items-center gap-1.5 border-b border-line px-3 text-xs text-muted">
                <tr.icon className="size-3.5" style={{ color: tr.color }} /> {tr.label}
              </div>
            ))}
          </div>
          <div className="relative min-w-0 flex-1 overflow-x-auto" onPointerDown={() => setSelected(null)}>
            <div className="relative" style={{ width: (total + 10) * pps }}>
              <Ruler total={total + 10} pps={pps} onSeek={setT} />
              {TRACKS.map((tr) => (
                <div key={tr.key} className="relative h-14 border-b border-line">
                  {clips.filter((c) => c.track === tr.key).map((c) => (
                    <ClipBlock
                      key={c.id}
                      clip={c}
                      pps={pps}
                      color={tr.color}
                      selected={c.id === selected}
                      label={c.label || (c.shotId ? `#${(shotOrder.get(c.shotId) ?? 0) + 1}` : "")}
                      thumb={c.shotId ? state.shots.find((s) => s.id === c.shotId)?.imageUrl : null}
                      maxOut={(c.assetId && assetDur.get(c.assetId)) || c.outPoint}
                      onSelect={() => setSelected(c.id)}
                      onChange={(next, done) => {
                        if (c.track === "VIDEO") {
                          // Dragging a video clip reorders shots; trimming ripples.
                          const others = clips.map((x) => (x.id === c.id ? next : x));
                          if (done && next.start !== c.start) {
                            const order = others.filter((x) => x.track === "VIDEO").sort((a, b) => a.start - b.start).map((x) => x.shotId).filter(Boolean) as string[];
                            const rest = state.shots.map((s) => s.id).filter((id) => !order.includes(id));
                            api(`/api/projects/${projectId}/shots/reorder`, { body: { shotIds: [...order, ...rest] } }).then(() => refresh());
                            setClips(others);
                            return;
                          }
                          if (done) update(others);
                          else setClips(others);
                        } else {
                          const out = clips.map((x) => (x.id === c.id ? next : x));
                          if (done) update(out, false);
                          else setClips(out);
                        }
                      }}
                    />
                  ))}
                </div>
              ))}
              <div className="pointer-events-none absolute inset-y-0 z-20 w-px bg-accent" style={{ left: t * pps }}>
                <div className="absolute -left-1.5 top-0 size-3 rotate-45 bg-accent" />
              </div>
            </div>
          </div>
        </div>
      )}

      <AudioDialog kind={audioDialog} onClose={() => setAudioDialog(null)} at={t} total={total} />
    </div>
  );
}

function Ruler({ total, pps, onSeek }: { total: number; pps: number; onSeek: (t: number) => void }) {
  const step = pps > 120 ? 1 : pps > 40 ? 2 : pps > 20 ? 5 : 10;
  const ticks = [];
  for (let s = 0; s <= total; s += step) ticks.push(s);
  const seek = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, (e.clientX - r.left) / pps));
  };
  return (
    <div
      className="relative h-7 cursor-pointer border-b border-line bg-panel"
      onPointerDown={(e) => {
        e.stopPropagation();
        seek(e);
        const move = (ev: PointerEvent) => onSeek(Math.max(0, (ev.clientX - (e.currentTarget as HTMLDivElement).getBoundingClientRect().left) / pps));
        const target = e.currentTarget;
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        void target;
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
    >
      {ticks.map((s) => (
        <div key={s} className="absolute top-0 h-full border-l border-line-2 pl-1 font-mono text-[9px] leading-7 text-dim" style={{ left: s * pps }}>
          {formatTime(s).replace(/\.\d$/, "")}
        </div>
      ))}
    </div>
  );
}

function ClipBlock({ clip, pps, color, selected, label, thumb, maxOut, onSelect, onChange }: {
  clip: Clip; pps: number; color: string; selected: boolean; label: string; thumb?: string | null; maxOut: number;
  onSelect: () => void; onChange: (c: Clip, done: boolean) => void;
}) {
  const start = (e: React.PointerEvent, mode: "move" | "l" | "r") => {
    e.stopPropagation();
    onSelect();
    const x0 = e.clientX;
    const orig = { ...clip };
    let latest = orig;
    const move = (ev: PointerEvent) => {
      const d = (ev.clientX - x0) / pps;
      if (mode === "move") latest = { ...orig, start: Math.max(0, orig.start + d) };
      else if (mode === "l") {
        const inPoint = Math.min(orig.outPoint - 0.2, Math.max(0, orig.inPoint + d));
        latest = { ...orig, inPoint, start: Math.max(0, orig.start + (inPoint - orig.inPoint)) };
      } else latest = { ...orig, outPoint: Math.max(orig.inPoint + 0.2, Math.min(maxOut || Infinity, orig.outPoint + d)) };
      onChange(latest, false);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (latest !== orig) onChange(latest, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const w = len(clip) * pps;
  return (
    <div
      onPointerDown={(e) => start(e, "move")}
      className={cn("group absolute top-1.5 bottom-1.5 cursor-grab touch-none overflow-hidden rounded-md border text-[10px] active:cursor-grabbing", selected ? "z-10 ring-2 ring-white/80" : "")}
      style={{ left: clip.start * pps, width: Math.max(6, w), background: `${color}22`, borderColor: `${color}88` }}
      title={label}
    >
      {thumb && clip.track === "VIDEO" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={thumb} alt="" className="pointer-events-none absolute inset-0 size-full object-cover opacity-50" />
      )}
      {clip.track !== "VIDEO" && (
        <svg className="pointer-events-none absolute inset-0 size-full opacity-60" preserveAspectRatio="none" viewBox="0 0 100 20">
          {Array.from({ length: 50 }, (_, i) => {
            const h = 3 + Math.abs(Math.sin(i * 1.7 + clip.start) * Math.cos(i * 0.37)) * 14;
            return <rect key={i} x={i * 2} y={10 - h / 2} width={1.2} height={h} fill={color} />;
          })}
        </svg>
      )}
      {clip.transition !== "none" && clip.track === "VIDEO" && <div className="pointer-events-none absolute inset-y-0 left-0 w-3 bg-gradient-to-r from-white/50 to-transparent" />}
      <span className="pointer-events-none relative z-[1] block truncate px-1.5 pt-1 font-medium text-fg drop-shadow">{label}</span>
      <div onPointerDown={(e) => start(e, "l")} className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/50" />
      <div onPointerDown={(e) => start(e, "r")} className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/50" />
    </div>
  );
}

/** Plays the sequence: mounts media near the playhead and keeps it in sync with the timeline clock. */
function Preview({ clips, t, playing, aspect, posters }: { clips: Clip[]; t: number; playing: boolean; aspect: string; posters: Map<string, string | null> }) {
  const [a1, a2] = aspect.split(":").map(Number);
  const near = clips.filter((c) => c.url && c.start - 3 <= t && c.start + len(c) + 1 >= t);
  const video = near.filter((c) => c.track === "VIDEO").sort((a, b) => a.start - b.start);
  const audio = near.filter((c) => c.track !== "VIDEO");
  const activeVideo = video.filter((c) => t >= c.start && t < c.start + len(c));
  const top = activeVideo[activeVideo.length - 1];
  return (
    <div className="flex min-h-0 items-center justify-center rounded-2xl border border-line bg-black">
      <div className="letterbox relative w-full overflow-hidden" style={{ aspectRatio: `${a1}/${a2}`, maxHeight: "52vh" }}>
        {video.map((c) => {
          const active = activeVideo.includes(c);
          // Crossfade: the incoming clip fades in over the overlap.
          const fadeIn = c.transition !== "none" ? Math.min(1, (t - c.start) / OVERLAP) : 1;
          const opacity = !active ? 0 : c === top ? fadeIn : 1;
          return <SyncedMedia key={c.id} clip={c} t={t} playing={playing && active} kind="video" poster={c.shotId ? posters.get(c.shotId) ?? undefined : undefined} style={{ opacity, zIndex: c === top ? 2 : 1, background: c.transition === "dip" && fadeIn < 1 ? "#000" : undefined }} />;
        })}
        {audio.map((c) => (
          <SyncedMedia key={c.id} clip={c} t={t} playing={playing && t >= c.start && t < c.start + len(c)} kind="audio" />
        ))}
        {!top && <div className="absolute inset-0 grid place-items-center text-sm text-dim">{clips.some((c) => c.track === "VIDEO") ? "—" : "No clips yet"}</div>}
      </div>
    </div>
  );
}

function SyncedMedia({ clip, t, playing, kind, style, poster }: { clip: Clip; t: number; playing: boolean; kind: "video" | "audio"; style?: React.CSSProperties; poster?: string }) {
  const ref = React.useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const local = clip.inPoint + (t - clip.start);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.volume = Math.min(1, clip.volume);
    if (Math.abs(el.currentTime - local) > 0.25 || !playing) el.currentTime = Math.max(0, local);
    if (playing && el.paused) el.play().catch(() => {});
    if (!playing && !el.paused) el.pause();
  }, [local, playing, clip.volume]);
  if (kind === "audio") return <audio ref={ref} src={clip.url!} preload="auto" />;
  return <video ref={ref} src={clip.url!} poster={poster} preload="auto" playsInline muted={false} className="absolute inset-0 size-full object-contain transition-opacity duration-100" style={style} />;
}

function AudioDialog({ kind, onClose, at, total }: { kind: null | "music" | "sfx"; onClose: () => void; at: number; total: number }) {
  const { projectId, state } = useStudio();
  const mood = (state?.project.styleLock as { mood?: string; tone?: string } | undefined) ?? {};
  const [prompt, setPrompt] = React.useState("");
  const [dur, setDur] = React.useState(30);
  React.useEffect(() => {
    if (kind === "music") {
      setPrompt(`Cinematic score, ${[mood.mood, mood.tone].filter(Boolean).join(", ") || "emotional, building"}, strings and piano, slow tempo`);
      setDur(Math.min(180, Math.max(10, Math.round(total))));
    } else if (kind === "sfx") {
      setPrompt("");
      setDur(3);
    }
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open={!!kind} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={kind === "music" ? "Music cue" : "Sound effect"} description={kind === "music" ? "Generated with Magnific (ElevenLabs Music) and placed on the music track." : `Placed at ${formatTime(at)} on the SFX track.`}>
        <div className="space-y-3 p-5">
          <div className="space-y-1.5"><Label>Describe it</Label><Input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={kind === "sfx" ? "thunder crack overhead, distant, rolling" : ""} /></div>
          <div className="space-y-1.5"><Label>Seconds</Label><Input type="number" value={dur} onChange={(e) => setDur(+e.target.value)} /></div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button
              disabled={prompt.trim().length < 3}
              onClick={async () => {
                await api(`/api/projects/${projectId}/audio`, { body: { kind, prompt, durationSec: dur, start: kind === "sfx" ? at : 0 } });
                toast.success(kind === "music" ? "Composing…" : "Designing sound…");
                onClose();
              }}
            >
              <Sparkles /> Generate
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}


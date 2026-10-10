"use client";
import * as React from "react";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/misc";
import { cn, formatTime } from "@/lib/utils";
import { useStudio } from "./store";

/** Watch the cut so far, clip by clip, with the script beside it. */
export function WatchView() {
  const { state, openShot } = useStudio();
  const video = React.useRef<HTMLVideoElement>(null);
  const [i, setI] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const list = React.useMemo(() => {
    if (!state) return [];
    const byShot = new Map(state.shots.map((s) => [s.id, s]));
    return state.clips
      .filter((c) => c.track === "VIDEO" && c.url)
      .sort((a, b) => a.start - b.start)
      .map((c) => ({ clip: c, shot: c.shotId ? byShot.get(c.shotId) : undefined }));
  }, [state]);
  const cur = list[i];
  const panel = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    panel.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [i]);
  const playingRef = React.useRef(playing);
  playingRef.current = playing;
  // On a new clip: jump to its in-point and keep playing if we were.
  React.useEffect(() => {
    const v = video.current;
    if (!v || !cur) return;
    v.currentTime = cur.clip.inPoint;
    if (playingRef.current) v.play().catch(() => setPlaying(false));
  }, [i, cur]);

  if (!state) return null;
  if (!list.length) return <div className="p-6"><Empty icon={<Play />} title="Nothing to watch yet">Make some clips and they play here in story order, with the script beside them.</Empty></div>;
  const total = list.reduce((a, x) => Math.max(a, x.clip.start + (x.clip.outPoint - x.clip.inPoint)), 0);
  const go = (n: number) => setI(Math.max(0, Math.min(list.length - 1, n)));
  const scene = cur?.shot ? state.scenes.find((s) => s.id === cur.shot!.sceneId) : undefined;

  return (
    <div className="grid h-full min-h-0 lg:grid-cols-[1fr_340px]">
      <div className="flex min-h-0 flex-col gap-3 p-4 sm:p-6">
        <div className="flex items-baseline justify-between">
          <h1 className="font-display text-2xl font-bold">Watch film</h1>
          <span className="text-xs text-dim">{list.length} clips · {formatTime(total)}</span>
        </div>
        <div className="relative overflow-hidden rounded-2xl border border-line bg-black">
          <video
            ref={video}
            key={cur?.clip.id}
            src={cur?.clip.url ?? undefined}
            poster={cur?.shot?.imageUrl ?? undefined}
            playsInline
            className="aspect-video w-full object-contain"
            onTimeUpdate={(e) => cur && e.currentTarget.currentTime >= cur.clip.outPoint - 0.04 && (i < list.length - 1 ? go(i + 1) : setPlaying(false))}
            onEnded={() => (i < list.length - 1 ? go(i + 1) : setPlaying(false))}
            onClick={() => setPlaying((p) => { const n = !p; if (n) video.current?.play(); else video.current?.pause(); return n; })}
          />
          {cur?.shot?.dialogue && <div className="pointer-events-none absolute inset-x-0 bottom-6 text-center"><span className="rounded bg-black/70 px-2 py-1 text-sm">{cur.shot.speaker ? `${cur.shot.speaker}: ` : ""}{cur.shot.dialogue}</span></div>}
        </div>
        <div className="flex items-center gap-2">
          <Button size="icon-sm" variant="ghost" onClick={() => go(i - 1)} aria-label="Previous clip"><SkipBack /></Button>
          <Button size="sm" onClick={() => { const n = !playing; setPlaying(n); if (n) video.current?.play(); else video.current?.pause(); }}>{playing ? <Pause /> : <Play />} {playing ? "Pause" : "Play"}</Button>
          <Button size="icon-sm" variant="ghost" onClick={() => go(i + 1)} aria-label="Next clip"><SkipForward /></Button>
          <span className="ml-2 truncate text-xs text-muted">{scene ? `${scene.heading} · ` : ""}#{(cur?.shot?.order ?? i) + 1} {cur?.shot?.title}</span>
          <span className="ml-auto text-xs text-dim">{formatTime(cur?.clip.start ?? 0)}</span>
        </div>
        <div className="flex h-2 overflow-hidden rounded-full bg-panel-3">
          {list.map((x, n) => (
            <button key={x.clip.id} onClick={() => go(n)} className={cn("h-full border-r border-black/40", n < i ? "bg-accent/60" : n === i ? "bg-accent" : "bg-transparent hover:bg-white/10")} style={{ flexGrow: x.clip.outPoint - x.clip.inPoint, flexBasis: 0 }} title={x.shot?.title} />
          ))}
        </div>
      </div>
      <aside ref={panel} className="min-h-0 overflow-y-auto border-l border-line bg-panel/50 p-3">
        <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-widest text-dim">Script</div>
        {list.map((x, n) => {
          const sc = x.shot ? state.scenes.find((s) => s.id === x.shot!.sceneId) : undefined;
          const newScene = sc && (n === 0 || list[n - 1].shot?.sceneId !== sc.id);
          return (
            <React.Fragment key={x.clip.id}>
              {newScene && <div className="mt-3 px-1 font-mono text-[11px] font-semibold text-accent">{sc!.heading}</div>}
              <button data-i={n} onClick={() => go(n)} onDoubleClick={() => x.shot && openShot(x.shot.id)} className={cn("block w-full rounded-lg px-2 py-1.5 text-left text-xs transition", n === i ? "bg-accent/10 text-fg" : "text-muted hover:bg-panel-3")}>
                <span className="font-mono text-dim">#{(x.shot?.order ?? n) + 1}</span> {x.shot?.description || x.shot?.title}
                {x.shot?.dialogue && <span className="mt-0.5 block pl-4 text-fg/90"><span className="uppercase text-dim">{x.shot.speaker}</span> {x.shot.dialogue}</span>}
              </button>
            </React.Fragment>
          );
        })}
      </aside>
    </div>
  );
}

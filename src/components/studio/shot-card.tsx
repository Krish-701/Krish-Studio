"use client";
import * as React from "react";
import { AlertTriangle, CheckCircle2, Film, GripVertical, ImageIcon, Loader2, RotateCcw, Sparkles, Video, XCircle } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { api } from "@/lib/client";
import { latestJob, useStudio, type Shot } from "./store";

function StatusPill({ label, status, progress, icon: Icon }: { label: string; status: string; progress?: number; icon: React.ElementType }) {
  const map: Record<string, string> = {
    IDLE: "text-dim",
    QUEUED: "text-muted",
    GENERATING: "text-accent",
    DONE: "text-ok",
    FAILED: "text-err",
  };
  return (
    <span className={cn("flex items-center gap-1 text-[10px]", map[status])} title={`${label}: ${status.toLowerCase()}`}>
      {status === "GENERATING" ? <Loader2 className="size-3 animate-spin" /> : status === "DONE" ? <CheckCircle2 className="size-3" /> : status === "FAILED" ? <XCircle className="size-3" /> : <Icon className="size-3" />}
      {status === "GENERATING" && progress !== undefined ? `${progress}%` : status === "QUEUED" ? "queued" : null}
    </span>
  );
}

export function ShotCard({ shot, selected, onSelect, selecting }: { shot: Shot; selected: boolean; onSelect: () => void; selecting: boolean }) {
  const { state, openShot } = useStudio();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: shot.id });
  const [hover, setHover] = React.useState(false);
  const imgJob = state ? latestJob(state.jobs, shot.id, ["IMAGE", "UPSCALE", "INPAINT"]) : undefined;
  const vidJob = state ? latestJob(state.jobs, shot.id, ["VIDEO", "EXTEND_VIDEO"]) : undefined;
  const busyJob = [imgJob, vidJob].find((j) => j && (j.status === "RUNNING" || j.status === "QUEUED"));
  const failedJob = [imgJob, vidJob].find((j) => j?.status === "FAILED");
  const findings = state?.findings.filter((f) => f.shotId === shot.id && f.severity !== "info") ?? [];
  const chars = state?.characters.filter((c) => shot.characterIds.includes(c.id)) ?? [];
  const scene = state?.scenes.find((s) => s.id === shot.sceneId);
  const preview = !!(shot.imageMeta as { preview?: boolean } | null)?.preview;
  const [ar1, ar2] = (state?.project.aspectRatio ?? "16:9").split(":").map(Number);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "group relative overflow-hidden rounded-2xl border bg-panel transition-shadow",
        isDragging ? "z-20 border-accent shadow-2xl" : selected ? "border-accent/70 glow-accent" : shot.approved ? "border-ok/40" : "border-line hover:border-line-2",
      )}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button className="relative block w-full overflow-hidden bg-panel-2" style={{ aspectRatio: `${ar1}/${ar2}` }} onClick={() => (selecting ? onSelect() : openShot(shot.id))}>
        {shot.videoUrl && hover ? (
          <video src={shot.videoUrl} autoPlay muted loop playsInline className="size-full object-cover" />
        ) : shot.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shot.imageUrl} alt={shot.title} className="size-full object-cover transition duration-500 group-hover:scale-[1.03]" loading="lazy" />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 bg-[radial-gradient(ellipse_at_center,rgb(255_255_255/0.03),transparent_70%)] p-4 text-center">
            <ImageIcon className="size-6 text-dim" />
            <span className="line-clamp-3 text-[11px] text-dim">{shot.description || shot.prompt}</span>
          </div>
        )}
        {busyJob && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 backdrop-blur-[2px]">
            <div className="shimmer absolute inset-0" />
            <div className="relative grid size-12 place-items-center">
              <svg className="absolute inset-0 -rotate-90" viewBox="0 0 36 36">
                <circle cx="18" cy="18" r="15" fill="none" stroke="rgb(255 255 255 / 0.1)" strokeWidth="3" />
                <circle cx="18" cy="18" r="15" fill="none" stroke="url(#g)" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${(busyJob.progress / 100) * 94} 94`} className="transition-[stroke-dasharray] duration-500" />
                <defs><linearGradient id="g"><stop offset="0" stopColor="#f5a524" /><stop offset="1" stopColor="#ff6b3d" /></linearGradient></defs>
              </svg>
              <span className="text-[10px] font-semibold">{busyJob.status === "QUEUED" ? "…" : `${busyJob.progress}%`}</span>
            </div>
            <span className="relative max-w-[90%] truncate text-[10px] text-fg/80">{busyJob.type === "VIDEO" ? "Clip · " : ""}{busyJob.step ?? "Queued"}</span>
          </div>
        )}
        {!busyJob && failedJob && (
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-err/90 px-2 py-1 text-[10px] text-black">
            <XCircle className="size-3 shrink-0" />
            <span className="truncate">{failedJob.error}</span>
            <span
              role="button"
              onClick={(e) => {
                e.stopPropagation();
                api(`/api/jobs/${failedJob.id}`, { body: { action: "retry" } });
              }}
              className="ml-auto flex shrink-0 items-center gap-0.5 rounded bg-black/20 px-1.5 py-0.5 font-semibold"
            >
              <RotateCcw className="size-2.5" /> Retry
            </span>
          </div>
        )}
        <span className="absolute left-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[10px] font-semibold backdrop-blur">#{shot.order + 1}</span>
        <div className="absolute right-2 top-2 flex gap-1">
          {shot.videoUrl && <span className="rounded-md bg-black/70 p-1 backdrop-blur" title="Clip ready"><Film className="size-3 text-cyan" /></span>}
          {shot.approved && <span className="rounded-md bg-ok/90 p-1 text-black" title="Approved"><CheckCircle2 className="size-3" /></span>}
          {findings.length > 0 && <span className="rounded-md bg-warn/90 p-1 text-black" title={findings.map((f) => f.message).join("\n")}><AlertTriangle className="size-3" /></span>}
          {preview && <span className="rounded-md bg-black/70 px-1 py-0.5 text-[9px] text-dim" title="Offline preview frame">PREVIEW</span>}
        </div>
        {selecting && (
          <span className={cn("absolute bottom-2 left-2 grid size-5 place-items-center rounded-md border-2", selected ? "border-accent bg-accent text-black" : "border-white/60 bg-black/40")}>
            {selected && <CheckCircle2 className="size-3" />}
          </span>
        )}
      </button>
      <div className="flex items-start gap-1.5 p-2.5">
        <button {...attributes} {...listeners} className="mt-0.5 cursor-grab touch-none text-dim hover:text-fg active:cursor-grabbing" aria-label="Drag to reorder">
          <GripVertical className="size-3.5" />
        </button>
        <div className="min-w-0 flex-1 cursor-pointer" onClick={() => (selecting ? onSelect() : openShot(shot.id))}>
          <div className="truncate text-[13px] font-medium leading-tight">{shot.title}</div>
          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-dim">
            {scene && <span className="truncate">S{scene.index + 1}</span>}
            <span>·</span>
            <span className="truncate uppercase">{shot.shotType?.replace(/_/g, " ") ?? "shot"}</span>
            <span>·</span>
            <span>{shot.durationSec}s</span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <StatusPill label="Frame" status={shot.imageStatus} progress={imgJob?.status === "RUNNING" ? imgJob.progress : undefined} icon={ImageIcon} />
            <StatusPill label="Clip" status={shot.videoStatus} progress={vidJob?.status === "RUNNING" ? vidJob.progress : undefined} icon={Video} />
            {shot.dialogue && <StatusPill label="Voice" status={shot.audioStatus} icon={Sparkles} />}
            <div className="ml-auto flex -space-x-1">
              {chars.slice(0, 4).map((c) => (
                <span key={c.id} title={c.name} className="grid size-4 place-items-center rounded-full border border-panel text-[8px] font-bold text-black" style={{ background: c.color }}>
                  {c.name[0]}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

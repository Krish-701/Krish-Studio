"use client";
import * as React from "react";
import { Check, FileText, Film, LayoutGrid, Music, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStudio, type View } from "./store";

/** Step-by-step production progress: Script → Storyboard → Video → Audio → Export. */
export function usePipeline() {
  const { state } = useStudio();
  return React.useMemo(() => {
    if (!state) return [];
    const shots = state.shots;
    const n = shots.length || 1;
    const parsing = state.jobs.find((j) => j.type === "PARSE_SCRIPT" && ["QUEUED", "RUNNING"].includes(j.status));
    const frames = shots.filter((s) => s.imageAssetId).length;
    const clips = shots.filter((s) => s.videoAssetId).length;
    const dialogue = shots.filter((s) => s.dialogue);
    const voiced = state.clips.filter((c) => c.track === "VOICE").length;
    const music = state.clips.some((c) => c.track === "MUSIC");
    const exported = state.assets.some((a) => a.role === "EXPORT" && a.kind === "VIDEO");
    const busy = (types: string[]) => state.jobs.some((j) => types.includes(j.type) && ["QUEUED", "RUNNING"].includes(j.status));
    const failed = (types: string[]) => state.jobs.filter((j) => types.includes(j.type) && j.status === "FAILED").length;
    const audioTotal = dialogue.length + 1;
    const audioDone = Math.min(voiced, dialogue.length) + (music ? 1 : 0);
    return [
      { key: "SCRIPT", label: "Script", view: "script" as View, icon: FileText, pct: shots.length ? 100 : parsing ? parsing.progress : 0, busy: !!parsing, failed: failed(["PARSE_SCRIPT"]), detail: shots.length ? `${state.scenes.length} scenes · ${shots.length} shots` : parsing ? parsing.step ?? "Parsing…" : "Upload a script" },
      { key: "STORYBOARD", label: "Storyboard", view: "storyboard" as View, icon: LayoutGrid, pct: shots.length ? (frames / n) * 100 : 0, busy: busy(["IMAGE", "UPSCALE", "INPAINT"]), failed: failed(["IMAGE"]), detail: `${frames}/${shots.length} frames` },
      { key: "VIDEO", label: "Video", view: "timeline" as View, icon: Film, pct: shots.length ? (clips / n) * 100 : 0, busy: busy(["VIDEO"]), failed: failed(["VIDEO"]), detail: `${clips}/${shots.length} clips` },
      { key: "AUDIO", label: "Audio", view: "timeline" as View, icon: Music, pct: (audioDone / audioTotal) * 100, busy: busy(["TTS", "MUSIC", "SFX"]), failed: failed(["TTS", "MUSIC", "SFX"]), detail: `${Math.min(voiced, dialogue.length)}/${dialogue.length} lines${music ? " · score" : ""}` },
      { key: "EXPORT", label: "Export", view: "export" as View, icon: Download, pct: exported ? 100 : busy(["EXPORT_MP4"]) ? state.jobs.find((j) => j.type === "EXPORT_MP4")?.progress ?? 0 : 0, busy: busy(["EXPORT_MP4", "EXPORT_PDF"]), failed: failed(["EXPORT_MP4", "EXPORT_PDF"]), detail: exported ? "Master ready" : "Not rendered" },
    ];
  }, [state]);
}

export function Pipeline({ compact }: { compact?: boolean }) {
  const steps = usePipeline();
  const { setView } = useStudio();
  return (
    <ol className="flex items-center gap-1">
      {steps.map((s, i) => {
        const done = s.pct >= 99.5;
        const Icon = s.icon;
        return (
          <React.Fragment key={s.key}>
            {i > 0 && <li aria-hidden className={cn("hidden h-px w-4 lg:block xl:w-8", steps[i - 1].pct >= 99.5 ? "bg-accent/60" : "bg-line-2")} />}
            <li>
              <button
                onClick={() => setView(s.view)}
                title={`${s.label}: ${s.detail}`}
                className={cn(
                  "group relative flex items-center gap-2 rounded-xl border px-2 py-1.5 text-left transition",
                  done ? "border-accent/30 bg-accent/5" : s.busy ? "border-accent/50 bg-panel-2" : "border-line bg-panel-2 hover:border-line-2",
                )}
              >
                <span
                  className={cn(
                    "relative grid size-7 shrink-0 place-items-center rounded-lg",
                    done ? "bg-gradient-to-br from-accent to-accent-2 text-black" : s.busy ? "bg-accent/15 text-accent animate-pulse-ring" : "bg-panel-3 text-muted",
                  )}
                >
                  {done ? <Check className="size-3.5" strokeWidth={3} /> : <Icon className="size-3.5" />}
                  {s.failed > 0 && <span className="absolute -right-1 -top-1 grid size-3.5 place-items-center rounded-full bg-err text-[8px] font-bold text-black">{s.failed}</span>}
                </span>
                {!compact && (
                  <span className="hidden min-w-0 md:block">
                    <span className="block text-[11px] font-semibold leading-tight">{s.label}</span>
                    <span className="block max-w-[110px] truncate text-[10px] leading-tight text-dim">{s.detail}</span>
                  </span>
                )}
                <span className="absolute inset-x-2 -bottom-px h-[2px] overflow-hidden rounded-full bg-transparent">
                  <span className={cn("block h-full bg-gradient-to-r from-accent to-accent-2 transition-[width] duration-700", s.busy && "shimmer")} style={{ width: `${s.pct}%` }} />
                </span>
              </button>
            </li>
          </React.Fragment>
        );
      })}
    </ol>
  );
}

"use client";
import * as React from "react";
import { Download, FileText, Film, Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/misc";
import { api } from "@/lib/client";
import { formatTime } from "@/lib/utils";
import { useStudio } from "./store";

export function ExportView() {
  const { state, projectId } = useStudio();
  if (!state) return null;
  const exports = state.assets.filter((a) => a.role === "EXPORT");
  const running = state.jobs.filter((j) => ["EXPORT_MP4", "EXPORT_PDF"].includes(j.type) && ["QUEUED", "RUNNING"].includes(j.status));
  const lastFail = state.jobs.find((j) => ["EXPORT_MP4", "EXPORT_PDF"].includes(j.type));
  const clips = state.clips.filter((c) => c.track === "VIDEO").length;
  const missing = state.shots.filter((s) => !s.videoAssetId).length;
  const latestFilm = exports.find((e) => e.kind === "VIDEO");

  const start = async (type: "mp4" | "pdf") => {
    await api(`/api/projects/${projectId}/export`, { body: { type } });
    toast.success(type === "mp4" ? "Rendering the film…" : "Building the storyboard PDF…");
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="font-display text-2xl font-bold">Export</h1>
        <p className="text-sm text-muted">Render the timeline to an MP4 master, or print the storyboard.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-line bg-panel p-5">
          <Film className="size-6 text-accent" />
          <div className="mt-3 font-display text-lg font-semibold">Film · MP4</div>
          <p className="mt-1 text-sm text-muted">{clips} clips with transitions, voice, music and SFX mixed. H.264 / AAC, 1080p.</p>
          {missing > 0 && <p className="mt-2 text-xs text-warn">{missing} shot(s) have no clip yet and will be skipped.</p>}
          <Button className="mt-4" onClick={() => start("mp4")} disabled={!clips || running.some((j) => j.type === "EXPORT_MP4")}>
            <Film /> Render film
          </Button>
        </div>
        <div className="rounded-2xl border border-line bg-panel p-5">
          <FileText className="size-6 text-cyan" />
          <div className="mt-3 font-display text-lg font-semibold">Storyboard · PDF</div>
          <p className="mt-1 text-sm text-muted">{state.shots.length} shots, six per page, with framing, camera, timing and dialogue.</p>
          <Button className="mt-4" variant="secondary" onClick={() => start("pdf")} disabled={!state.shots.length || running.some((j) => j.type === "EXPORT_PDF")}>
            <FileText /> Export PDF
          </Button>
        </div>
      </div>

      {running.map((j) => (
        <div key={j.id} className="rounded-2xl border border-accent/40 bg-accent/5 p-4">
          <div className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin text-accent" /> {j.type === "EXPORT_MP4" ? "Rendering film" : "Building PDF"} · {j.step}</div>
          <Progress value={j.progress} className="mt-3" />
        </div>
      ))}
      {lastFail?.status === "FAILED" && <div className="rounded-xl border border-err/30 bg-err/5 p-3 text-sm text-err">Last export failed: {lastFail.error}</div>}

      {latestFilm && (
        <div className="overflow-hidden rounded-2xl border border-line bg-black">
          <video src={latestFilm.url} controls playsInline className="w-full" />
        </div>
      )}

      <div className="space-y-2">
        <h2 className="font-display text-lg font-semibold">Exports</h2>
        {!exports.length && <div className="rounded-xl border border-dashed border-line-2 p-6 text-center text-sm text-dim">Nothing exported yet.</div>}
        {exports.map((e) => (
          <div key={e.id} className="flex items-center gap-3 rounded-xl border border-line bg-panel p-3">
            {e.kind === "VIDEO" ? <Play className="size-4 text-accent" /> : <FileText className="size-4 text-cyan" />}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{e.name}</div>
              <div className="text-xs text-dim">{new Date(e.createdAt).toLocaleString()}{e.durationSec ? ` · ${formatTime(e.durationSec)}` : ""}</div>
            </div>
            <Button size="sm" variant="secondary" asChild>
              <a href={e.url} download={e.name ?? undefined} target="_blank" rel="noreferrer"><Download /> Download</a>
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

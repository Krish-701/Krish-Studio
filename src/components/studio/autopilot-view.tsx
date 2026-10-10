"use client";
import * as React from "react";
import { Check, Gauge, Loader2, Pause, Play, Rocket, Sparkles, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import { useStudio } from "./store";
import { useModels } from "./use-models";

/** Mirrors src/lib/script/score.ts and src/worker/autopilot.ts (kept client-safe). */
const BLOCK = 6;
const READY = 8.5;
const STAGES = [
  { id: "score", label: "Story score" },
  { id: "write", label: "Write" },
  { id: "design", label: "Design" },
  { id: "frames", label: "Frames" },
  { id: "clips", label: "Clips" },
  { id: "sound", label: "Sound" },
  { id: "export", label: "Export" },
] as const;

interface Score {
  score: number;
  verdict: "rework" | "improve" | "ready";
  breakdown: { criterion: string; name: string; score: number; note: string }[];
  strengths: string[];
  fixes: string[];
  summary: string;
  method: "ai" | "estimate";
  rounds?: number;
  history?: { score: number; at: string }[];
}
interface Autopilot {
  status: "running" | "paused" | "needs_input" | "done" | "failed";
  stage: string;
  message?: string;
}

const tone = (s: number) => (s < BLOCK ? "text-err" : s < READY ? "text-warn" : "text-ok");
const bar = (s: number) => (s < BLOCK ? "bg-err" : s < READY ? "bg-warn" : "bg-ok");

/** The brief: the filmmaker's basic suggestions and prompt, given to every agent on this project. */
export function BriefBox({ className }: { className?: string }) {
  const { state, projectId } = useStudio();
  const p = state!.project;
  const [brief, setBrief] = React.useState(p.brief ?? "");
  React.useEffect(() => setBrief(p.brief ?? ""), [p.brief]);
  const save = async () => {
    if ((p.brief ?? "") === brief) return;
    await api(`/api/projects/${projectId}`, { method: "PATCH", body: { brief } });
    toast.success("Brief saved. Every agent follows it from now on.");
  };
  return (
    <div className={className}>
      <div className="mb-1.5 text-xs font-medium text-muted">Your brief to the agents</div>
      <Textarea
        rows={4}
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        onBlur={save}
        placeholder="Basic suggestions and your prompt for the crew, e.g. 'Keep it hopeful, no gore. Long, slow shots at sea; fast cuts in the storm. Maya never smiles until the end.'"
      />
    </div>
  );
}

export function StoryGate({ compact }: { compact?: boolean }) {
  const { state, projectId, setView } = useStudio();
  const p = state!.project;
  const score = p.storyScore as unknown as Score | null;
  const ap = p.autopilot as unknown as Autopilot | null;
  const scoring = state!.jobs.find((j) => j.type === "STORY_SCORE" && (j.status === "QUEUED" || j.status === "RUNNING"));
  const pilot = state!.jobs.find((j) => j.type === "AUTOPILOT" && (j.status === "QUEUED" || j.status === "RUNNING"));
  const [busy, setBusy] = React.useState<string | null>(null);
  const hasStory = !!(p.synopsis?.trim() || p.logline?.trim() || state!.sequences.length || p.scriptText?.trim());

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const scoreIt = (improve: boolean) => run(improve ? "improve" : "score", () => api(`/api/projects/${projectId}/score`, { body: { improve } }), improve ? "The Script Doctor is improving your story to 8.5+" : "Scoring your story");
  const start = (force = false) =>
    run("start", async () => {
      await api(`/api/projects/${projectId}/autopilot`, { body: { action: "start", force } });
      if (!compact) return;
      setView("autopilot");
    }, "Autopilot started. Progress shows here, in the Log tab and in the Director chat.");
  const pause = () => run("pause", () => api(`/api/projects/${projectId}/autopilot`, { body: { action: "pause" } }), "Autopilot paused");

  const s = score?.score ?? null;
  const blocked = s !== null && score?.method === "ai" && s < BLOCK;
  const running = ap?.status === "running" && !!pilot;
  const stageIdx = STAGES.findIndex((x) => x.id === ap?.stage);

  return (
    <div className={cn("space-y-4 rounded-2xl border border-line bg-panel p-5 text-left", compact && "p-4")}>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-3">
          <Gauge className="size-8 text-accent" />
          <div>
            <div className="text-xs text-muted">Story score</div>
            <div className={cn("font-display text-3xl font-bold leading-none", s === null ? "text-dim" : tone(s))}>
              {s === null ? "–" : s.toFixed(1)}
              <span className="text-base text-dim">/10</span>
            </div>
          </div>
        </div>
        <div className="min-w-0 flex-1 text-xs text-muted">
          {scoring ? (
            <span className="flex items-center gap-1.5"><Loader2 className="size-3.5 animate-spin" /> {scoring.step || "Script Doctor is reading your story"}</span>
          ) : s === null ? (
            "Before anything is made, the Script Doctor scores your story out of 10. Under 6 you'll be asked to change it; it can rewrite it to 8.5+ for you."
          ) : s < BLOCK ? (
            <span className="text-err">Under {BLOCK}: please change the story before production (see the fixes below), then score again.</span>
          ) : s < READY ? (
            <span className="text-warn">Good, not great. Improve it to {READY}+ before the full autopilot, or start anyway.</span>
          ) : (
            <span className="text-ok">Ready. Start the full autopilot whenever you like.</span>
          )}
          {score?.method === "estimate" && <div className="mt-1 text-dim">Estimate only: add an AI model in Settings for a real review.</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" disabled={!hasStory || !!busy || !!scoring} onClick={() => scoreIt(false)}>
            {busy === "score" ? <Loader2 className="animate-spin" /> : <Gauge />} {s === null ? "Score my story" : "Score again"}
          </Button>
          {s !== null && s < READY && (
            <Button variant="outline" size="sm" disabled={!!busy || !!scoring} onClick={() => scoreIt(true)}>
              {busy === "improve" ? <Loader2 className="animate-spin" /> : <Wand2 />} Improve to {READY}+
            </Button>
          )}
        </div>
      </div>

      {score && !compact && (
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {score.breakdown.map((b) => (
            <div key={b.criterion} title={b.note}>
              <div className="flex justify-between text-[11px]"><span className="text-muted">{b.name}</span><span className={tone(b.score)}>{b.score.toFixed(1)}</span></div>
              <div className="mt-0.5 h-1.5 rounded-full bg-panel-3"><div className={cn("h-full rounded-full", bar(b.score))} style={{ width: `${b.score * 10}%` }} /></div>
              <div className="mt-0.5 line-clamp-2 text-[11px] text-dim">{b.note}</div>
            </div>
          ))}
        </div>
      )}
      {score && score.fixes.length > 0 && (s ?? 10) < READY && (
        <div className="rounded-lg bg-panel-2 p-3 text-xs">
          <div className="mb-1 font-medium text-fg">What would lift it</div>
          <ul className="list-disc space-y-0.5 pl-4 text-muted">{score.fixes.slice(0, compact ? 3 : 8).map((f, i) => <li key={i}>{f}</li>)}</ul>
        </div>
      )}
      {score?.summary && !compact && <p className="text-xs text-muted">{score.summary}</p>}
      {score?.history && score.history.length > 1 && (
        <div className="flex items-center gap-1.5 text-[11px] text-dim">History: {score.history.map((h, i) => <span key={i} className={tone(h.score)}>{h.score.toFixed(1)}{i < score.history!.length - 1 ? " →" : ""}</span>)}</div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Rocket className="size-5 text-accent" />
        <div className="mr-auto text-sm font-medium">
          Full autopilot
          <div className="text-[11px] font-normal text-muted">Writes, designs, draws, animates, scores and exports on its own. The agent picks every shot&apos;s length (3–15 s) from the story.</div>
        </div>
        {running ? (
          <Button variant="secondary" disabled={!!busy} onClick={pause}><Pause /> Pause</Button>
        ) : (
          <>
            <Button disabled={!hasStory || blocked || !!busy || !!scoring} onClick={() => start(false)} title={blocked ? `Story is under ${BLOCK}/10` : undefined}>
              {busy === "start" ? <Loader2 className="animate-spin" /> : <Play />} {ap?.status === "paused" ? "Resume autopilot" : s !== null && s < READY ? "Improve & start autopilot" : "Start full autopilot"}
            </Button>
            {ap?.status === "needs_input" && s !== null && s >= BLOCK && <Button variant="outline" disabled={!!busy} onClick={() => start(true)}>Start anyway</Button>}
          </>
        )}
      </div>

      {ap && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1">
            {STAGES.map((st, i) => {
              const done = ap.stage === "done" || i < stageIdx;
              const now = i === stageIdx && ap.stage !== "done";
              return (
                <div key={st.id} className={cn("flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]", done ? "border-ok/30 text-ok" : now ? "border-accent/50 text-accent" : "border-line-2 text-dim")}>
                  {done ? <Check className="size-3" /> : now && running ? <Loader2 className="size-3 animate-spin" /> : null}
                  {st.label}
                </div>
              );
            })}
          </div>
          <div className="flex items-start gap-2 text-xs">
            <Badge tone={ap.status === "done" ? "ok" : ap.status === "needs_input" ? "warn" : ap.status === "running" ? "accent" : "neutral"}>{ap.status.replace("_", " ")}</Badge>
            <span className="whitespace-pre-line text-muted">{pilot?.step || ap.message}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Autopilot page: the story gate, the brief, the models the agent will use, and the run's progress. */
export function AutopilotView() {
  const { state } = useStudio();
  const { image: imageModels, video: videoModels } = useModels();
  const p = state!.project;
  const d = (p.defaults as Record<string, string> | null) ?? {};
  const img = imageModels.find((m) => m.slug === d.image);
  const vid = videoModels.find((m) => m.slug === d.video);
  const alt = videoModels.find((m) => m.slug === (d.videoAlt || "wan-3-0-prime"));
  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
      <div>
        <h1 className="flex items-center gap-2 font-display text-2xl font-bold"><Sparkles className="size-6 text-accent" /> Autopilot</h1>
        <p className="mt-1 text-sm text-muted">You set the runtime and the story. The agents score it, improve it, then make the whole film. Talk to the Director at any time; it learns from what you say on this project.</p>
      </div>
      <StoryGate />
      <div className="grid gap-4 sm:grid-cols-2">
        <BriefBox className="rounded-2xl border border-line bg-panel p-4" />
        <div className="space-y-2 rounded-2xl border border-line bg-panel p-4 text-xs">
          <div className="font-medium text-muted">Models the agent uses (Freepik)</div>
          <div><span className="text-dim">Frames:</span> {img?.name ?? d.image ?? "GPT Image 2.5"}{d.imageVariant && !(img?.name ?? "").toLowerCase().includes(d.imageVariant.toLowerCase()) ? ` (${d.imageVariant})` : ""}</div>
          <div><span className="text-dim">Clips:</span> {vid?.name ?? d.video ?? "Seedance 2.5"} · {p.resolution}</div>
          <div><span className="text-dim">Alternative:</span> {alt?.name ?? "Wan 3.0 Prime"} · 720p</div>
          <p className="text-dim">Ask the Director to switch models for a scene or the whole film; it can pick any image or video model in the catalog.</p>
        </div>
      </div>
    </div>
  );
}

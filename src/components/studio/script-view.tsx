"use client";
import * as React from "react";
import { FileText, Loader2, RefreshCw, Sparkles, Upload, Users, Film, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Progress } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/client";
import { useStudio } from "./store";

export function ScriptView() {
  const { state, projectId, setView, openShot } = useStudio();
  const [text, setText] = React.useState(state?.project.scriptText ?? "");
  const [drag, setDrag] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [editing, setEditing] = React.useState(!state?.project.scriptText);
  if (!state) return null;
  const parse = state.jobs.find((j) => j.type === "PARSE_SCRIPT");
  const parsing = parse && ["QUEUED", "RUNNING"].includes(parse.status);
  const out = parse?.output as { method?: string } | null;

  const upload = async (body: FormData) => {
    if (state.shots.length && !confirm("Re-parsing replaces the current scenes and shots (characters are kept). Continue?")) return;
    setBusy(true);
    try {
      await api(`/api/projects/${projectId}/script`, { form: body });
      toast.success("Breaking the script into scenes and shots…");
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };
  const uploadFile = (f: File) => {
    const form = new FormData();
    form.append("file", f);
    upload(form);
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Script</h1>
          <p className="text-sm text-muted">Upload a screenplay or treatment. The Director breaks it into scenes, shots and characters.</p>
        </div>
        {state.shots.length > 0 && (
          <Button onClick={() => setView("storyboard")}>
            Open storyboard <ChevronRight />
          </Button>
        )}
      </div>

      {parsing && (
        <div className="rounded-2xl border border-accent/40 bg-accent/5 p-4 glow-accent">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Loader2 className="size-4 animate-spin text-accent" /> {parse.step ?? "Parsing script…"}
          </div>
          <Progress value={parse.progress} className="mt-3" />
        </div>
      )}
      {parse?.status === "FAILED" && <div className="rounded-xl border border-err/30 bg-err/5 p-3 text-sm text-err">Parsing failed: {parse.error}</div>}

      <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr]">
        <div className="space-y-3">
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              const f = e.dataTransfer.files[0];
              if (f) uploadFile(f);
            }}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition ${drag ? "border-accent bg-accent/5" : "border-line-2 bg-panel hover:border-accent/40"}`}
          >
            {busy ? <Loader2 className="mb-3 size-8 animate-spin text-accent" /> : <Upload className="mb-3 size-8 text-muted" />}
            <div className="font-display font-semibold">Drop your script here</div>
            <div className="mt-1 text-xs text-muted">PDF · Final Draft (.fdx) · Fountain · TXT</div>
            <input type="file" className="hidden" accept=".pdf,.txt,.fountain,.fdx,.md,text/plain,application/pdf" onChange={(e) => e.target.files?.[0] && uploadFile(e.target.files[0])} />
          </label>

          <div className="rounded-2xl border border-line bg-panel">
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <span className="flex items-center gap-2 text-sm font-medium"><FileText className="size-4 text-accent" /> Script text</span>
              <div className="flex gap-2">
                {!editing && <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>}
                <Button
                  size="xs"
                  disabled={busy || parsing || text.trim().length < 20}
                  onClick={() => {
                    const form = new FormData();
                    form.append("text", text);
                    upload(form);
                  }}
                >
                  {state.shots.length ? <RefreshCw /> : <Sparkles />} {state.shots.length ? "Re-parse" : "Break down"}
                </Button>
              </div>
            </div>
            {editing ? (
              <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={22} className="rounded-none rounded-b-2xl border-0 bg-transparent font-mono text-xs leading-relaxed focus:ring-0" placeholder={"INT. LIGHTHOUSE - NIGHT\n\nRain hammers the glass. MARA (60s), weathered, trims the wick.\n\nMARA\nNobody comes out here in a storm.\n…"} />
            ) : (
              <pre className="max-h-[560px] overflow-y-auto whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed text-muted">{state.project.scriptText}</pre>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <h2 className="font-display text-lg font-semibold">Breakdown</h2>
            {out?.method && <Badge tone={out.method === "ai" ? "accent" : "neutral"}>{out.method === "ai" ? "AI breakdown" : "Rule-based breakdown"}</Badge>}
            <div className="ml-auto flex gap-3 text-xs text-muted">
              <span className="flex items-center gap-1"><Film className="size-3" /> {state.shots.length} shots</span>
              <button onClick={() => setView("characters")} className="flex items-center gap-1 hover:text-fg"><Users className="size-3" /> {state.characters.length} characters</button>
            </div>
          </div>
          {!state.scenes.length && <div className="rounded-2xl border border-dashed border-line-2 p-10 text-center text-sm text-dim">Scenes and shots appear here after parsing.</div>}
          <div className="space-y-3">
            {state.scenes.map((sc) => {
              const shots = state.shots.filter((s) => s.sceneId === sc.id);
              return (
                <div key={sc.id} className="rounded-2xl border border-line bg-panel">
                  <div className="border-b border-line px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-accent">{String(sc.index + 1).padStart(2, "0")}</span>
                      <span className="font-display text-sm font-semibold tracking-wide">{sc.heading}</span>
                      <span className="ml-auto text-[11px] text-dim">{shots.length} shots · {shots.reduce((n, s) => n + s.durationSec, 0).toFixed(0)}s</span>
                    </div>
                    {sc.summary && <div className="mt-1 line-clamp-2 text-xs text-muted">{sc.summary}</div>}
                  </div>
                  <ol className="divide-y divide-line">
                    {shots.map((s) => (
                      <li key={s.id}>
                        <button onClick={() => openShot(s.id)} className="flex w-full items-start gap-3 px-4 py-2 text-left transition hover:bg-panel-2">
                          <span className="mt-0.5 w-6 shrink-0 font-mono text-[11px] text-dim">#{s.order + 1}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm">{s.title}</span>
                            {s.dialogue && <span className="block truncate text-xs text-cyan/80">“{s.dialogue}”</span>}
                          </span>
                          <span className="shrink-0 text-[10px] uppercase text-dim">{s.shotType?.replace(/_/g, " ")}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

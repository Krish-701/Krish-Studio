"use client";
import * as React from "react";
import useSWR from "swr";
import { Activity, AlertTriangle, Bot, Brain, Check, Pencil, Pin, Plus, CircleSlash, Info, ListChecks, Loader2, RotateCcw, ScrollText, Send, Sparkles, Trash2, Wand2, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger, Progress } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { api, fetcher } from "@/lib/client";
import { AGENTS, AGENT_LIST } from "@/lib/agents/definitions";
import { cn } from "@/lib/utils";
import { useStudio, type Job } from "./store";
import { LogPanel } from "./log-panel";

export function RightPanel() {
  const { state, agents } = useStudio();
  const findings = state?.findings.length ?? 0;
  const active = state?.jobs.filter((j) => ["QUEUED", "RUNNING"].includes(j.status)).length ?? 0;
  const failed = state?.jobs.filter((j) => j.status === "FAILED").length ?? 0;
  const anyThinking = Object.values(agents).some((a) => a.status !== "idle" && Date.now() - a.at < 120_000);
  return (
    <Tabs defaultValue="director" className="flex min-h-0 w-full flex-1 flex-col">
      <TabsList className="overflow-x-auto [scrollbar-width:none]">
        <TabsTrigger value="director">
          <Bot className="size-3.5" /> Director {anyThinking && <span className="size-1.5 animate-pulse rounded-full bg-accent" />}
        </TabsTrigger>
        <TabsTrigger value="agents">
          <Sparkles className="size-3.5" /> Agents {findings > 0 && <Badge tone="warn" className="px-1 py-0">{findings}</Badge>}
        </TabsTrigger>
        <TabsTrigger value="memory">
          <Brain className="size-3.5" /> Memory
        </TabsTrigger>
        <TabsTrigger value="queue">
          <Activity className="size-3.5" /> Queue {active > 0 && <Badge tone="accent" className="px-1 py-0">{active}</Badge>}
          {failed > 0 && <Badge tone="err" className="px-1 py-0">{failed}</Badge>}
        </TabsTrigger>
        <TabsTrigger value="log">
          <ScrollText className="size-3.5" /> Log
        </TabsTrigger>
      </TabsList>
      <TabsContent value="director" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
        <Chat />
      </TabsContent>
      <TabsContent value="agents" className="min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden">
        <AgentsPanel />
      </TabsContent>
      <TabsContent value="memory" className="min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden">
        <MemoryPanel />
      </TabsContent>
      <TabsContent value="queue" className="min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden">
        <QueuePanel />
      </TabsContent>
      <TabsContent value="log" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
        <LogPanel />
      </TabsContent>
    </Tabs>
  );
}

interface Msg {
  id: string;
  agent: string;
  role: string;
  content: string;
  toolCalls?: { args?: unknown; result?: unknown } | null;
  createdAt: string;
}

const SUGGESTIONS = [
  "Break the script into shots and suggest a visual style",
  "Check every character for consistency",
  "Generate storyboard frames for all missing shots",
  "Animate all approved frames into clips",
  "Add voiceover for every dialogue line and a score",
  "What's failing and why?",
];

const TOOL_LABEL: Record<string, string> = {
  generate_images: "queued frames",
  generate_videos: "queued clips",
  update_shot: "edited a shot",
  create_shot: "added a shot",
  delete_shot: "deleted a shot",
  reorder_shots: "reordered shots",
  set_style_lock: "locked the style",
  update_character: "updated a character",
  report_finding: "logged a finding",
  spawn_subagent: "briefed a sub-agent",
  generate_voiceover: "queued voiceover",
  generate_music: "queued music",
  generate_sfx: "queued SFX",
  retry_failed: "retried failures",
  export_film: "started export",
  export_storyboard_pdf: "started PDF export",
  memory_write: "saved to memory",
  memory_delete: "removed a memory",
  memory_search: "read memory",
};

function Chat() {
  const { projectId, streaming, chatVersion, agents } = useStudio();
  const { data, mutate } = useSWR<Msg[]>(`/api/projects/${projectId}/agent`, fetcher);
  const [input, setInput] = React.useState("");
  const [target, setTarget] = React.useState("DIRECTOR");
  const [pending, setPending] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const scroller = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    mutate();
  }, [chatVersion, mutate]);
  React.useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [data, streaming, pending]);

  const send = async (text?: string) => {
    const message = (text ?? input).trim();
    if (!message || sending) return;
    setInput("");
    setPending(message);
    setSending(true);
    try {
      await api(`/api/projects/${projectId}/agent`, { body: { message, agent: target } });
    } catch {
    } finally {
      setPending(null);
      setSending(false);
      mutate();
    }
  };

  const live = Object.entries(agents).filter(([, a]) => a.status !== "idle" && Date.now() - a.at < 120_000);

  return (
    <>
      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {!data?.length && !pending && (
          <div className="rounded-2xl border border-line bg-panel-2 p-4">
            <div className="flex items-center gap-2 font-display text-sm font-semibold">
              <span className="grid size-7 place-items-center rounded-lg bg-accent/15 text-accent"><Bot className="size-4" /></span>
              Director
            </div>
            <p className="mt-2 text-sm text-muted">I run the crew. Ask me to break down the script, write prompts, generate frames or clips, fix consistency, add audio or export. I brief the specialist agents for you.</p>
            <div className="mt-3 flex flex-col gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-lg border border-line-2 px-3 py-1.5 text-left text-xs text-muted transition hover:border-accent/40 hover:text-fg">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {data?.map((m) => <MessageRow key={m.id} m={m} />)}
        {pending && <MessageRow m={{ id: "p", agent: "USER", role: "user", content: target === "DIRECTOR" ? pending : `@${target.toLowerCase()} ${pending}`, createdAt: "" }} />}
        {streaming && <MessageRow m={{ id: "s", agent: streaming.agent, role: "assistant", content: streaming.text, createdAt: "" }} streaming />}
        {sending && !streaming && (
          <div className="flex items-center gap-2 px-1 text-xs text-muted">
            <Loader2 className="size-3.5 animate-spin text-accent" />
            {live.length ? live.map(([k, a]) => `${AGENTS[k as keyof typeof AGENTS]?.name ?? k} ${a.status === "acting" ? `→ ${a.detail}` : "thinking"}`).join(" · ") : "Thinking…"}
          </div>
        )}
      </div>
      <div className="border-t border-line p-3">
        <div className="mb-2 flex items-center gap-1 overflow-x-auto">
          {AGENT_LIST.map((a) => (
            <button key={a.kind} onClick={() => setTarget(a.kind)} className={cn("flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] transition", target === a.kind ? "border-transparent text-black" : "border-line-2 text-muted hover:text-fg")} style={target === a.kind ? { background: a.color } : undefined}>
              {a.kind === "DIRECTOR" ? a.name : `@${a.short.toLowerCase()}`}
            </button>
          ))}
          <button title="Clear conversation" onClick={async () => { if (confirm("Clear the conversation?")) { await api(`/api/projects/${projectId}/agent`, { body: { action: "clear" } }); mutate(); } }} className="ml-auto shrink-0 rounded p-1 text-dim hover:text-err">
            <Trash2 className="size-3" />
          </button>
        </div>
        <div className="flex items-end gap-2 rounded-xl border border-line-2 bg-panel-2 p-1.5 focus-within:border-accent/50">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={target === "DIRECTOR" ? "Direct the film…" : `Ask the ${AGENTS[target as keyof typeof AGENTS].name} agent…`}
            className="max-h-40 min-h-[36px] flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-dim"
          />
          <Button size="icon-sm" onClick={() => send()} disabled={!input.trim() || sending} aria-label="Send">
            <Send />
          </Button>
        </div>
      </div>
    </>
  );
}

function MessageRow({ m, streaming }: { m: Msg; streaming?: boolean }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent/15 px-3 py-2 text-sm text-fg">{m.content}</div>
      </div>
    );
  }
  const def = AGENTS[m.agent as keyof typeof AGENTS];
  if (m.role === "summary") {
    return (
      <div className="rounded-xl border border-accent/30 bg-accent/[0.06] px-3 py-2">
        <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-medium text-accent">
          <Sparkles className="size-3" /> Progress update
          {m.createdAt && <span className="ml-auto font-normal text-dim">{new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
        </div>
        <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg/90">{m.content}</div>
      </div>
    );
  }
  if (m.role === "tool") {
    return (
      <div className="flex items-center gap-2 pl-1 text-[11px] text-dim">
        <span className="size-1.5 rounded-full" style={{ background: def?.color }} />
        <span style={{ color: def?.color }}>{def?.name}</span> {TOOL_LABEL[m.content] ?? m.content}
        {m.toolCalls?.args && typeof m.toolCalls.args === "object" && "agent" in (m.toolCalls.args as object) ? <span>→ {(m.toolCalls.args as { agent: string }).agent.toLowerCase()}</span> : null}
      </div>
    );
  }
  return (
    <div className="flex gap-2">
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md text-[9px] font-bold text-black" style={{ background: def?.color ?? "#888" }}>
        {def?.short ?? "AI"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium" style={{ color: def?.color }}>{def?.name ?? m.agent}</div>
        <div className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-fg/90">
          {m.content}
          {streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-middle" />}
        </div>
      </div>
    </div>
  );
}

function AgentsPanel() {
  const { state, agents, projectId, openShot } = useStudio();
  if (!state) return null;
  const shotNo = (id: string | null) => (id ? state.shots.find((s) => s.id === id)?.order : undefined);
  const run = (agent: string) => api(`/api/projects/${projectId}/agent`, { body: { action: "check", agent } });
  return (
    <div className="space-y-4 p-3">
      <div className="grid grid-cols-1 gap-2">
        {AGENT_LIST.map((a) => {
          const live = agents[a.kind];
          const busy = live && live.status !== "idle" && Date.now() - live.at < 120_000;
          const count = state.findings.filter((f) => f.agent === a.kind).length;
          return (
            <div key={a.kind} className={cn("rounded-xl border bg-panel-2 p-3 transition", busy ? "border-transparent" : "border-line")} style={busy ? { boxShadow: `0 0 0 1px ${a.color}66, 0 8px 30px -12px ${a.color}` } : undefined}>
              <div className="flex items-center gap-2">
                <span className="grid size-7 place-items-center rounded-lg text-[9px] font-bold text-black" style={{ background: a.color }}>{a.short}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{a.name}</div>
                  <div className="truncate text-[11px] text-dim">{busy ? `${live.status === "acting" ? "Running" : "Thinking"}${live.detail ? ` · ${live.detail}` : ""}` : a.role}</div>
                </div>
                {busy ? <Loader2 className="size-4 animate-spin" style={{ color: a.color }} /> : count > 0 ? <Badge tone="warn">{count}</Badge> : <Check className="size-4 text-dim" />}
                {["CONSISTENCY", "MOOD", "MONITOR"].includes(a.kind) && (
                  <Button size="xs" variant="ghost" onClick={() => run(a.kind)} title="Run check now">
                    <Wand2 /> Check
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div>
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted">Findings</div>
        {!state.findings.length && <div className="rounded-xl border border-dashed border-line-2 p-4 text-center text-xs text-dim">No open issues. Agents report here as frames come in.</div>}
        <div className="space-y-2">
          {state.findings.map((f) => {
            const def = AGENTS[f.agent as keyof typeof AGENTS];
            const n = shotNo(f.shotId);
            const fix = f.fix as { prompt?: string } | null;
            const Icon = f.severity === "error" ? XCircle : f.severity === "warn" ? AlertTriangle : Info;
            return (
              <div key={f.id} className="rounded-xl border border-line bg-panel-2 p-3">
                <div className="flex items-start gap-2">
                  <Icon className={cn("mt-0.5 size-4 shrink-0", f.severity === "error" ? "text-err" : f.severity === "warn" ? "text-warn" : "text-cyan")} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <span style={{ color: def?.color }}>{def?.name}</span>
                      {n !== undefined && (
                        <button className="text-muted underline-offset-2 hover:text-fg hover:underline" onClick={() => openShot(f.shotId)}>shot #{n + 1}</button>
                      )}
                    </div>
                    <div className="mt-0.5 text-sm">{f.message}</div>
                    {f.suggestion && <div className="mt-1 text-xs text-muted">{f.suggestion}</div>}
                    <div className="mt-2 flex gap-1.5">
                      {fix?.prompt && f.shotId && (
                        <Button size="xs" onClick={() => api(`/api/projects/${projectId}/findings/${f.id}`, { method: "PATCH", body: { action: "apply" } })}>
                          <Wand2 /> Apply fix & regenerate
                        </Button>
                      )}
                      <Button size="xs" variant="ghost" onClick={() => api(`/api/projects/${projectId}/findings/${f.id}`, { method: "PATCH", body: { action: "resolve" } })}>
                        <X /> Dismiss
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const JOB_LABEL: Record<string, string> = {
  PARSE_SCRIPT: "Script breakdown", IMAGE: "Frame", VIDEO: "Clip", UPSCALE: "Upscale", INPAINT: "Inpaint", TTS: "Voiceover", MUSIC: "Music", SFX: "SFX", EXPORT_MP4: "Film export", EXPORT_PDF: "Storyboard PDF", AGENT_CHECK: "Agent check",
};

export function JobRow({ j, shotNo }: { j: Job; shotNo?: number }) {
  const running = j.status === "RUNNING";
  return (
    <div className="rounded-xl border border-line bg-panel-2 p-2.5">
      <div className="flex items-center gap-2 text-xs">
        {running ? <Loader2 className="size-3.5 animate-spin text-accent" /> : j.status === "QUEUED" ? <ListChecks className="size-3.5 text-muted" /> : j.status === "SUCCEEDED" ? <Check className="size-3.5 text-ok" /> : j.status === "CANCELED" ? <CircleSlash className="size-3.5 text-dim" /> : <XCircle className="size-3.5 text-err" />}
        <span className="font-medium">{JOB_LABEL[j.type] ?? j.type}</span>
        {shotNo !== undefined && <span className="text-dim">#{shotNo + 1}</span>}
        <span className="ml-auto text-[10px] text-dim">{j.status === "RUNNING" ? `${j.progress}%` : j.status.toLowerCase()}</span>
        {j.status === "FAILED" && (
          <Button size="xs" variant="secondary" onClick={() => api(`/api/jobs/${j.id}`, { body: { action: "retry" } })}>
            <RotateCcw /> Retry
          </Button>
        )}
        {(j.status === "QUEUED" || j.status === "RUNNING") && (
          <button className="text-dim hover:text-err" title="Cancel" onClick={() => api(`/api/jobs/${j.id}`, { body: { action: "cancel" } })}>
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {(running || j.status === "QUEUED") && (
        <>
          <Progress value={j.progress} className="mt-2" />
          <div className="mt-1 truncate text-[10px] text-muted">{j.step}</div>
        </>
      )}
      {j.status === "FAILED" && j.error && <div className="mt-1.5 line-clamp-3 text-[11px] text-err/90">{j.error}</div>}
    </div>
  );
}

function QueuePanel() {
  const { state, projectId } = useStudio();
  if (!state) return null;
  const order = new Map(state.shots.map((s) => [s.id, s.order]));
  const active = state.jobs.filter((j) => ["RUNNING", "QUEUED"].includes(j.status));
  const failed = state.jobs.filter((j) => j.status === "FAILED");
  const done = state.jobs.filter((j) => ["SUCCEEDED", "CANCELED"].includes(j.status)).slice(0, 30);
  return (
    <div className="space-y-4 p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted">{active.length} active · {failed.length} failed</div>
        {failed.length > 0 && (
          <Button size="xs" variant="secondary" onClick={() => api(`/api/projects/${projectId}/jobs`, { body: { action: "retry-failed" } })}>
            <RotateCcw /> Retry all failed
          </Button>
        )}
      </div>
      {[["Running & queued", active], ["Failed", failed], ["Recent", done]].map(([title, list]) =>
        (list as Job[]).length ? (
          <div key={title as string}>
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted">{title as string}</div>
            <div className="space-y-1.5">
              {(list as Job[]).map((j) => <JobRow key={j.id} j={j} shotNo={j.shotId ? order.get(j.shotId) : undefined} />)}
            </div>
          </div>
        ) : null,
      )}
      {!state.jobs.length && <div className="rounded-xl border border-dashed border-line-2 p-4 text-center text-xs text-dim">Nothing rendered yet.</div>}
    </div>
  );
}

interface MemoryRow {
  id: string;
  key: string;
  category: string;
  content: string;
  pinned: boolean;
  updatedBy: string;
  version: number;
  updatedAt: string;
}

const MEMORY_CATS = ["lesson", "decision", "preference", "character", "style", "continuity", "note"];

/** Shared project memory: the user and every agent read and edit the same entries. */
function MemoryPanel() {
  const { projectId, memoryVersion } = useStudio();
  const [q, setQ] = React.useState("");
  const key = `/api/projects/${projectId}/memory${q ? `?q=${encodeURIComponent(q)}` : ""}`;
  const { data, mutate } = useSWR<MemoryRow[]>(key, fetcher);
  React.useEffect(() => {
    mutate();
  }, [memoryVersion, mutate]);
  const [editing, setEditing] = React.useState<Partial<MemoryRow> | null>(null);

  const save = async () => {
    if (!editing?.key?.trim() || !editing.content?.trim()) return;
    if (editing.id) await api(`/api/projects/${projectId}/memory/${editing.id}`, { method: "PATCH", body: editing });
    else await api(`/api/projects/${projectId}/memory`, { body: editing });
    setEditing(null);
    mutate();
  };
  const patch = async (m: MemoryRow, body: Partial<MemoryRow>) => {
    await api(`/api/projects/${projectId}/memory/${m.id}`, { method: "PATCH", body });
    mutate();
  };
  const remove = async (m: MemoryRow) => {
    if (!confirm(`Delete “${m.key}” from project memory?`)) return;
    await api(`/api/projects/${projectId}/memory/${m.id}`, { method: "DELETE" });
    mutate();
  };

  return (
    <div className="space-y-3 p-3">
      <p className="text-xs text-muted">Facts every agent reads before it works, and can add to or correct. Edit them here too.</p>
      <div className="flex gap-2">
        <Input className="h-8" placeholder="Search memory" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button size="sm" variant="secondary" onClick={() => setEditing({ key: "", content: "", category: "note" })}>
          <Plus /> Add
        </Button>
      </div>
      {editing && (
        <div className="space-y-2 rounded-xl border border-accent/40 bg-panel-2 p-3">
          <div className="flex gap-2">
            <Input className="h-8" placeholder="key, e.g. maya-wardrobe" value={editing.key ?? ""} onChange={(e) => setEditing({ ...editing, key: e.target.value })} />
            <NativeSelect className="h-8 w-32" value={editing.category ?? "note"} onChange={(e) => setEditing({ ...editing, category: e.target.value })}>
              {MEMORY_CATS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </NativeSelect>
          </div>
          <Textarea rows={3} placeholder="What everyone should remember" value={editing.content ?? ""} onChange={(e) => setEditing({ ...editing, content: e.target.value })} />
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button size="xs" onClick={save}>Save</Button>
          </div>
        </div>
      )}
      {!data?.length && !editing && (
        <div className="rounded-xl border border-dashed border-line-2 p-4 text-center text-xs text-muted">
          Nothing saved yet. Agents add decisions and continuity notes as they work, or tell the Director “remember …”.
        </div>
      )}
      {data?.map((m) => {
        const by = m.updatedBy === "USER" ? null : AGENTS[m.updatedBy as keyof typeof AGENTS];
        return (
          <div key={m.id} className="group rounded-xl border border-line bg-panel-2 p-3">
            <div className="mb-1 flex items-center gap-2">
              {m.pinned && <Pin className="size-3 text-accent" />}
              <span className="truncate text-xs font-medium">{m.key}</span>
              <Badge tone="neutral" className="px-1 py-0">{m.category}</Badge>
              <span className="ml-auto flex shrink-0 gap-1 opacity-0 transition group-hover:opacity-100">
                <button title={m.pinned ? "Unpin" : "Pin"} onClick={() => patch(m, { pinned: !m.pinned })} className="rounded p-1 text-dim hover:text-accent"><Pin className="size-3" /></button>
                <button title="Edit" onClick={() => setEditing(m)} className="rounded p-1 text-dim hover:text-fg"><Pencil className="size-3" /></button>
                <button title="Delete" onClick={() => remove(m)} className="rounded p-1 text-dim hover:text-err"><Trash2 className="size-3" /></button>
              </span>
            </div>
            <p className="whitespace-pre-wrap text-sm text-fg/90">{m.content}</p>
            <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-dim">
              {by ? <span className="size-1.5 rounded-full" style={{ background: by.color }} /> : null}
              {by ? by.name : "You"} · v{m.version} · {new Date(m.updatedAt).toLocaleString()}
            </div>
          </div>
        );
      })}
    </div>
  );
}

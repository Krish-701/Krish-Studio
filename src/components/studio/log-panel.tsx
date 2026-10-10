"use client";
import * as React from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Download, Loader2, ScrollText, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client";
import { AGENT_LIST } from "@/lib/agents/definitions";
import type { LogEntry } from "@/lib/events";
import { cn } from "@/lib/utils";
import { useStudio } from "./store";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "job", label: "Jobs" },
  { key: "agent", label: "Agents" },
  { key: "tool", label: "Tools" },
  { key: "user", label: "You" },
  { key: "summary", label: "Summaries" },
  { key: "errors", label: "Errors" },
] as const;
type Filter = (typeof FILTERS)[number]["key"];

const PAGE = 200;

const matches = (e: LogEntry, f: Filter) => f === "all" || (f === "errors" ? e.level === "error" : e.kind === f);

function actorColor(actor: string | null) {
  if (!actor) return undefined;
  const a = AGENT_LIST.find((d) => d.name.toLowerCase() === actor.toLowerCase() || d.kind === actor.toUpperCase());
  if (a) return a.color;
  if (actor === "you") return "var(--color-accent, #f59e0b)";
  return undefined;
}

const LEVEL_DOT: Record<LogEntry["level"], string> = { info: "bg-dim", success: "bg-ok", warn: "bg-warn", error: "bg-err" };
const LEVEL_TEXT: Record<LogEntry["level"], string> = { info: "text-fg/85", success: "text-fg/90", warn: "text-warn", error: "text-err" };

function relTime(iso: string, now: number) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Live project activity log: jobs, agent turns, tool calls, your messages and Director summaries. */
export function LogPanel() {
  const { projectId, liveLog, state, openShot } = useStudio();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [entries, setEntries] = React.useState<LogEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [older, setOlder] = React.useState(false);
  const [hasMore, setHasMore] = React.useState(false);
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const [summarizing, setSummarizing] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const url = React.useCallback((f: Filter, before?: string) => `/api/projects/${projectId}/logs?limit=${PAGE}${f !== "all" ? `&kind=${f}` : ""}${before ? `&before=${encodeURIComponent(before)}` : ""}`, [projectId]);

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    api<LogEntry[]>(url(filter), { quiet: true })
      .then((rows) => {
        if (!alive) return;
        setEntries(rows);
        setHasMore(rows.length === PAGE);
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [filter, url]);

  // Prepend entries that arrive live over SSE.
  React.useEffect(() => {
    if (!liveLog.length) return;
    setEntries((cur) => {
      const have = new Set(cur.map((e) => e.id));
      const fresh = liveLog.filter((e) => !have.has(e.id) && matches(e, filter) && (!cur[0] || e.createdAt >= cur[0].createdAt));
      return fresh.length ? [...fresh, ...cur] : cur;
    });
  }, [liveLog, filter]);

  const loadOlder = async () => {
    const last = entries[entries.length - 1];
    if (!last) return;
    setOlder(true);
    try {
      const rows = await api<LogEntry[]>(url(filter, last.createdAt));
      setEntries((cur) => {
        const have = new Set(cur.map((e) => e.id));
        return [...cur, ...rows.filter((r) => !have.has(r.id))];
      });
      setHasMore(rows.length === PAGE);
    } finally {
      setOlder(false);
    }
  };

  const exportLog = async (fmt: "txt" | "json") => {
    // Export the whole log (all kinds), oldest first.
    const all: LogEntry[] = [];
    let before: string | undefined;
    for (let i = 0; i < 50; i++) {
      const rows = await api<LogEntry[]>(`/api/projects/${projectId}/logs?limit=1000${before ? `&before=${encodeURIComponent(before)}` : ""}`);
      all.push(...rows);
      if (rows.length < 1000) break;
      before = rows[rows.length - 1].createdAt;
    }
    all.reverse();
    const title = (state?.project.title ?? "film").replace(/[^\w-]+/g, "_");
    if (fmt === "json") download(`${title}-log.json`, JSON.stringify(all, null, 2), "application/json");
    else
      download(
        `${title}-log.txt`,
        all.map((e) => `${new Date(e.createdAt).toISOString()}  ${e.level.toUpperCase().padEnd(7)} ${e.kind.padEnd(7)} ${(e.actor ?? "-").padEnd(22)} ${e.message}`).join("\n") + "\n",
        "text/plain",
      );
  };

  const clear = async () => {
    if (!confirm("Clear the whole activity log for this project?")) return;
    await api(`/api/projects/${projectId}/logs`, { method: "DELETE" });
    setEntries([]);
    setHasMore(false);
  };

  const summarize = async () => {
    setSummarizing(true);
    try {
      const r = await api<{ summary: string | null }>(`/api/projects/${projectId}/summary`, { body: {} });
      if (!r.summary) toast.message("A summary is already being written.");
    } catch {
    } finally {
      setSummarizing(false);
    }
  };

  const shotOrder = React.useMemo(() => new Map(state?.shots.map((s) => [s.id, s.order]) ?? []), [state?.shots]);
  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-line p-3">
        <div className="flex items-center gap-1.5">
          <Button size="xs" variant="secondary" onClick={summarize} disabled={summarizing} title="Ask the Director for a progress update now">
            {summarizing ? <Loader2 className="animate-spin" /> : <Sparkles />} Summarize now
          </Button>
          <span className="ml-auto flex items-center gap-0.5">
            <Button size="xs" variant="ghost" onClick={() => exportLog("txt")} title="Export the log as text">
              <Download /> .txt
            </Button>
            <Button size="xs" variant="ghost" onClick={() => exportLog("json")} title="Export the log as JSON">
              .json
            </Button>
            <button title="Clear log" onClick={clear} className="rounded p-1 text-dim hover:text-err">
              <Trash2 className="size-3" />
            </button>
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-md border px-2 py-0.5 text-[10px] transition",
                filter === f.key ? (f.key === "errors" ? "border-err/40 bg-err/10 text-err" : "border-accent/40 bg-accent/12 text-accent") : "border-line-2 text-muted hover:text-fg",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && (
          <div className="flex items-center gap-2 p-3 text-xs text-muted">
            <Loader2 className="size-3.5 animate-spin text-accent" /> Loading log…
          </div>
        )}
        {!loading && !entries.length && (
          <div className="m-1 rounded-xl border border-dashed border-line-2 p-4 text-center text-xs text-dim">
            <ScrollText className="mx-auto mb-1.5 size-4" />
            Nothing logged yet. Renders, agent work and your messages show up here as they happen.
          </div>
        )}
        <div className="space-y-0.5">
          {entries.map((e) => {
            const color = actorColor(e.actor);
            const expandable = e.data !== null && e.data !== undefined;
            const isOpen = open.has(e.id);
            const n = e.shotId ? shotOrder.get(e.shotId) : undefined;
            if (e.kind === "summary") {
              return (
                <div key={e.id} className="my-1.5 rounded-xl border border-accent/30 bg-accent/[0.06] p-2.5">
                  <div className="mb-1 flex items-center gap-1.5 text-[10px]">
                    <Sparkles className="size-3 text-accent" />
                    <span className="font-medium text-accent">Director · progress update</span>
                    <span className="ml-auto text-dim" title={new Date(e.createdAt).toLocaleString()}>{relTime(e.createdAt, now)}</span>
                  </div>
                  <p className="text-[13px] leading-relaxed text-fg/90">{e.message}</p>
                </div>
              );
            }
            return (
              <div key={e.id} className={cn("group rounded-lg px-2 py-1 transition hover:bg-panel-2", isOpen && "bg-panel-2")}>
                <div className={cn("flex items-start gap-2", expandable && "cursor-pointer")} onClick={expandable ? () => toggle(e.id) : undefined}>
                  <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", LEVEL_DOT[e.level])} />
                  <div className="min-w-0 flex-1 text-xs leading-relaxed">
                    {e.actor && (
                      <span className={cn("mr-1.5 font-medium", !color && "text-muted")} style={color ? { color } : undefined}>
                        {e.actor === "you" ? "You" : e.actor}
                      </span>
                    )}
                    <span className={cn("break-words", LEVEL_TEXT[e.level])}>{e.message}</span>
                    {n !== undefined && (
                      <button
                        className="ml-1.5 text-[10px] text-muted underline-offset-2 hover:text-fg hover:underline"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          openShot(e.shotId);
                        }}
                      >
                        open #{n + 1}
                      </button>
                    )}
                  </div>
                  <span className="mt-0.5 flex shrink-0 items-center gap-1 text-[10px] text-dim" title={new Date(e.createdAt).toLocaleString()}>
                    <span className="uppercase tracking-wide opacity-0 transition group-hover:opacity-100">{e.kind}</span>
                    {relTime(e.createdAt, now)}
                    {expandable && (isOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />)}
                  </span>
                </div>
                {isOpen && expandable && (
                  <pre className="mt-1 ml-3.5 max-h-64 overflow-auto rounded-md border border-line bg-black/30 p-2 font-mono text-[10px] leading-snug text-muted">
                    {JSON.stringify(e.data, null, 2)}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
        {hasMore && !loading && (
          <div className="p-2 text-center">
            <Button size="xs" variant="ghost" onClick={loadOlder} disabled={older}>
              {older && <Loader2 className="animate-spin" />} Load older
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

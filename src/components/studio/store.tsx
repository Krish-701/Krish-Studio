"use client";
import * as React from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/client";
import type { ProjectState } from "@/lib/project-state";
import type { StudioEvent } from "@/lib/events";

export type Shot = ProjectState["shots"][number];
export type Character = ProjectState["characters"][number];
export type Job = ProjectState["jobs"][number];
export type Clip = ProjectState["clips"][number];
export type Finding = ProjectState["findings"][number];
export type Asset = ProjectState["assets"][number];

export type View = "script" | "characters" | "style" | "storyboard" | "timeline" | "export";

interface AgentLive {
  status: "thinking" | "idle" | "acting";
  detail?: string;
  at: number;
}

interface Ctx {
  projectId: string;
  state: ProjectState | undefined;
  loading: boolean;
  refresh: () => Promise<unknown>;
  view: View;
  setView: (v: View) => void;
  openShotId: string | null;
  openShot: (id: string | null) => void;
  agents: Record<string, AgentLive>;
  streaming: { agent: string; text: string } | null;
  chatVersion: number;
  connected: boolean;
}

const StudioCtx = React.createContext<Ctx | null>(null);

export function useStudio() {
  const c = React.useContext(StudioCtx);
  if (!c) throw new Error("useStudio outside provider");
  return c;
}

export function StudioProvider({ projectId, children }: { projectId: string; children: React.ReactNode }) {
  const { data, isLoading, mutate } = useSWR<ProjectState>(`/api/projects/${projectId}`, fetcher, { revalidateOnFocus: false });
  const [view, setViewState] = React.useState<View>("storyboard");
  const [openShotId, openShot] = React.useState<string | null>(null);
  const [agents, setAgents] = React.useState<Record<string, AgentLive>>({});
  const [streaming, setStreaming] = React.useState<{ agent: string; text: string } | null>(null);
  const [chatVersion, setChatVersion] = React.useState(0);
  const [connected, setConnected] = React.useState(false);

  // Pick the starting view from the project stage once.
  const didInit = React.useRef(false);
  React.useEffect(() => {
    if (!data || didInit.current) return;
    didInit.current = true;
    const fromHash = typeof window !== "undefined" ? (window.location.hash.slice(1) as View) : null;
    if (fromHash && ["script", "characters", "style", "storyboard", "timeline", "export"].includes(fromHash)) setViewState(fromHash);
    else if (!data.shots.length) setViewState("script");
    else if (data.project.stage === "VIDEO" || data.project.stage === "AUDIO") setViewState("timeline");
  }, [data]);

  const setView = React.useCallback((v: View) => {
    setViewState(v);
    if (typeof window !== "undefined") history.replaceState(null, "", `#${v}`);
  }, []);

  // Debounced full refresh for "refresh" events.
  const refreshTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = React.useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => mutate(), 250);
  }, [mutate]);

  React.useEffect(() => {
    const es = new EventSource(`/api/projects/${projectId}/events`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      let e: StudioEvent | { type: "hello" };
      try {
        e = JSON.parse(m.data);
      } catch {
        return;
      }
      switch (e.type) {
        case "job": {
          const j = e.job;
          mutate(
            (cur) => {
              if (!cur) return cur;
              const exists = cur.jobs.some((x) => x.id === j.id);
              const jobs = exists
                ? cur.jobs.map((x) => (x.id === j.id ? { ...x, status: j.status as Job["status"], progress: j.progress, step: j.step, error: j.error ?? x.error } : x))
                : [{ id: j.id, projectId, shotId: j.shotId, type: j.type as Job["type"], status: j.status as Job["status"], progress: j.progress, step: j.step, error: j.error, provider: null, input: {}, output: null, attempts: 0, maxAttempts: 3, createdAt: new Date(), updatedAt: new Date() }, ...cur.jobs];
              return { ...cur, jobs };
            },
            { revalidate: false },
          );
          if (j.status === "SUCCEEDED" && ["PARSE_SCRIPT", "EXPORT_MP4", "EXPORT_PDF", "MUSIC", "SFX", "TTS"].includes(j.type)) scheduleRefresh();
          break;
        }
        case "shot":
          mutate(
            (cur) => cur && { ...cur, shots: cur.shots.map((s) => (s.id === e.shotId ? ({ ...s, ...e.patch } as Shot) : s)) },
            { revalidate: false },
          );
          if ("imageAssetId" in e.patch || "videoAssetId" in e.patch) scheduleRefresh();
          break;
        case "finding":
          mutate((cur) => cur && { ...cur, findings: [e.finding as unknown as Finding, ...cur.findings] }, { revalidate: false });
          break;
        case "agent":
          setAgents((a) => ({ ...a, [e.agent]: { status: e.status, detail: e.detail, at: Date.now() } }));
          break;
        case "chat":
          if (e.delta) setStreaming((s) => ({ agent: e.agent, text: (s?.agent === e.agent ? s.text : "") + e.delta }));
          if (e.done) {
            setStreaming(null);
            setChatVersion((v) => v + 1);
          }
          break;
        case "refresh":
          scheduleRefresh();
          break;
      }
    };
    return () => es.close();
  }, [projectId, mutate, scheduleRefresh]);

  const value: Ctx = {
    projectId,
    state: data,
    loading: isLoading,
    refresh: () => mutate(),
    view,
    setView,
    openShotId,
    openShot,
    agents,
    streaming,
    chatVersion,
    connected,
  };
  return <StudioCtx.Provider value={value}>{children}</StudioCtx.Provider>;
}

/** Latest job of a type for a shot. */
export function latestJob(jobs: Job[], shotId: string, types: Job["type"][]) {
  return jobs.find((j) => j.shotId === shotId && types.includes(j.type));
}

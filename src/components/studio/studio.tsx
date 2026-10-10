"use client";
import * as React from "react";
import Link from "next/link";
import { Activity, Play, Download, FileText, Film, LayoutGrid, MessageSquare, Palette, Settings, Users, Wifi, WifiOff, X } from "lucide-react";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { api } from "@/lib/client";
import { StudioProvider, useStudio, type View } from "./store";
import { Pipeline } from "./pipeline";
import { RightPanel } from "./right-panel";
import { ScriptView } from "./script-view";
import { CharactersView } from "./characters-view";
import { StyleView } from "./style-view";
import { StoryboardView } from "./storyboard-view";
import { TimelineView } from "./timeline-view";
import { ExportView } from "./export-view";
import { WatchView } from "./watch-view";
import { ShotDrawer } from "./shot-drawer";
import { FilmWizard, runtimeLabel } from "./film-wizard";

const NAV: { view: View; label: string; icon: React.ElementType }[] = [
  { view: "script", label: "Script", icon: FileText },
  { view: "characters", label: "Cast & sets", icon: Users },
  { view: "style", label: "Style & refs", icon: Palette },
  { view: "storyboard", label: "Storyboard", icon: LayoutGrid },
  { view: "timeline", label: "Timeline", icon: Film },
  { view: "watch", label: "Watch", icon: Play },
  { view: "export", label: "Export", icon: Download },
];

export function Studio({ projectId }: { projectId: string }) {
  return (
    <StudioProvider projectId={projectId}>
      <Shell />
    </StudioProvider>
  );
}

function Shell() {
  const { state, loading, view, setView, connected, projectId } = useStudio();
  const [panelOpen, setPanelOpen] = React.useState(true);
  const [mobilePanel, setMobilePanel] = React.useState(false);
  const active = state?.jobs.filter((j) => j.status === "RUNNING" || j.status === "QUEUED").length ?? 0;

  if (loading || !state) {
    return (
      <div className="grid h-screen place-items-center">
        <div className="flex items-center gap-3 text-muted">
          <div className="size-4 animate-spin rounded-full border-2 border-accent border-t-transparent" /> Loading studio…
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel/80 px-3 backdrop-blur-xl sm:px-4">
        <Brand compact />
        <div className="min-w-0">
          <TitleEditor projectId={projectId} title={state.project.title} />
          <div className="truncate text-[10px] uppercase tracking-widest text-dim">{state.project.aspectRatio} · {runtimeLabel(state.project.targetRuntimeSec)} · {state.project.stage.toLowerCase()}</div>
        </div>
        <div className="mx-auto hidden overflow-x-auto sm:block">
          <Pipeline />
        </div>
        <div className="ml-auto flex items-center gap-1 sm:ml-0">
          <Tip content={connected ? "Live updates connected" : "Reconnecting to live updates…"}>
            <span className={cn("hidden items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] sm:flex", active ? "text-accent" : "text-dim")}>
              {connected ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5 text-err" />}
              {active > 0 && (
                <>
                  <Activity className="size-3.5 animate-pulse" /> {active}
                </>
              )}
            </span>
          </Tip>
          <Button variant="ghost" size="icon-sm" asChild>
            <Link href="/settings" aria-label="Settings"><Settings /></Link>
          </Button>
          <Button variant="ghost" size="icon-sm" className="hidden lg:inline-flex" onClick={() => setPanelOpen((o) => !o)} aria-label="Toggle AI panel">
            <MessageSquare />
          </Button>
          <Button variant="secondary" size="sm" className="lg:hidden" onClick={() => setMobilePanel(true)}>
            <MessageSquare /> AI
          </Button>
        </div>
      </header>
      <div className="border-b border-line bg-panel/60 px-3 py-2 sm:hidden overflow-x-auto">
        <Pipeline compact />
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Left rail */}
        <nav className="hidden w-[72px] shrink-0 flex-col items-center gap-1 border-r border-line bg-panel/50 py-3 md:flex">
          {NAV.map((n) => {
            const Icon = n.icon;
            const on = view === n.view;
            return (
              <button key={n.view} onClick={() => setView(n.view)} className={cn("group flex w-14 flex-col items-center gap-1 rounded-xl py-2 text-[10px] transition", on ? "bg-accent/10 text-accent" : "text-muted hover:bg-panel-3 hover:text-fg")}>
                <Icon className="size-[18px]" />
                <span className="leading-none">{n.label.split(" ")[0]}</span>
              </button>
            );
          })}
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto pb-20 md:pb-0">
          {!state.project.setupDone ? (
            <FilmWizard />
          ) : (
            <>
              {view === "script" && <ScriptView />}
              {view === "characters" && <CharactersView />}
              {view === "style" && <StyleView />}
              {view === "storyboard" && <StoryboardView />}
              {view === "timeline" && <TimelineView />}
              {view === "watch" && <WatchView />}
              {view === "export" && <ExportView />}
            </>
          )}
        </main>

        {panelOpen && (
          <aside className="hidden w-[380px] shrink-0 border-l border-line bg-panel lg:flex xl:w-[420px]">
            <RightPanel />
          </aside>
        )}
      </div>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex justify-around border-t border-line bg-panel/95 px-1 py-1.5 backdrop-blur md:hidden">
        {NAV.map((n) => {
          const Icon = n.icon;
          return (
            <button key={n.view} onClick={() => setView(n.view)} className={cn("flex flex-1 flex-col items-center gap-0.5 rounded-lg py-1 text-[10px]", view === n.view ? "text-accent" : "text-muted")}>
              <Icon className="size-[18px]" />
              {n.label.split(" ")[0]}
            </button>
          );
        })}
      </nav>

      {mobilePanel && (
        <div className="fixed inset-0 z-50 flex flex-col bg-panel lg:hidden">
          <div className="flex h-12 items-center justify-between border-b border-line px-3">
            <span className="font-display text-sm font-semibold">AI crew</span>
            <Button variant="ghost" size="icon-sm" onClick={() => setMobilePanel(false)} aria-label="Close"><X /></Button>
          </div>
          <div className="flex min-h-0 flex-1">
            <RightPanel />
          </div>
        </div>
      )}

      <ShotDrawer />
    </div>
  );
}

function TitleEditor({ projectId, title }: { projectId: string; title: string }) {
  const [val, setVal] = React.useState(title);
  React.useEffect(() => setVal(title), [title]);
  return (
    <input
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => val !== title && api(`/api/projects/${projectId}`, { method: "PATCH", body: { title: val } })}
      className="w-40 truncate bg-transparent font-display text-sm font-semibold outline-none focus:text-accent sm:w-56"
      aria-label="Project title"
    />
  );
}

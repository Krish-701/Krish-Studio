"use client";
import * as React from "react";
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { CheckSquare, Film, ImageIcon, LayoutGrid, Plus, RotateCcw, Square, Wand2, Rows3 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { Empty } from "@/components/ui/misc";
import { api } from "@/lib/client";
import { SceneBoard } from "./scene-board";
import { useModels } from "./use-models";
import { cn } from "@/lib/utils";
import { ShotCard } from "./shot-card";
import { useStudio } from "./store";

export function StoryboardView() {
  const { state, projectId, refresh, setView } = useStudio();
  const [selecting, setSelecting] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [scene, setScene] = React.useState<string>("all");
  const [size, setSize] = React.useState<"s" | "m" | "l">("m");
  const [grouped, setGrouped] = React.useState(true);
  const { image: IMAGE_MODELS, video: VIDEO_MODELS } = useModels();
  const [imageModel, setImageModel] = React.useState("");
  const [videoModel, setVideoModel] = React.useState("");
  const [order, setOrder] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (state) setOrder(state.shots.map((s) => s.id));
  }, [state]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (!state) return null;
  const byId = new Map(state.shots.map((s) => [s.id, s]));
  const shots = order.map((id) => byId.get(id)).filter((s): s is NonNullable<typeof s> => !!s).filter((s) => scene === "all" || s.sceneId === scene);
  const frames = state.shots.filter((s) => s.imageAssetId).length;
  const clips = state.shots.filter((s) => s.videoAssetId).length;
  const failed = state.jobs.filter((j) => j.status === "FAILED" && ["IMAGE", "VIDEO"].includes(j.type)).length;
  const ids = selected.size ? [...selected] : undefined;

  const onDragEnd = async (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const next = arrayMove(order, order.indexOf(String(e.active.id)), order.indexOf(String(e.over.id)));
    setOrder(next);
    await api(`/api/projects/${projectId}/shots/reorder`, { body: { shotIds: next } });
    refresh();
  };

  const gen = async (kind: "image" | "video", scope: "missing" | "all") => {
    const r = await api<{ jobs: number }>(`/api/projects/${projectId}/generate`, {
      body: { kind, shotIds: ids, scope, model: (kind === "image" ? imageModel : videoModel) || undefined },
    });
    toast.success(r.jobs ? `Queued ${r.jobs} ${kind === "image" ? "frame" : "clip"}${r.jobs > 1 ? "s" : ""}` : "Nothing to generate");
    setSelected(new Set());
    setSelecting(false);
  };

  const cols = { s: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6", m: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4", l: "grid-cols-1 lg:grid-cols-2" }[size];

  const writing = state.jobs.find((j) => ["WRITE_OUTLINE", "WRITE_SEQUENCE"].includes(j.type) && ["QUEUED", "RUNNING"].includes(j.status));
  if (!state.shots.length && (writing || state.sequences.length)) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <h1 className="font-display text-2xl font-bold">Storyboard</h1>
        {writing && <p className="flex items-center gap-2 text-sm text-muted"><span className="size-3 animate-spin rounded-full border-2 border-accent border-t-transparent" /> {writing.step ?? "Writing…"}</p>}
        <SceneBoard shots={[]} grid={() => null} />
      </div>
    );
  }
  if (!state.shots.length) {
    return (
      <div className="p-6">
        <Empty icon={<LayoutGrid />} title="No shots yet">
          Upload a script and the Director will break it down, or add shots by hand.
          <div className="mt-4 flex justify-center gap-2">
            <Button onClick={() => setView("script")}>Upload script</Button>
            <Button variant="secondary" onClick={() => api(`/api/projects/${projectId}/shots`, { body: { title: "New shot" } })}><Plus /> Add shot</Button>
          </div>
        </Empty>
      </div>
    );
  }

  const grid = (list: typeof shots) => (
    <div className={cn("grid gap-4", cols)}>
      {list.map((s) => (
        <ShotCard
          key={s.id}
          shot={s}
          selecting={selecting}
          selected={selected.has(s.id)}
          onSelect={() => setSelected((cur) => { const n = new Set(cur); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })}
        />
      ))}
    </div>
  );

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Storyboard</h1>
          <p className="text-sm text-muted">{state.shots.length} shots · {frames} frames · {clips} clips · drag to reorder, click to edit</p>
          {writing && <p className="mt-1 flex items-center gap-2 text-xs text-accent"><span className="size-2.5 animate-spin rounded-full border-2 border-accent border-t-transparent" /> {writing.step ?? "Writing…"}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {failed > 0 && (
            <Button variant="danger" size="sm" onClick={() => api(`/api/projects/${projectId}/jobs`, { body: { action: "retry-failed" } })}>
              <RotateCcw /> Retry {failed} failed
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => api(`/api/projects/${projectId}/shots`, { body: { title: "New shot" } })}><Plus /> Shot</Button>
        </div>
      </div>

      {/* Batch toolbar */}
      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-panel/90 p-2 backdrop-blur-xl">
        <Button size="sm" variant={selecting ? "default" : "ghost"} onClick={() => { setSelecting(!selecting); setSelected(new Set()); }}>
          {selecting ? <CheckSquare /> : <Square />} {selecting ? `${selected.size} selected` : "Select"}
        </Button>
        {selecting && (
          <Button size="xs" variant="ghost" onClick={() => setSelected(new Set(shots.map((s) => s.id)))}>All</Button>
        )}
        <div className="mx-1 h-5 w-px bg-line-2" />
        <NativeSelect className="h-8 w-48 text-xs" value={scene} onChange={(e) => setScene(e.target.value)}>
          <option value="all">All scenes</option>
          {state.scenes.map((s) => <option key={s.id} value={s.id}>{s.index + 1}. {s.heading}</option>)}
        </NativeSelect>
        <div className="flex rounded-lg border border-line-2 p-0.5">
          {(["s", "m", "l"] as const).map((k) => (
            <button key={k} onClick={() => setSize(k)} className={cn("rounded-md px-2 py-0.5 text-[11px] uppercase", size === k ? "bg-panel-3 text-fg" : "text-dim")}>{k}</button>
          ))}
        </div>
        <Button size="icon-sm" variant={grouped ? "secondary" : "ghost"} onClick={() => setGrouped(!grouped)} title="Group by scene"><Rows3 /></Button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <NativeSelect className="h-8 w-44 text-xs" value={imageModel} onChange={(e) => setImageModel(e.target.value)} title="Image model">
            <option value="">Image model: default</option>
            {IMAGE_MODELS.map((m) => <option key={m.slug} value={m.slug}>{m.name}</option>)}
          </NativeSelect>
          <Button size="sm" onClick={() => gen("image", ids ? "all" : "missing")}>
            <ImageIcon /> {ids ? `Frames (${ids.length})` : "Generate missing frames"}
          </Button>
          <NativeSelect className="h-8 w-44 text-xs" value={videoModel} onChange={(e) => setVideoModel(e.target.value)} title="Video model">
            <option value="">Video model: default</option>
            {VIDEO_MODELS.map((m) => <option key={m.slug} value={m.slug}>{m.name}</option>)}
          </NativeSelect>
          <Button size="sm" variant="secondary" onClick={() => gen("video", ids ? "all" : "missing")}>
            <Film /> {ids ? `Clips (${ids.length})` : "Animate missing clips"}
          </Button>
          {selecting && selected.size > 0 && (
            <Button size="sm" variant="outline" onClick={async () => { for (const id of selected) await api(`/api/shots/${id}`, { method: "PATCH", body: { approved: true } }); toast.success("Approved"); setSelected(new Set()); }}>
              <Wand2 /> Approve
            </Button>
          )}
        </div>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={shots.map((s) => s.id)} strategy={rectSortingStrategy}>
          {grouped ? <SceneBoard shots={shots} grid={grid} /> : grid(shots)}
        </SortableContext>
      </DndContext>
    </div>
  );
}

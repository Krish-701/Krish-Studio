"use client";
import * as React from "react";
import { AlertTriangle, Box, CheckCircle2, CloudSun, ImagePlus, Library, Loader2, MapPin, Palette, Plus, RefreshCw, Sparkles, Trash2, Users, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Empty, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import { normalizeKind, type ElementKind } from "@/lib/library";
import { useStudio, type Element, type Job } from "./store";
import { CharacterCard } from "./characters-view";

type Tab = "characters" | ElementKind;

const TABS: { id: Tab; label: string; icon: React.ElementType; blurb: string; placeholder: string; describe: string }[] = [
  { id: "characters", label: "Characters", icon: Users, blurb: "Turnaround sheets (front, three-quarter, side, back) and wardrobe looks. Every frame a character is in gets these.", placeholder: "Character name", describe: "" },
  { id: "location", label: "Backgrounds", icon: MapPin, blurb: "Film sets and backgrounds: four plates per set, sent with every scene that takes place there.", placeholder: "Set name, e.g. Lamp room", describe: "What it looks like: era, materials, layout, light…" },
  { id: "environment", label: "Environments", icon: CloudSun, blurb: "Recurring atmospheres: weather, sky, sea, landscape, time of day. Linked to scenes so the storm looks the same every time.", placeholder: "e.g. Storm at sea, Golden hour", describe: "Weather, sky, water, light, time of day…" },
  { id: "prop", label: "Props", icon: Box, blurb: "Objects the story needs, drawn once and passed with every shot that shows them.", placeholder: "Prop name", describe: "Shape, material, colour, wear…" },
  { id: "mood", label: "Colour & mood", icon: Palette, blurb: "The film's colour & mood board: palette, lighting and texture. Sent as the style reference of every frame (one per film, or one per act when the look changes).", placeholder: "e.g. Film look, Act 3 look", describe: "Palette, lighting, contrast, texture, grain…" },
];

const active = (j: Job) => j.type === "DESIGN_SHEET" && ["QUEUED", "RUNNING"].includes(j.status);
const jobFor = (jobs: Job[], key: "characterId" | "elementId", id: string) => jobs.find((j) => j.type === "DESIGN_SHEET" && (j.input as Record<string, string> | null)?.[key] === id);

/** Asset library: everything frames are drawn from, built before the storyboard. */
export function AssetsView() {
  const { state, projectId } = useStudio();
  const [tab, setTab] = React.useState<Tab>(() => {
    try {
      return (localStorage.getItem("assets-tab") as Tab) || "characters";
    } catch {
      return "characters";
    }
  });
  const [building, setBuilding] = React.useState(false);
  if (!state) return null;

  const els = state.elements;
  const counts: Record<Tab, { total: number; ready: number }> = {
    characters: { total: state.characters.length, ready: state.characters.filter((c) => c.references.some((r) => r.kind === "IMAGE")).length },
    location: { total: 0, ready: 0 },
    environment: { total: 0, ready: 0 },
    prop: { total: 0, ready: 0 },
    mood: { total: 0, ready: 0 },
  };
  for (const e of els) {
    const k = normalizeKind(e.kind);
    counts[k].total++;
    if (e.references.some((r) => r.kind === "IMAGE")) counts[k].ready++;
  }
  const total = Object.values(counts).reduce((a, b) => a + b.total, 0);
  const ready = Object.values(counts).reduce((a, b) => a + b.ready, 0);
  const running = state.jobs.filter(active).length;

  const build = async (missingOnly = true) => {
    setBuilding(true);
    try {
      const r = await api<{ total: number; queued: Record<string, number> }>(`/api/projects/${projectId}/library`, { body: { missingOnly } });
      toast.success(r.total ? `Building ${r.total} asset sheet(s)` : "Every asset already has a sheet");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBuilding(false);
    }
  };
  const pick = (t: string) => {
    setTab(t as Tab);
    try {
      localStorage.setItem("assets-tab", t);
    } catch {}
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-bold"><Library className="size-6 text-accent" /> Asset library</h1>
          <p className="max-w-2xl text-sm text-muted">
            Build the library before the storyboard. Each character, background, environment, prop and the colour & mood board gets a reference sheet, and every frame and clip is drawn from them, so the film stays consistent from the first shot to the last.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={building} onClick={() => confirm("Redraw every sheet in the library? Your uploaded photos are kept.") && build(false)}>
            <RefreshCw /> Redo all
          </Button>
          <Button size="sm" disabled={building} onClick={() => build(true)}>
            {building ? <Loader2 className="animate-spin" /> : <Sparkles />} Build missing assets
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge tone={ready === total && total ? "ok" : "neutral"}>{ready}/{total} with references</Badge>
        {running > 0 && <Badge tone="accent"><Loader2 className="size-3 animate-spin" /> {running} sheet(s) drawing</Badge>}
        {!counts.mood.total && <Badge tone="warn">No colour & mood board yet</Badge>}
      </div>

      <Tabs value={tab} onValueChange={pick}>
        <TabsList className="overflow-x-auto px-0">
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              <t.icon className="size-3.5" /> {t.label}
              <span className={cn("rounded px-1 text-[10px]", counts[t.id].total && counts[t.id].ready === counts[t.id].total ? "bg-ok/10 text-ok" : "bg-panel-3 text-dim")}>{counts[t.id].ready}/{counts[t.id].total}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map((t) => (
          <TabsContent key={t.id} value={t.id} className="space-y-4 pt-4">
            <TabHeader tab={t} />
            {t.id === "characters" ? (
              <>
                {!state.characters.length && <Empty icon={<Users />} title="No characters yet">They’re created when the film is written or a script is imported, or add them above.</Empty>}
                <div className="grid gap-5 xl:grid-cols-2">{state.characters.map((c) => <CharacterCard key={c.id} c={c} />)}</div>
              </>
            ) : (
              <>
                {!els.some((e) => normalizeKind(e.kind) === t.id) && <Empty icon={<t.icon />} title={`No ${t.label.toLowerCase()} yet`}>{t.id === "mood" ? "“Build missing assets” creates one from the style lock." : "They’re created when the film is written, or add them above."}</Empty>}
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {els.filter((e) => normalizeKind(e.kind) === t.id).map((e) => <AssetCard key={e.id} e={e} describe={t.describe} />)}
                </div>
              </>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function TabHeader({ tab }: { tab: (typeof TABS)[number] }) {
  const { projectId } = useStudio();
  const [name, setName] = React.useState("");
  const add = async () => {
    if (!name.trim()) return;
    if (tab.id === "characters") await api(`/api/projects/${projectId}/characters`, { body: { name } });
    else await api(`/api/projects/${projectId}/elements`, { body: { name, kind: tab.id } });
    setName("");
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="max-w-2xl text-xs text-muted">{tab.blurb}</p>
      <div className="flex gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder={tab.placeholder} className="h-8 w-52" />
        <Button size="sm" onClick={add}><Plus /> Add</Button>
      </div>
    </div>
  );
}

const SHEET_WORD: Record<ElementKind, string> = { location: "set plates", environment: "environment plates", prop: "prop sheet", mood: "mood board" };

function AssetCard({ e, describe }: { e: Element; describe: string }) {
  const { state, projectId } = useStudio();
  const [desc, setDesc] = React.useState(e.description);
  React.useEffect(() => setDesc(e.description), [e.description]);
  const kind = normalizeKind(e.kind);
  const job = jobFor(state?.jobs ?? [], "elementId", e.id);
  const busy = !!job && active(job);
  const failed = job?.status === "FAILED";
  const imgs = e.references.filter((r) => r.kind === "IMAGE");
  const sheet = imgs.find((r) => r.role === "MOODBOARD" || r.role === "CONTACT_SHEET");
  const tiles = imgs.filter((r) => r !== sheet);
  const check = (sheet?.meta as { libraryCheck?: { ok: boolean; score: number | null } } | null)?.libraryCheck;
  const scenes = state?.scenes.filter((s) => s.locationId === e.id).length ?? 0;
  const shots = state?.shots.filter((s) => s.elementIds.includes(e.id)).length ?? 0;
  const patch = (body: Record<string, unknown>) => api(`/api/elements/${e.id}`, { method: "PATCH", body });
  const upload = async (files: FileList) => {
    const form = new FormData();
    form.append("role", "ELEMENT_REF");
    form.append("elementId", e.id);
    form.append("lockStyle", "false");
    Array.from(files).forEach((f) => form.append("files", f));
    await api(`/api/projects/${projectId}/assets`, { form });
  };
  const draw = () => api(`/api/projects/${projectId}/design`, { body: { elementId: e.id, kind: "plate" } }).then(() => toast.success(`Drawing ${e.name}`));

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: e.color }} />
        <input defaultValue={e.name} onBlur={(x) => x.target.value !== e.name && patch({ name: x.target.value })} className="min-w-0 flex-1 bg-transparent font-display text-sm font-semibold outline-none focus:text-accent" />
        {scenes > 0 && <span className="text-[10px] text-dim">{scenes} scenes</span>}
        {shots > 0 && <span className="text-[10px] text-dim">{shots} shots</span>}
        <Switch checked={e.locked} onCheckedChange={(v) => patch({ locked: v })} />
        <button className="text-dim hover:text-err" onClick={() => confirm(`Delete ${e.name}?`) && api(`/api/elements/${e.id}`, { method: "DELETE" })} aria-label="Delete"><Trash2 className="size-3.5" /></button>
      </div>
      {sheet && (
        <a href={sheet.url} target="_blank" rel="noreferrer" className="block border-b border-line bg-panel-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={sheet.url} alt={`${e.name} ${SHEET_WORD[kind]}`} className={cn("w-full object-cover", kind === "mood" ? "aspect-video" : "max-h-40")} />
        </a>
      )}
      <div className="grid grid-cols-4 gap-1.5 p-3">
        {tiles.slice(0, 8).map((r) => (
          <div key={r.id} className="group relative aspect-video overflow-hidden rounded-lg border border-line-2 bg-panel-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={r.url} alt={r.name ?? ""} className="size-full object-cover" />
            <button onClick={() => api(`/api/assets/${r.id}`, { method: "DELETE" })} className="absolute right-0.5 top-0.5 rounded bg-black/70 p-0.5 opacity-0 group-hover:opacity-100" aria-label="Remove"><X className="size-3" /></button>
          </div>
        ))}
        {busy && <div className="grid aspect-video place-items-center rounded-lg border border-accent/40 bg-panel-2"><Loader2 className="size-4 animate-spin text-accent" /></div>}
        <label className="grid aspect-video cursor-pointer place-items-center rounded-lg border border-dashed border-line-2 text-dim hover:border-accent/50" title="Upload reference images">
          <ImagePlus className="size-4" />
          <input type="file" accept="image/*" multiple className="hidden" onChange={(x) => x.target.files && upload(x.target.files)} />
        </label>
      </div>
      <div className="space-y-2 border-t border-line p-3">
        <Textarea rows={2} value={desc} onChange={(x) => setDesc(x.target.value)} onBlur={() => desc !== e.description && patch({ description: desc })} placeholder={describe} />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="xs" variant="outline" disabled={busy} onClick={draw}>
            {busy ? <Loader2 className="animate-spin" /> : sheet || imgs.length ? <RefreshCw /> : <Sparkles />} {sheet || imgs.length ? "Redo" : "Make"} {SHEET_WORD[kind]}
          </Button>
          <span className="ml-auto flex items-center gap-1 text-[10px]">
            {busy ? (
              <span className="text-accent">{job?.status === "RUNNING" ? job.step || "Drawing…" : "Queued"}</span>
            ) : failed && !imgs.length ? (
              <span className="flex items-center gap-1 text-err" title={job?.error ?? ""}><AlertTriangle className="size-3" /> Failed</span>
            ) : check && !check.ok ? (
              <span className="flex items-center gap-1 text-warn"><AlertTriangle className="size-3" /> Check: doesn’t match</span>
            ) : imgs.length ? (
              <span className="flex items-center gap-1 text-ok"><CheckCircle2 className="size-3" /> {sheet ? "Sheet ready" : `${imgs.length} reference(s)`}</span>
            ) : (
              <span className="text-dim">No sheet yet</span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

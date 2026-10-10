"use client";
import * as React from "react";
import { ImagePlus, Lock, Plus, Trash2, Unlock, Users, X, Mic, Loader2, Sparkles, Shirt, MapPin, Box } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Empty, Switch, Tip } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import { useStudio, type Character, type Element } from "./store";

const ANGLES = [
  { key: "front", label: "Front" },
  { key: "three_quarter", label: "3/4" },
  { key: "side", label: "Side" },
  { key: "back", label: "Back" },
  { key: "full_body", label: "Full body" },
];

export function CharactersView() {
  const { state, projectId } = useStudio();
  const [name, setName] = React.useState("");
  if (!state) return null;
  const add = async () => {
    if (!name.trim()) return;
    await api(`/api/projects/${projectId}/characters`, { body: { name } });
    setName("");
  };
  const totalRefs = state.characters.reduce((n, c) => n + c.references.length, 0);
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Cast & film sets</h1>
          <p className="max-w-2xl text-sm text-muted">
            Upload a photo or let the AI draw a design sheet (front, three-quarter, side, back). Locked characters and sets travel with every frame and clip they appear in, so faces, wardrobe and places stay the same from the first shot to the last.
          </p>
        </div>
        <div className="flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Character name" className="w-48" />
          <Button onClick={add}><Plus /> Add</Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge tone="cyan">{state.characters.filter((c) => c.locked).length} locked</Badge>
        <Badge>{totalRefs} reference images</Badge>
        {state.characters.some((c) => !c.references.length) && <Badge tone="warn">{state.characters.filter((c) => !c.references.length).length} without references</Badge>}
      </div>
      {!state.characters.length && <Empty icon={<Users />} title="No characters yet">They’re detected automatically when you parse a script, or add them by name above.</Empty>}
      <div className="grid gap-5 xl:grid-cols-2">
        {state.characters.map((c) => <CharacterCard key={c.id} c={c} />)}
      </div>
      <ElementsSection />
    </div>
  );
}

/** A design job for a character or set is queued or running. */
function useDesigning(key: "characterId" | "elementId", id: string) {
  const { state } = useStudio();
  return !!state?.jobs.some((j) => j.type === "DESIGN_SHEET" && ["QUEUED", "RUNNING"].includes(j.status) && (j.input as Record<string, string>)?.[key] === id);
}

function ElementsSection() {
  const { state, projectId } = useStudio();
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<"location" | "prop">("location");
  if (!state) return null;
  const add = async () => {
    if (!name.trim()) return;
    await api(`/api/projects/${projectId}/elements`, { body: { name, kind } });
    setName("");
  };
  return (
    <div className="space-y-4 border-t border-line pt-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold">Film sets & props</h2>
          <p className="max-w-2xl text-sm text-muted">Every scene set here sends its plates as references, so a place looks the same in every scene that returns to it.</p>
        </div>
        <div className="flex gap-2">
          <div className="flex rounded-lg border border-line-2 p-0.5">
            {(["location", "prop"] as const).map((k) => (
              <button key={k} onClick={() => setKind(k)} className={cn("rounded-md px-2 py-1 text-xs", kind === k ? "bg-panel-3 text-fg" : "text-dim")}>{k === "location" ? "Set" : "Prop"}</button>
            ))}
          </div>
          <Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder={kind === "location" ? "Set name" : "Prop name"} className="w-44" />
          <Button onClick={add}><Plus /> Add</Button>
        </div>
      </div>
      {!state.elements.length && <Empty icon={<MapPin />} title="No sets yet">They are created when the film is written or a script is imported, or add them above.</Empty>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {state.elements.map((e) => <ElementCard key={e.id} e={e} />)}
      </div>
    </div>
  );
}

function ElementCard({ e }: { e: Element }) {
  const { state, projectId } = useStudio();
  const [desc, setDesc] = React.useState(e.description);
  const busy = useDesigning("elementId", e.id);
  const scenes = state?.scenes.filter((s) => s.locationId === e.id).length ?? 0;
  const patch = (body: Record<string, unknown>) => api(`/api/elements/${e.id}`, { method: "PATCH", body });
  const upload = async (files: FileList) => {
    const form = new FormData();
    form.append("role", "ELEMENT_REF");
    form.append("elementId", e.id);
    form.append("lockStyle", "false");
    Array.from(files).forEach((f) => form.append("files", f));
    await api(`/api/projects/${projectId}/assets`, { form });
  };
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        {e.kind === "prop" ? <Box className="size-4 text-dim" /> : <MapPin className="size-4" style={{ color: e.color }} />}
        <input defaultValue={e.name} onBlur={(x) => x.target.value !== e.name && patch({ name: x.target.value })} className="min-w-0 flex-1 bg-transparent font-display text-sm font-semibold outline-none focus:text-accent" />
        {scenes > 0 && <span className="text-[10px] text-dim">{scenes} scenes</span>}
        <Switch checked={e.locked} onCheckedChange={(v) => patch({ locked: v })} />
        <button className="text-dim hover:text-err" onClick={() => confirm(`Delete ${e.name}?`) && api(`/api/elements/${e.id}`, { method: "DELETE" })} aria-label="Delete"><Trash2 className="size-3.5" /></button>
      </div>
      <div className="grid grid-cols-4 gap-1.5 p-3">
        {e.references.slice(0, 8).map((r) => (
          <div key={r.id} className="group relative aspect-video overflow-hidden rounded-lg border border-line-2 bg-panel-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={r.url} alt="" className="size-full object-cover" />
            <button onClick={() => api(`/api/assets/${r.id}`, { method: "DELETE" })} className="absolute right-0.5 top-0.5 rounded bg-black/70 p-0.5 opacity-0 group-hover:opacity-100" aria-label="Remove"><X className="size-3" /></button>
          </div>
        ))}
        {busy && <div className="grid aspect-video place-items-center rounded-lg border border-accent/40 bg-panel-2"><Loader2 className="size-4 animate-spin text-accent" /></div>}
        <label className="grid aspect-video cursor-pointer place-items-center rounded-lg border border-dashed border-line-2 text-dim hover:border-accent/50">
          <ImagePlus className="size-4" />
          <input type="file" accept="image/*" multiple className="hidden" onChange={(x) => x.target.files && upload(x.target.files)} />
        </label>
      </div>
      <div className="space-y-2 border-t border-line p-3">
        <Textarea rows={2} value={desc} onChange={(x) => setDesc(x.target.value)} onBlur={() => desc !== e.description && patch({ description: desc })} placeholder="What it looks like: era, materials, light, layout…" />
        <Button size="xs" variant="outline" disabled={busy} onClick={() => api(`/api/projects/${projectId}/design`, { body: { elementId: e.id, kind: "plate" } }).then(() => toast.success(`Drawing ${e.name}`))}>
          <Sparkles /> {e.references.length ? "Redraw" : "Draw"} {e.kind === "prop" ? "prop sheet" : "set plates"}
        </Button>
      </div>
    </div>
  );
}

function WardrobeRow({ c }: { c: Character }) {
  const { projectId } = useStudio();
  const [adding, setAdding] = React.useState(false);
  const [look, setLook] = React.useState("");
  const [what, setWhat] = React.useState("");
  const looks = c.references.filter((r) => r.role === "WARDROBE_REF");
  const uploadLook = async (file: File) => {
    if (!look.trim()) return toast.error("Name the look first");
    const form = new FormData();
    form.append("role", "WARDROBE_REF");
    form.append("characterId", c.id);
    form.append("look", look.trim());
    form.append("lockStyle", "false");
    form.append("files", file);
    await api(`/api/projects/${projectId}/assets`, { form });
    setAdding(false);
    setLook("");
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted"><Shirt className="size-3.5" /> Wardrobe looks</div>
      <div className="flex flex-wrap gap-2">
        {looks.map((l) => (
          <div key={l.id} className="group relative w-16">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={l.url} alt={l.name ?? ""} className="aspect-[3/4] w-16 rounded-lg border border-line-2 object-cover" />
            <div className="truncate text-center text-[10px] text-dim">{l.name}</div>
            <button onClick={() => api(`/api/assets/${l.id}`, { method: "DELETE" })} className="absolute right-0.5 top-0.5 rounded bg-black/70 p-0.5 opacity-0 group-hover:opacity-100" aria-label="Remove look"><X className="size-3" /></button>
          </div>
        ))}
        <button onClick={() => setAdding(!adding)} className="grid aspect-[3/4] w-16 place-items-center rounded-lg border border-dashed border-line-2 text-dim hover:border-accent/50"><Plus className="size-4" /></button>
      </div>
      {adding && (
        <div className="space-y-2 rounded-lg border border-line bg-panel-2 p-2.5">
          <Input className="h-8" value={look} onChange={(e) => setLook(e.target.value)} placeholder="Look name, e.g. Wedding suit, Act 3 battle armour" />
          <Input className="h-8" value={what} onChange={(e) => setWhat(e.target.value)} placeholder="What they wear (for the AI)" />
          <div className="flex gap-2">
            <Button size="xs" disabled={!look.trim()} onClick={async () => { await api(`/api/projects/${projectId}/design`, { body: { characterId: c.id, kind: "wardrobe", look: look.trim(), lookDescription: what } }); toast.success(`Designing ${look}`); setAdding(false); setLook(""); setWhat(""); }}><Sparkles /> Design with AI</Button>
            <label className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border border-line-2 px-2 text-[11px] text-muted hover:text-fg">
              <ImagePlus className="size-3" /> Use my photo
              <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && uploadLook(e.target.files[0])} />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

function CharacterCard({ c }: { c: Character }) {
  const { state, projectId } = useStudio();
  const [desc, setDesc] = React.useState(c.description);
  const [voice, setVoice] = React.useState(c.voiceId?.toString() ?? "");
  const [drag, setDrag] = React.useState<string | null>(null);
  const appearances = state?.shots.filter((s) => s.characterIds.includes(c.id)).length ?? 0;
  const designing = useDesigning("characterId", c.id);
  const sheet = c.references.find((r) => r.id === c.sheetAssetId);
  React.useEffect(() => setDesc(c.description), [c.description]);

  const patch = (body: Record<string, unknown>) => api(`/api/characters/${c.id}`, { method: "PATCH", body });
  const upload = async (files: FileList | File[], angle?: string) => {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;
    const form = new FormData();
    form.append("role", "CHARACTER_REF");
    form.append("characterId", c.id);
    list.forEach((f, i) => {
      form.append("files", f);
      form.append("angle", angle ?? ANGLES[Math.min(i + c.references.length, ANGLES.length - 1)].key);
    });
    await api(`/api/projects/${projectId}/assets`, { form });
    toast.success(`${list.length} reference${list.length > 1 ? "s" : ""} added to ${c.name}`);
  };

  return (
    <div className={cn("overflow-hidden rounded-2xl border bg-panel transition", c.locked ? "border-line-2" : "border-line")}>
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <span className="size-3 rounded-full" style={{ background: c.color, boxShadow: `0 0 12px ${c.color}` }} />
        <input defaultValue={c.name} onBlur={(e) => e.target.value !== c.name && patch({ name: e.target.value })} className="min-w-0 flex-1 bg-transparent font-display text-lg font-semibold outline-none focus:text-accent" />
        {c.handle && <span className="font-mono text-[11px] text-dim">@{c.handle}</span>}
        <select value={c.role ?? "supporting"} onChange={(e) => patch({ role: e.target.value })} className="rounded-md border border-line-2 bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted outline-none">
          {["lead", "supporting", "minor", "extra"].map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <span className="text-xs text-dim">{appearances} shots</span>
        <Tip content={c.locked ? "Locked: references are injected into every generation" : "Unlocked: references only used when linked to a shot"}>
          <span className="flex items-center gap-1.5">
            {c.locked ? <Lock className="size-3.5 text-accent" /> : <Unlock className="size-3.5 text-dim" />}
            <Switch checked={c.locked} onCheckedChange={(v) => patch({ locked: v })} />
          </span>
        </Tip>
        <button className="text-dim hover:text-err" onClick={() => confirm(`Delete ${c.name}?`) && api(`/api/characters/${c.id}`, { method: "DELETE" })} aria-label="Delete character">
          <Trash2 className="size-4" />
        </button>
      </div>
      <div className="grid grid-cols-5 gap-2 p-4">
        {ANGLES.map((a) => {
          const ref = c.references.find((r) => r.angle === a.key && r.role === "CHARACTER_REF");
          return (
            <label
              key={a.key}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(a.key);
              }}
              onDragLeave={() => setDrag(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(null);
                upload(e.dataTransfer.files, a.key);
              }}
              className={cn("group relative aspect-[3/4] cursor-pointer overflow-hidden rounded-xl border bg-panel-2 transition", drag === a.key ? "border-accent" : ref ? "border-line-2" : "border-dashed border-line-2 hover:border-accent/50")}
            >
              {ref ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={ref.url} alt={`${c.name} ${a.label}`} className="size-full object-cover" />
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      api(`/api/assets/${ref.id}`, { method: "DELETE" });
                    }}
                    className="absolute right-1 top-1 rounded bg-black/70 p-0.5 text-muted opacity-0 transition hover:text-err group-hover:opacity-100"
                    aria-label="Remove reference"
                  >
                    <X className="size-3" />
                  </button>
                </>
              ) : (
                <div className="grid size-full place-items-center text-dim"><ImagePlus className="size-5" /></div>
              )}
              <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4 text-center text-[10px] font-medium">{a.label}</span>
              <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files && upload(e.target.files, a.key)} />
            </label>
          );
        })}
      </div>
      <div className="flex items-center gap-2 px-4 pb-3">
        <Button size="xs" variant="outline" disabled={designing} onClick={() => api(`/api/projects/${projectId}/design`, { body: { characterId: c.id, kind: "turnaround" } }).then(() => toast.success(`Drawing ${c.name}'s design sheet`))}>
          {designing ? <Loader2 className="animate-spin" /> : <Sparkles />} {sheet ? "Redraw design sheet" : "AI design sheet"}
        </Button>
        {sheet && (
          <a href={sheet.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={sheet.url} alt={`${c.name} design sheet`} className="h-12 rounded-md border border-line-2 object-cover" />
          </a>
        )}
      </div>
      {c.references.filter((r) => r.role === "CHARACTER_REF" && !ANGLES.some((a) => a.key === r.angle)).length > 0 && (
        <div className="flex gap-2 overflow-x-auto px-4 pb-3">
          {c.references.filter((r) => r.role === "CHARACTER_REF" && !ANGLES.some((a) => a.key === r.angle)).map((r) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={r.id} src={r.url} alt="" className="h-16 rounded-lg border border-line-2" />
          ))}
        </div>
      )}
      <div className="space-y-3 border-t border-line p-4">
        <WardrobeRow c={c} />
        <Textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={() => desc !== c.description && patch({ description: desc })} placeholder="Visual description: age, build, face, hair, wardrobe, signature props…" />
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line-2 px-2.5 py-1.5 text-xs text-muted transition hover:border-accent/50 hover:text-fg">
            <ImagePlus className="size-3.5" /> Add more references
            <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => e.target.files && upload(e.target.files)} />
          </label>
          <div className="ml-auto flex items-center gap-1.5">
            <Mic className="size-3.5 text-dim" />
            <Input className="h-8 w-32" value={voice} onChange={(e) => setVoice(e.target.value)} onBlur={() => patch({ voiceId: voice ? Number(voice) : null })} placeholder="Voice ID" inputMode="numeric" />
          </div>
        </div>
      </div>
    </div>
  );
}

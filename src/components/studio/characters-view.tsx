"use client";
import * as React from "react";
import { ImagePlus, Lock, Plus, Trash2, Unlock, Users, X, Mic } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Empty, Switch, Tip } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import { useStudio, type Character } from "./store";

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
          <h1 className="font-display text-2xl font-bold">Characters</h1>
          <p className="max-w-2xl text-sm text-muted">
            Upload front, side and 3/4 references. Locked characters inject their references into every frame and clip they appear in, and the Consistency agent checks each result against them.
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
    </div>
  );
}

function CharacterCard({ c }: { c: Character }) {
  const { state, projectId } = useStudio();
  const [desc, setDesc] = React.useState(c.description);
  const [voice, setVoice] = React.useState(c.voiceId?.toString() ?? "");
  const [drag, setDrag] = React.useState<string | null>(null);
  const appearances = state?.shots.filter((s) => s.characterIds.includes(c.id)).length ?? 0;
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
          const ref = c.references.find((r) => r.angle === a.key);
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
      {c.references.filter((r) => !ANGLES.some((a) => a.key === r.angle)).length > 0 && (
        <div className="flex gap-2 overflow-x-auto px-4 pb-3">
          {c.references.filter((r) => !ANGLES.some((a) => a.key === r.angle)).map((r) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={r.id} src={r.url} alt="" className="h-16 rounded-lg border border-line-2" />
          ))}
        </div>
      )}
      <div className="space-y-3 border-t border-line p-4">
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

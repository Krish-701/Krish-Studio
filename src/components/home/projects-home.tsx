"use client";
import { ConnectionCheck } from "@/components/connection-check";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Clapperboard, FileText, Film, Plus, Settings, Sparkles, Trash2, Upload, Users } from "lucide-react";
import { toast } from "sonner";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { api, fetcher } from "@/lib/client";
import { ASPECT_RATIOS } from "@/lib/generation/catalog";

interface ProjectRow {
  id: string;
  title: string;
  logline: string | null;
  stage: string;
  aspectRatio: string;
  updatedAt: string;
  coverUrl: string | null;
  _count: { shots: number; characters: number };
}

const STAGES = ["SCRIPT", "STORYBOARD", "VIDEO", "AUDIO", "EXPORT"];

export function ProjectsHome() {
  const { data, mutate } = useSWR<ProjectRow[]>("/api/projects", fetcher);
  const { data: health } = useSWR<{ llm: boolean; magnific: boolean; queue: string }>("/api/health", fetcher);
  const [open, setOpen] = React.useState(false);

  return (
    <div className="min-h-screen overflow-x-hidden">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <Brand />
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/settings">
                <Settings /> <span className="hidden sm:inline">Settings</span>
              </Link>
            </Button>
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus /> New film
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 pb-24 sm:px-6">
        <section className="relative py-14 sm:py-20">
          <div className="pointer-events-none absolute -left-40 -top-40 size-[520px] rounded-full bg-accent/10 blur-[120px]" />
          <div className="pointer-events-none absolute -right-20 top-10 size-[380px] rounded-full bg-violet/10 blur-[120px]" />
          <div className="relative max-w-3xl">
            <Badge tone="accent" className="mb-5">
              <Sparkles className="size-3" /> Script → Storyboard → Film
            </Badge>
            <h1 className="font-display text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
              Direct your film with a <span className="text-gradient">live AI crew</span>.
            </h1>
            <p className="mt-5 max-w-2xl text-base text-muted sm:text-lg">
              From a 30-second ad to a 3-hour feature. Start from an idea or a script; the crew writes it in acts, sequences and scenes,
              designs your cast and sets, keeps every face and place consistent with references, renders frames and clips through Magnific,
              and cuts it together with voice, music and sound.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button size="lg" onClick={() => setOpen(true)}>
                <Clapperboard /> Start a new film
              </Button>
              <Button size="lg" variant="secondary" asChild>
                <Link href="/settings">
                  <Settings /> Connect AI & Magnific
                </Link>
              </Button>
            </div>
            {health && (
              <div className="mt-6 flex flex-wrap gap-2 text-xs">
                <Badge tone={health.llm ? "ok" : "warn"}>{health.llm ? "AI assistant connected" : "AI assistant not configured"}</Badge>
                <Badge tone={health.magnific ? "ok" : "warn"}>{health.magnific ? "Magnific connected" : "Magnific not connected · press Connect Magnific below"}</Badge>
                <Badge>{health.queue === "bullmq" ? "BullMQ queue" : "In-process queue"}</Badge>
              </div>
            )}
          </div>
        </section>
        <ConnectionCheck className="mb-10" />

        <div className="mb-4 flex items-end justify-between">
          <h2 className="font-display text-xl font-semibold">Your films</h2>
          <span className="text-sm text-dim">{data?.length ?? 0} projects</span>
        </div>

        {data && !data.length && (
          <button onClick={() => setOpen(true)} className="flex w-full flex-col items-center justify-center rounded-2xl border border-dashed border-line-2 py-20 text-muted transition hover:border-accent/50 hover:text-fg">
            <Film className="mb-3 size-10" />
            <div className="font-display text-lg">No films yet</div>
            <div className="text-sm text-dim">Create your first project to begin.</div>
          </button>
        )}

        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {data?.map((p) => {
            const stageIdx = STAGES.indexOf(p.stage);
            return (
              <Link key={p.id} href={`/projects/${p.id}`} className="group relative overflow-hidden rounded-2xl border border-line bg-panel transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-[0_20px_60px_-30px_rgb(245_165_36/0.5)]">
                <div className="relative aspect-video overflow-hidden bg-panel-2">
                  {p.coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.coverUrl} alt="" className="size-full object-cover transition duration-700 group-hover:scale-105" />
                  ) : (
                    <div className="grid size-full place-items-center bg-[radial-gradient(ellipse_at_30%_30%,rgb(245_165_36/0.15),transparent_60%)]">
                      <Clapperboard className="size-10 text-dim" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-panel via-transparent to-transparent" />
                  <Badge tone="accent" className="absolute left-3 top-3 bg-black/60 backdrop-blur">{p.stage}</Badge>
                  <button
                    aria-label="Delete project"
                    onClick={async (e) => {
                      e.preventDefault();
                      if (!confirm(`Delete "${p.title}" and all its media?`)) return;
                      await api(`/api/projects/${p.id}`, { method: "DELETE" });
                      mutate();
                    }}
                    className="absolute right-3 top-3 rounded-md bg-black/60 p-1.5 text-muted opacity-0 backdrop-blur transition hover:text-err group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
                <div className="p-4">
                  <div className="font-display text-lg font-semibold leading-tight">{p.title}</div>
                  {p.logline && <div className="mt-1 line-clamp-2 text-sm text-muted">{p.logline}</div>}
                  <div className="mt-4 flex gap-1">
                    {STAGES.map((s, i) => (
                      <div key={s} className={`h-1 flex-1 rounded-full ${i <= stageIdx ? "bg-gradient-to-r from-accent to-accent-2" : "bg-panel-3"}`} />
                    ))}
                  </div>
                  <div className="mt-3 flex items-center gap-4 text-xs text-dim">
                    <span className="flex items-center gap-1"><Film className="size-3" /> {p._count.shots} shots</span>
                    <span className="flex items-center gap-1"><Users className="size-3" /> {p._count.characters} characters</span>
                    <span className="ml-auto">{p.aspectRatio}</span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </main>

      <NewProjectDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const [quick, setQuick] = React.useState(false);
  const startWizard = async () => {
    const p = await api<{ id: string }>("/api/projects", { body: { title: "Untitled film", wizard: true } });
    router.push(`/projects/${p.id}`);
  };
  const [title, setTitle] = React.useState("");
  const [logline, setLogline] = React.useState("");
  const [aspect, setAspect] = React.useState("16:9");
  const [file, setFile] = React.useState<File | null>(null);
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const p = await api<{ id: string }>("/api/projects", { body: { title: title || file?.name.replace(/\.[^.]+$/, "") || "Untitled film", logline, aspectRatio: aspect } });
      if (file || text.trim()) {
        const form = new FormData();
        if (file) form.append("file", file);
        else form.append("text", text);
        await api(`/api/projects/${p.id}/script`, { form });
        toast.success("Script uploaded. The Director is breaking it into shots…");
      }
      router.push(`/projects/${p.id}${file || text.trim() ? "#script" : "#script"}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New film" description="Start from an idea with the guided setup, or bring a finished script." className="max-w-xl">
        {!quick ? (
          <div className="grid gap-3 p-5 sm:grid-cols-2">
            <button onClick={startWizard} className="rounded-2xl border border-accent/40 bg-accent/5 p-4 text-left transition hover:border-accent">
              <Sparkles className="mb-2 size-5 text-accent" />
              <div className="font-display font-semibold">Start from an idea</div>
              <div className="mt-1 text-xs text-muted">Pick a format from a 30-second ad to a 3-hour feature, describe the story, choose a look and cast, and the AI writes every scene and shot.</div>
            </button>
            <button onClick={() => setQuick(true)} className="rounded-2xl border border-line p-4 text-left transition hover:border-line-2">
              <FileText className="mb-2 size-5 text-muted" />
              <div className="font-display font-semibold">I have a script</div>
              <div className="mt-1 text-xs text-muted">Upload a PDF, Final Draft, Fountain or text script and it is broken into scenes, shots, cast and sets.</div>
            </button>
          </div>
        ) : (
        <div className="space-y-4 p-5">
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="The Last Lighthouse" />
          </div>
          <div className="space-y-1.5">
            <Label>Logline</Label>
            <Input value={logline} onChange={(e) => setLogline(e.target.value)} placeholder="A keeper and a stranger wait out the storm of the century." />
          </div>
          <div className="space-y-1.5">
            <Label>Aspect ratio</Label>
            <div className="flex flex-wrap gap-2">
              {ASPECT_RATIOS.map((a) => (
                <button key={a} onClick={() => setAspect(a)} className={`rounded-lg border px-3 py-1.5 text-xs transition ${aspect === a ? "border-accent bg-accent/10 text-accent" : "border-line-2 text-muted hover:text-fg"}`}>
                  {a}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Script (PDF, Final Draft, Fountain, TXT)</Label>
            <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-line-2 bg-panel-2 px-4 py-4 transition hover:border-accent/50">
              {file ? <FileText className="size-5 text-accent" /> : <Upload className="size-5 text-muted" />}
              <div className="text-sm">
                {file ? <span className="text-fg">{file.name}</span> : <span className="text-muted">Choose a file or drop it here</span>}
              </div>
              <input type="file" accept=".pdf,.txt,.fountain,.fdx,.md,text/plain,application/pdf" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            {!file && <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="…or paste the script text here" />}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setQuick(false)}>Back</Button>
            <Button onClick={create} disabled={busy}>
              <Clapperboard /> {busy ? "Creating…" : "Create film"}
            </Button>
          </div>
        </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

"use client";
import * as React from "react";
import Link from "next/link";
import useSWR from "swr";
import { ArrowDown, ArrowLeft, ArrowUp, Bot, CheckCircle2, Cpu, Plug, Plus, Save, Server, ShieldCheck, Trash2, XCircle, Zap } from "lucide-react";
import { toast } from "sonner";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Section, Switch } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";
import { api, fetcher } from "@/lib/client";
import { AGENT_LIST } from "@/lib/agents/definitions";
import { ConnectionCheck, connectMagnific } from "@/components/connection-check";
import type { Capability, LlmCaps, McpServerConfig } from "@/lib/settings";

const CAPS: Capability[] = ["image", "video", "tts", "music", "sfx", "upscale", "inpaint"];

const PRESETS: { name: string; url: string; model: string; reasoning?: boolean }[] = [
  { name: "OpenRouter · Qwen3.8 Omni Flash (default)", url: "https://openrouter.ai/api/v1", model: "qwen/qwen3.8-omni-flash", reasoning: true },
  { name: "OpenAI", url: "https://api.openai.com/v1", model: "gpt-4o" },
  { name: "Anthropic", url: "https://api.anthropic.com/v1", model: "claude-sonnet-5-5" },
  { name: "OpenRouter · Qwen 3.8 Flash", url: "https://openrouter.ai/api/v1", model: "qwen/qwen3.8-flash", reasoning: true },
  { name: "Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-pro" },
  { name: "xAI Grok", url: "https://api.x.ai/v1", model: "grok-4" },
  { name: "Groq", url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  { name: "Ollama (local)", url: "http://localhost:11434/v1", model: "llama3.2-vision" },
  { name: "LM Studio", url: "http://localhost:1234/v1", model: "local-model" },
];

type Server = McpServerConfig & { hasToken?: boolean };

interface SettingsData {
  llmBaseUrl: string;
  llmApiKey: string;
  hasLlmKey: boolean;
  llmModel: string;
  agentModels: Record<string, string>;
  autoAgents: boolean;
  llmReasoning: boolean;
  visionModel: string;
  llmCaps: LlmCaps | null;
  mcpServers: Server[];
}

const TOOLMAP_EXAMPLE = JSON.stringify(
  {
    image: { tool: "generate_image", args: '{"prompt":"{{prompt}}","aspect_ratio":"{{aspect_ratio}}","image_urls":{{reference_urls}}}' },
    video: { tool: "generate_video", args: '{"prompt":"{{prompt}}","image_url":"{{image_url}}","duration":{{duration}}}', poll: { tool: "get_task", args: '{"id":"{{id}}"}' } },
  },
  null,
  2,
);

export function SettingsPage() {
  const { data, mutate } = useSWR<SettingsData>("/api/settings", fetcher);
  const [form, setForm] = React.useState<SettingsData | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [validating, setValidating] = React.useState(false);
  const [tests, setTests] = React.useState<Record<string, { ok: boolean; detail: string } | "running">>({});

  React.useEffect(() => {
    if (data && !form) setForm(data);
  }, [data, form]);

  if (!form) return <div className="grid min-h-screen place-items-center text-muted">Loading settings…</div>;

  const set = <K extends keyof SettingsData>(k: K, v: SettingsData[K]) => setForm({ ...form, [k]: v });
  const setServer = (i: number, patch: Partial<Server>) => set("mcpServers", form.mcpServers.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: -1 | 1) => {
    const list = [...form.mcpServers];
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    set("mcpServers", list);
  };

  const save = async () => {
    setSaving(true);
    try {
      const next = await api<SettingsData>("/api/settings", { method: "PUT", body: form });
      setForm(next);
      mutate(next, { revalidate: false });
      toast.success("Settings saved");
      return true;
    } finally {
      setSaving(false);
    }
  };

  const test = async (key: string, body: Record<string, string>) => {
    if (!(await save())) return;
    setTests((t) => ({ ...t, [key]: "running" }));
    const r = await api<{ ok: boolean; detail: string }>("/api/settings/test", { body });
    setTests((t) => ({ ...t, [key]: r }));
  };

  const validate = async () => {
    if (!(await save())) return;
    setValidating(true);
    try {
      const r = await api<{ ok: boolean; detail: string; caps: LlmCaps }>("/api/settings/test", { body: { target: "validate" } });
      setForm((f) => (f ? { ...f, llmCaps: r.caps } : f));
      mutate();
      (r.ok ? toast.success : toast.error)(`Model validation: ${r.detail}`);
    } finally {
      setValidating(false);
    }
  };

  const TestResult = ({ k }: { k: string }) => {
    const t = tests[k];
    if (!t) return null;
    if (t === "running") return <span className="text-xs text-muted">Testing…</span>;
    return (
      <span className={`flex items-center gap-1 text-xs ${t.ok ? "text-ok" : "text-err"}`}>
        {t.ok ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />} {t.detail}
      </span>
    );
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon-sm" onClick={() => history.back()} aria-label="Back">
              <ArrowLeft />
            </Button>
            <Brand />
          </div>
          <Button onClick={save} disabled={saving}>
            <Save /> {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
        <div>
          <h1 className="font-display text-3xl font-bold">Settings</h1>
          <p className="mt-1 text-muted">Change the AI model and generation backends at any time. Keys are encrypted at rest.</p>
        </div>
        <ConnectionCheck />

        <Section title={<span className="flex items-center gap-2"><Bot className="size-4 text-accent" /> AI assistant · OpenAI-compatible API</span>} actions={<TestResult k="llm" />}>
          <div className="mb-4 flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button key={p.name} onClick={() => setForm({ ...form, llmBaseUrl: p.url, llmModel: p.model, llmReasoning: !!p.reasoning })} className={`rounded-lg border px-2.5 py-1 text-xs transition ${form.llmBaseUrl === p.url ? "border-accent bg-accent/10 text-accent" : "border-line-2 text-muted hover:text-fg"}`}>
                {p.name}
              </button>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Base URL</Label>
              <Input value={form.llmBaseUrl} onChange={(e) => set("llmBaseUrl", e.target.value)} placeholder="https://api.openai.com/v1" />
            </div>
            <div className="space-y-1.5">
              <Label>API key</Label>
              <Input type="password" value={form.llmApiKey} onChange={(e) => set("llmApiKey", e.target.value)} placeholder={form.hasLlmKey ? "Saved" : "sk-…"} />
            </div>
            <div className="space-y-1.5">
              <Label>Model</Label>
              <Input value={form.llmModel} onChange={(e) => set("llmModel", e.target.value)} placeholder="gpt-4o, claude-sonnet-5-5, gemini-2.5-pro…" />
            </div>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-panel-2 px-4 py-3">
              <div>
                <div className="text-sm font-medium">Reasoning</div>
                <div className="text-xs text-muted">Sends reasoning: enabled and passes reasoning_details back unmodified on every turn (OpenRouter).</div>
              </div>
              <Switch checked={form.llmReasoning} onCheckedChange={(v) => set("llmReasoning", v)} />
            </div>
            <div className="space-y-1.5">
              <Label>Vision model for frame checks (optional)</Label>
              <Input value={form.visionModel} onChange={(e) => set("visionModel", e.target.value)} placeholder={`Blank = ${form.llmModel || "main model"}`} />
              <p className="text-xs text-dim">Only needed if the main model can't see images. Validate shows whether it can.</p>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between rounded-xl border border-line bg-panel-2 px-4 py-3">
            <div>
              <div className="text-sm font-medium">Sub-agents run automatically</div>
              <div className="text-xs text-muted">Check every new frame for character consistency and style drift, and watch the render queue.</div>
            </div>
            <Switch checked={form.autoAgents} onCheckedChange={(v) => set("autoAgents", v)} />
          </div>
          <div className="mt-4 flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => test("llm", { target: "llm" })}>
              <Zap /> Test connection
            </Button>
            <Button size="sm" onClick={validate} disabled={validating}>
              <ShieldCheck /> {validating ? "Validating model…" : "Validate model"}
            </Button>
          </div>
          {form.llmCaps && <CapsReport caps={form.llmCaps} current={form.llmModel} />}

          <div className="mt-6">
            <Label>Per-agent model overrides (optional)</Label>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              {AGENT_LIST.map((a) => (
                <div key={a.kind} className="flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: a.color }} />
                  <span className="w-36 shrink-0 text-xs">{a.name}</span>
                  <Input className="h-8" value={form.agentModels[a.kind] ?? ""} onChange={(e) => set("agentModels", { ...form.agentModels, [a.kind]: e.target.value })} placeholder={form.llmModel} />
                </div>
              ))}
            </div>
          </div>
        </Section>

        <Section
          title={<span className="flex items-center gap-2"><Server className="size-4 text-accent" /> Generation backends · MCP</span>}
          actions={
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                set("mcpServers", [
                  ...form.mcpServers,
                  { id: `mcp-${Date.now().toString(36)}`, name: "Custom MCP server", kind: "mcp", url: "https://", token: "", enabled: false, capabilities: ["image", "video"], toolMap: JSON.parse(TOOLMAP_EXAMPLE) },
                ])
              }
            >
              <Plus /> Add MCP server
            </Button>
          }
        >
          <p className="mb-4 text-sm text-muted">
            Backends are tried top to bottom. If one fails, the next one that supports the task takes over. Magnific is the primary backend; add Veo, Kling,
            MiniMax, Wan or any other MCP server as a fallback.
          </p>
          <div className="space-y-3">
            {form.mcpServers.map((s, i) => (
              <div key={s.id} className={`rounded-xl border p-4 transition ${s.enabled ? "border-line-2 bg-panel-2" : "border-line bg-panel opacity-70"}`}>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="grid size-8 place-items-center rounded-lg bg-panel-3 text-accent">{s.kind === "mock" ? <Cpu className="size-4" /> : <Plug className="size-4" />}</div>
                  <Input className="h-8 w-56" value={s.name} onChange={(e) => setServer(i, { name: e.target.value })} />
                  <Badge tone={s.kind === "magnific" ? "accent" : s.kind === "mock" ? "neutral" : "violet"}>{s.kind === "mock" ? "built-in" : s.kind}</Badge>
                  <span className="text-xs text-dim">Priority {i + 1}</span>
                  <div className="ml-auto flex items-center gap-1">
                    <TestResult k={s.id} />
                    <Button size="icon-sm" variant="ghost" onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp /></Button>
                    <Button size="icon-sm" variant="ghost" onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown /></Button>
                    {s.kind === "mcp" && (
                      <Button size="icon-sm" variant="ghost" onClick={() => set("mcpServers", form.mcpServers.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 /></Button>
                    )}
                    <Switch checked={s.enabled} onCheckedChange={(v) => setServer(i, { enabled: v })} />
                  </div>
                </div>
                {s.kind === "magnific" && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent/20 bg-accent/5 p-3 text-xs">
                    {s.oauthConnected ? <CheckCircle2 className="size-4 text-ok" /> : <XCircle className="size-4 text-warn" />}
                    <span className="mr-auto">{s.oauthConnected ? "Signed in to Magnific. Frames, clips and audio are generated on your account." : s.hasToken ? "Using the access token below." : "Not connected. Sign in with your Magnific / Freepik account; no token needed."}</span>
                    <Button size="sm" onClick={async () => { if (await connectMagnific(s.id)) location.reload(); }}><Plug /> {s.oauthConnected ? "Reconnect" : "Connect Magnific"}</Button>
                    {s.oauthConnected && <Button size="sm" variant="ghost" onClick={async () => { await api("/api/mcp/oauth/disconnect", { body: { serverId: s.id } }); location.reload(); }}>Disconnect</Button>}
                  </div>
                )}
                {s.kind !== "mock" ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-[1.2fr_1fr_0.6fr_auto]">
                    <div className="space-y-1">
                      <Label>MCP URL</Label>
                      <Input value={s.url} onChange={(e) => setServer(i, { url: e.target.value })} />
                    </div>
                    <div className="space-y-1">
                      <Label>Access token</Label>
                      <Input type="password" value={s.token ?? ""} onChange={(e) => setServer(i, { token: e.target.value })} placeholder={s.hasToken ? "Saved" : "Bearer token / API key"} />
                    </div>
                    <div className="space-y-1">
                      <Label>Auth header</Label>
                      <Input value={s.authHeader ?? ""} onChange={(e) => setServer(i, { authHeader: e.target.value })} placeholder="Authorization" />
                    </div>
                    <div className="flex items-end">
                      <Button size="sm" variant="secondary" onClick={() => test(s.id, { target: "mcp", serverId: s.id })}>
                        <Zap /> Test
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-dim">Draws placeholder frames (solid colours) and Ken-Burns clips locally with ffmpeg, for trying the pipeline without credits. It is only used when every other backend is turned off, never as a stand-in for Magnific.</p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {CAPS.map((c) => {
                    const on = s.capabilities.includes(c);
                    return (
                      <button key={c} onClick={() => setServer(i, { capabilities: on ? s.capabilities.filter((x) => x !== c) : [...s.capabilities, c] })} className={`rounded-md border px-2 py-0.5 text-[11px] transition ${on ? "border-accent/40 bg-accent/10 text-accent" : "border-line-2 text-dim"}`}>
                        {c}
                      </button>
                    );
                  })}
                </div>
                {s.kind === "mcp" && (
                  <div className="mt-3 space-y-1">
                    <Label>Tool mapping (JSON) — placeholders: {"{{prompt}} {{aspect_ratio}} {{duration}} {{image_url}} {{reference_urls}} {{text}} {{voice_id}} {{model}} {{id}}"}</Label>
                    <ToolMapEditor value={s.toolMap} onChange={(toolMap) => setServer(i, { toolMap })} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>

        <ModelsSection />

        <div className="flex justify-between">
          <Button variant="ghost" asChild>
            <Link href="/"><ArrowLeft /> Back to films</Link>
          </Button>
          <Button onClick={save} disabled={saving}>
            <Save /> Save settings
          </Button>
        </div>
      </main>
    </div>
  );
}

function ToolMapEditor({ value, onChange }: { value: McpServerConfig["toolMap"]; onChange: (v: McpServerConfig["toolMap"]) => void }) {
  const [text, setText] = React.useState(JSON.stringify(value ?? {}, null, 2));
  const [err, setErr] = React.useState<string | null>(null);
  return (
    <>
      <Textarea
        rows={8}
        className="font-mono text-xs"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value));
            setErr(null);
          } catch (x) {
            setErr((x as Error).message);
          }
        }}
      />
      {err && <div className="text-xs text-err">{err}</div>}
    </>
  );
}

function CapsReport({ caps, current }: { caps: LlmCaps; current: string }) {
  const stale = caps.model !== current;
  const pill = (label: string, on: boolean, fallback: string) => (
    <span className={`rounded-md border px-2 py-0.5 text-xs ${on ? "border-ok/40 text-ok" : "border-warn/40 text-warn"}`} title={on ? "" : fallback}>
      {label}: {on ? "yes" : `no · ${fallback}`}
    </span>
  );
  return (
    <div className="mt-4 rounded-xl border border-line bg-panel-2 p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium">
          Validated {caps.model} <span className="text-xs text-dim">{new Date(caps.checkedAt).toLocaleString()}</span>
        </div>
        {stale && <Badge tone="warn">Model changed, validate again</Badge>}
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {pill("Tool calling", caps.tools, "agents use prompted tools")}
        {pill("Reasoning", caps.reasoning, "runs without reasoning")}
        {pill("JSON", caps.json, "parsed from text")}
        {pill("Frame checks can see images", caps.visionModelOk ?? caps.vision, "rule-based checks only")}
      </div>
      <ul className="space-y-1">
        {caps.checks.map((c) => (
          <li key={c.id} className="flex items-start gap-2 text-xs">
            {c.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-ok" /> : <XCircle className="mt-0.5 size-3.5 shrink-0 text-err" />}
            <span>
              <span className="font-medium text-fg">{c.label}</span> <span className="text-muted">{c.detail}</span>
              {c.ms !== undefined && <span className="text-dim"> · {(c.ms / 1000).toFixed(1)}s</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Model catalog: what each image/video model accepts as references, synced live from Magnific. */
function ModelsSection() {
  const { data, mutate } = useSWR<{ image: ModelInfoLite[]; video: ModelInfoLite[]; synced: boolean; syncedAt: string | null }>("/api/models", fetcher);
  const [busy, setBusy] = React.useState(false);
  const sync = async () => {
    setBusy(true);
    try {
      const r = await api<{ image: number; video: number }>("/api/models", { method: "POST" });
      toast.success(`Synced ${r.video} video and ${r.image} image models`);
      mutate();
    } finally {
      setBusy(false);
    }
  };
  const row = (m: ModelInfoLite) => (
    <div key={m.slug} className="flex flex-wrap items-center gap-2 border-b border-line py-1.5 text-xs last:border-0">
      <span className="w-48 truncate font-medium">{m.name}</span>
      <span className="flex flex-1 flex-wrap gap-1">
        {Object.entries(m.refLimits).map(([k, v]) => <Badge key={k}>{k} {v}</Badge>)}
        {m.multishot && <Badge tone="accent">multi-shot {m.multishot.limit}</Badge>}
        {m.endFrame && <Badge>end frame</Badge>}
        {m.keyframesExclusive && <Badge tone="warn" title="Frames and references can't be combined; the planner picks one">frame or refs</Badge>}
      </span>
      {m.durations && <span className="text-dim">{m.durations[0]}–{m.durations[m.durations.length - 1]}s</span>}
    </div>
  );
  return (
    <Section
      title={<span className="flex items-center gap-2"><Cpu className="size-4 text-accent" /> Models & references</span>}
      actions={<Button size="sm" variant="secondary" onClick={sync} disabled={busy}><Zap /> {busy ? "Syncing…" : "Sync from Magnific"}</Button>}
    >
      <p className="mb-3 text-xs text-muted">
        What each model accepts as references (images, videos, audio, characters, style, colour). Every generation picks the best references the chosen model can take.
        {data?.syncedAt ? ` Synced ${new Date(data.syncedAt).toLocaleString()}.` : " Showing the built-in list; sync to pick up new models."}
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <div><Label>Video</Label><div className="mt-1">{data?.video.map(row)}</div></div>
        <div><Label>Image</Label><div className="mt-1">{data?.image.map(row)}</div></div>
      </div>
    </Section>
  );
}

interface ModelInfoLite {
  slug: string;
  name: string;
  refLimits: Record<string, number>;
  durations?: number[];
  multishot?: { limit: number };
  endFrame?: boolean;
  keyframesExclusive?: boolean;
}

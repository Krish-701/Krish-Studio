"use client";
import * as React from "react";
import Link from "next/link";
import { CheckCircle2, Circle, Link2, Loader2, PlugZap, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";

type Step = "llm" | "vision" | "magnific" | "image";
interface Result {
  step: Step;
  ok: boolean;
  detail: string;
  ms: number;
  url?: string;
}

const STEPS: { id: Step; label: string }[] = [
  { id: "llm", label: "AI model (Qwen3.8 Omni Flash)" },
  { id: "vision", label: "AI can see images" },
  { id: "magnific", label: "Magnific (Freepik) connected" },
  { id: "image", label: "Test image from Magnific" },
];

/** Opens the Magnific sign-in in a new window; resolves when the window reports back (or is closed). */
export async function connectMagnific(serverId = "magnific") {
  const r = await api<{ url?: string; connected?: boolean }>("/api/mcp/oauth/start", { body: { serverId } });
  if (r.connected) {
    toast.success("Magnific is already connected");
    return true;
  }
  const w = window.open(r.url!, "magnific-signin", "width=520,height=720");
  if (!w) {
    window.location.href = r.url!;
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type !== "mcp-oauth") return;
      cleanup();
      if (e.data.ok) toast.success("Magnific connected");
      else toast.error("Magnific sign-in failed");
      resolve(!!e.data.ok);
    };
    const timer = setInterval(() => {
      if (w.closed) {
        cleanup();
        resolve(false);
      }
    }, 800);
    const cleanup = () => {
      clearInterval(timer);
      window.removeEventListener("message", onMsg);
    };
    window.addEventListener("message", onMsg);
  });
}

/** "Check connections": AI model, image input, Magnific sign-in and one real test image. */
export function ConnectionCheck({ className, compact }: { className?: string; compact?: boolean }) {
  const [results, setResults] = React.useState<Partial<Record<Step, Result>>>({});
  const [running, setRunning] = React.useState<Step | null>(null);

  const run = async (only?: Step[]) => {
    const steps = only ?? STEPS.map((s) => s.id);
    for (const step of steps) {
      setRunning(step);
      try {
        const r = await api<Result>("/api/check", { body: { step } });
        setResults((x) => ({ ...x, [step]: r }));
        // No point making a test image without a working Magnific connection.
        if (!r.ok && step === "magnific") {
          setResults((x) => ({ ...x, image: { step: "image", ok: false, detail: "Skipped: connect Magnific first", ms: 0 } }));
          break;
        }
      } catch (e) {
        setResults((x) => ({ ...x, [step]: { step, ok: false, detail: (e as Error).message, ms: 0 } }));
      }
    }
    setRunning(null);
  };

  const magOk = results.magnific?.ok;
  const needsSignIn = results.magnific && !results.magnific.ok && /sign|connect|unauthori/i.test(results.magnific.detail);
  const all = STEPS.every((s) => results[s.id]?.ok);

  return (
    <div className={cn("rounded-2xl border border-line bg-panel p-4", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <PlugZap className="size-5 text-accent" />
        <div className="mr-auto">
          <div className="text-sm font-medium">Check connections</div>
          {!compact && <div className="text-[11px] text-muted">Run this before you start: it checks the AI, Magnific, and makes one real test image.</div>}
        </div>
        <Button variant="outline" size="sm" onClick={async () => { if (await connectMagnific()) run(["magnific", "image"]); }}>
          <Link2 /> {magOk ? "Reconnect Magnific" : "Connect Magnific"}
        </Button>
        <Button size="sm" disabled={!!running} onClick={() => run()}>
          {running ? <Loader2 className="animate-spin" /> : <PlugZap />} {Object.keys(results).length ? "Check again" : "Check"}
        </Button>
      </div>
      {(Object.keys(results).length > 0 || running) && (
        <div className="mt-3 space-y-1.5">
          {STEPS.map((s) => {
            const r = results[s.id];
            return (
              <div key={s.id} className="flex items-start gap-2 text-xs">
                {running === s.id ? <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-accent" /> : r ? r.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-ok" /> : <XCircle className="mt-0.5 size-3.5 shrink-0 text-err" /> : <Circle className="mt-0.5 size-3.5 shrink-0 text-dim" />}
                <div className="min-w-0">
                  <span className="text-fg">{s.label}</span>
                  {r && <span className={cn("ml-1.5", r.ok ? "text-muted" : "text-err")}>{r.detail}{r.ms ? ` · ${(r.ms / 1000).toFixed(1)}s` : ""}</span>}
                  {running === s.id && s.id === "image" && <span className="ml-1.5 text-muted">rendering, this can take a minute…</span>}
                </div>
              </div>
            );
          })}
          {results.image?.url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={results.image.url} alt="Magnific test" className="mt-2 max-h-56 rounded-lg border border-line" />
          )}
          {needsSignIn && <p className="text-[11px] text-warn">Press Connect Magnific and sign in with your Magnific / Freepik account, then Check again.</p>}
          {results.llm && !results.llm.ok && <p className="text-[11px] text-warn">Add your OpenRouter key in <Link href="/settings" className="underline">Settings</Link>, then Check again.</p>}
          {all && <p className="text-[11px] text-ok">Everything works. Frames and clips will come from Magnific.</p>}
        </div>
      )}
    </div>
  );
}

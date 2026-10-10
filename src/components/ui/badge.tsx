import { cn } from "@/lib/utils";

const tones = {
  neutral: "bg-panel-3 text-muted border-line-2",
  accent: "bg-accent/12 text-accent border-accent/30",
  ok: "bg-ok/10 text-ok border-ok/30",
  warn: "bg-warn/10 text-warn border-warn/30",
  err: "bg-err/10 text-err border-err/30",
  cyan: "bg-cyan/10 text-cyan border-cyan/30",
  violet: "bg-violet/10 text-violet border-violet/30",
};

export function Badge({ tone = "neutral", className, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof tones }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide", tones[tone], className)} {...props} />;
}

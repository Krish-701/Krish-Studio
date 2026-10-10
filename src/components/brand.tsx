import Link from "next/link";
import { Clapperboard } from "lucide-react";

export function Brand({ compact }: { compact?: boolean }) {
  return (
    <Link href="/" className="group flex items-center gap-2.5">
      <div className="relative grid size-8 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent-2 text-black shadow-[0_0_24px_-4px_rgb(245_165_36/0.7)]">
        <Clapperboard className="size-4" strokeWidth={2.5} />
      </div>
      {!compact && (
        <div className="leading-none">
          <div className="font-display text-[15px] font-bold tracking-tight">KRISH<span className="text-accent">STUDIO</span></div>
          <div className="mt-0.5 text-[10px] uppercase tracking-[0.2em] text-dim">AI film production</div>
        </div>
      )}
    </Link>
  );
}

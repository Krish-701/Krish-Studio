"use client";
import * as React from "react";
import * as SwitchP from "@radix-ui/react-switch";
import * as TooltipP from "@radix-ui/react-tooltip";
import * as TabsP from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

export function Switch({ className, ...props }: SwitchP.SwitchProps) {
  return (
    <SwitchP.Root
      className={cn("relative h-5 w-9 shrink-0 cursor-pointer rounded-full border border-line-2 bg-panel-3 transition data-[state=checked]:border-accent/60 data-[state=checked]:bg-accent", className)}
      {...props}
    >
      <SwitchP.Thumb className="block size-4 translate-x-0.5 rounded-full bg-fg shadow transition data-[state=checked]:translate-x-[17px] data-[state=checked]:bg-black" />
    </SwitchP.Root>
  );
}

export function Tip({ children, content, side = "top" }: { children: React.ReactNode; content: React.ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <TooltipP.Provider delayDuration={200}>
      <TooltipP.Root>
        <TooltipP.Trigger asChild>{children}</TooltipP.Trigger>
        <TooltipP.Portal>
          <TooltipP.Content side={side} sideOffset={6} className="z-[60] max-w-xs rounded-md border border-line-2 bg-panel-3 px-2 py-1 text-xs text-fg shadow-xl">
            {content}
          </TooltipP.Content>
        </TooltipP.Portal>
      </TooltipP.Root>
    </TooltipP.Provider>
  );
}

export const Tabs = TabsP.Root;
export function TabsList({ className, ...props }: TabsP.TabsListProps) {
  return <TabsP.List className={cn("flex items-center gap-1 border-b border-line px-2", className)} {...props} />;
}
export function TabsTrigger({ className, ...props }: TabsP.TabsTriggerProps) {
  return (
    <TabsP.Trigger
      className={cn(
        "relative -mb-px flex items-center gap-1.5 border-b-2 border-transparent px-2.5 py-2.5 text-xs font-medium text-muted transition hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg cursor-pointer",
        className,
      )}
      {...props}
    />
  );
}
export const TabsContent = TabsP.Content;

export function Progress({ value, className, tone = "accent" }: { value: number; className?: string; tone?: "accent" | "ok" | "err" | "cyan" }) {
  const color = { accent: "bg-gradient-to-r from-accent to-accent-2", ok: "bg-ok", err: "bg-err", cyan: "bg-cyan" }[tone];
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-panel-3", className)}>
      <div className={cn("h-full rounded-full transition-[width] duration-500", color)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function Empty({ icon, title, children, className }: { icon?: React.ReactNode; title: string; children?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-2xl border border-dashed border-line-2 px-6 py-14 text-center", className)}>
      {icon ? <div className="mb-3 text-dim [&_svg]:size-8">{icon}</div> : null}
      <div className="font-display text-base font-semibold">{title}</div>
      {children ? <div className="mt-1.5 max-w-md text-sm text-muted">{children}</div> : null}
    </div>
  );
}

export function Section({ title, actions, children, className }: { title: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-2xl border border-line bg-panel", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h3 className="font-display text-sm font-semibold tracking-wide">{title}</h3>
        <div className="flex items-center gap-2">{actions}</div>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

"use client";
import * as React from "react";
import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({ className, children, title, description, side, ...props }: D.DialogContentProps & { title?: string; description?: string; side?: "right" }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm data-[state=open]:animate-in" />
      <D.Content
        className={cn(
          "fixed z-50 border border-line-2 bg-panel shadow-2xl outline-none",
          side === "right"
            ? "inset-y-0 right-0 w-full max-w-[min(1100px,100vw)] overflow-y-auto"
            : "left-1/2 top-1/2 max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl",
          className,
        )}
        {...props}
      >
        {title ? (
          <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-panel/95 px-5 py-4 backdrop-blur">
            <div>
              <D.Title className="font-display text-lg font-semibold">{title}</D.Title>
              {description ? <D.Description className="mt-0.5 text-sm text-muted">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
            </div>
            <D.Close className="rounded-md p-1 text-muted hover:bg-panel-3 hover:text-fg">
              <X className="size-4" />
            </D.Close>
          </div>
        ) : (
          <D.Title className="sr-only">Dialog</D.Title>
        )}
        {children}
      </D.Content>
    </D.Portal>
  );
}

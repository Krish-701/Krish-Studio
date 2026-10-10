"use client";
import { toast } from "sonner";

export async function api<T = unknown>(url: string, opts: { method?: string; body?: unknown; form?: FormData; quiet?: boolean } = {}): Promise<T> {
  const res = await fetch(url, {
    method: opts.method ?? (opts.body || opts.form ? "POST" : "GET"),
    headers: opts.form ? undefined : { "Content-Type": "application/json" },
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { error?: string }).error || `Request failed (${res.status})`;
    if (!opts.quiet) toast.error(msg);
    throw new Error(msg);
  }
  return data as T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const fetcher = (url: string) => api<any>(url, { quiet: true });

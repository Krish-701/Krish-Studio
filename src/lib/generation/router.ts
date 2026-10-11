import { getSettings, type Capability, type McpServerConfig } from "../settings";
import { McpToolError } from "../mcp/client";
import { errorMessage } from "../utils";
import { genericMcpProvider } from "./generic-mcp";
import { magnificProvider } from "./magnific";
import { mockProvider } from "./mock";
import type { GenContext, GenerationProvider, GenResult } from "./types";

function build(cfg: McpServerConfig): GenerationProvider {
  if (cfg.kind === "mock") return mockProvider;
  if (cfg.kind === "magnific") return magnificProvider(cfg);
  return genericMcpProvider(cfg);
}

export async function providersFor(cap: Capability, preferId?: string | null) {
  const { mcpServers } = await getSettings();
  let list = mcpServers.filter((s) => s.enabled && s.capabilities.includes(cap)).map(build).filter((p) => p.supports(cap));
  // The offline preview renderer only draws placeholders (solid colours, Ken Burns). It is used only when it's the
  // only backend turned on (offline mode), never as a silent stand-in for Magnific; set PREVIEW_FALLBACK=1 to allow that.
  const real = list.filter((p) => p !== mockProvider);
  if (real.length && process.env.PREVIEW_FALLBACK !== "1") list = real;
  if (preferId) list.sort((a, b) => (a.id === preferId ? -1 : b.id === preferId ? 1 : 0));
  return list;
}

/**
 * Runs a capability against the configured backends in priority order, falling back on failure.
 * Returns the result plus which provider produced it.
 */
export async function generate(
  cap: Capability,
  ctx: GenContext,
  call: (p: GenerationProvider) => Promise<GenResult> | undefined,
  preferId?: string | null,
): Promise<GenResult & { provider: string; providerName: string; fallbackFrom?: string[] }> {
  const providers = await providersFor(cap, preferId);
  if (!providers.length) throw new McpToolError(`No enabled backend supports "${cap}". Enable one in Settings.`, cap, false);
  const errors: string[] = [];
  for (const p of providers) {
    const reason = p.unavailable?.();
    if (reason) {
      errors.push(`${p.name}: ${reason}`);
      continue;
    }
    try {
      const out = call(p);
      if (!out) continue;
      const res = await out;
      return { ...res, provider: p.id, providerName: p.name, ...(errors.length ? { fallbackFrom: errors } : {}) };
    } catch (e) {
      const msg = errorMessage(e);
      errors.push(`${p.name}: ${msg}`);
      console.warn(`[generate:${cap}] ${p.name} failed → trying next backend`, msg);
      await ctx.onProgress(5, `${p.name} failed, falling back…`);
    }
  }
  throw new McpToolError(errors.join(" | "), cap, true);
}

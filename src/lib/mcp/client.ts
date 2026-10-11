import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { McpServerConfig } from "../settings";
import { DbOAuthProvider } from "./oauth";

/**
 * Thin MCP client pool. All generation goes through `callTool` on a configured MCP server.
 */
type Entry = { client: Client; fingerprint: string; tools?: { name: string; description?: string; inputSchema?: unknown }[] };
const g = globalThis as unknown as { __mcpPool?: Map<string, Entry> };
const pool = (g.__mcpPool ??= new Map());

function headers(cfg: McpServerConfig): Record<string, string> {
  if (!cfg.token) return {};
  const h = cfg.authHeader || "Authorization";
  return { [h]: h.toLowerCase() === "authorization" && !/^bearer /i.test(cfg.token) ? `Bearer ${cfg.token}` : cfg.token };
}

/** Magnific MCP accepts the OAuth sign-in, not the REST API key. A saved sign-in wins. */
function preferOAuth(cfg: McpServerConfig) {
  return !!cfg.oauthConnected;
}

async function connect(cfg: McpServerConfig): Promise<Client> {
  const oauth = preferOAuth(cfg);
  const fingerprint = `${cfg.url}|${oauth ? "" : (cfg.token ?? "")}|${cfg.authHeader ?? ""}|${oauth ? "oauth" : ""}`;
  const cached = pool.get(cfg.id);
  if (cached && cached.fingerprint === fingerprint) return cached.client;
  if (cached) await cached.client.close().catch(() => {});

  const url = new URL(cfg.url);
  const requestInit = { headers: oauth ? {} : headers(cfg) };
  // No static token, or a completed sign-in: OAuth refreshes tokens on its own.
  const authProvider = oauth || !cfg.token ? new DbOAuthProvider(cfg.id) : undefined;
  const client = new Client({ name: "film-studio", version: "0.1.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit, authProvider }));
  } catch (e) {
    if (e instanceof UnauthorizedError || /unauthori|401/i.test((e as Error).message)) {
      throw new McpToolError(`${cfg.name} is not signed in. Open Settings and press Connect ${cfg.name}.`, "connect", false);
    }
    // Older servers only speak SSE.
    const legacy = new Client({ name: "film-studio", version: "0.1.0" });
    try {
      await legacy.connect(new SSEClientTransport(url, { requestInit, authProvider }));
    } catch {
      throw e;
    }
    pool.set(cfg.id, { client: legacy, fingerprint });
    return legacy;
  }
  pool.set(cfg.id, { client, fingerprint });
  return client;
}

export class McpToolError extends Error {
  constructor(message: string, public tool: string, public retryable = true) {
    super(message);
  }
}

/** Calls a tool and returns its result as structured data (structuredContent, else parsed text). */
export async function callTool(cfg: McpServerConfig, tool: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<unknown> {
  let client: Client;
  try {
    client = await connect(cfg);
  } catch (e) {
    if (e instanceof McpToolError) throw new McpToolError(e.message, tool, e.retryable);
    throw new McpToolError(`Cannot connect to ${cfg.name} (${cfg.url}): ${(e as Error).message}`, tool);
  }
  let res;
  try {
    res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs });
  } catch (e) {
    pool.delete(cfg.id); // force reconnect next time
    throw new McpToolError(`${cfg.name}.${tool} failed: ${(e as Error).message}`, tool);
  }
  const text = Array.isArray(res.content)
    ? res.content.filter((c: { type: string }) => c.type === "text").map((c: { text?: string }) => c.text ?? "").join("\n")
    : "";
  if (res.isError) {
    const retryable = !/insufficient|credit|balance|invalid|not allowed|unauthori|forbidden|required/i.test(text);
    throw new McpToolError(`${cfg.name}.${tool}: ${text.slice(0, 500)}`, tool, retryable);
  }
  if (res.structuredContent) return res.structuredContent;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export async function listTools(cfg: McpServerConfig) {
  const client = await connect(cfg);
  const out = await client.listTools();
  const entry = pool.get(cfg.id);
  if (entry) entry.tools = out.tools;
  return out.tools;
}

/** Recursively collects values for any of `keys` in an unknown result. */
export function collect(obj: unknown, keys: string[], out: unknown[] = []): unknown[] {
  if (Array.isArray(obj)) obj.forEach((o) => collect(o, keys, out));
  else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (keys.includes(k)) out.push(v);
      collect(v, keys, out);
    }
  }
  return out;
}

/** Extracts media URLs from any result (structured or plain text). */
export function findUrls(obj: unknown, kind?: "image" | "video" | "audio"): string[] {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj);
  const all = s.match(/https?:\/\/[^\s"'\\)<>]+/g) || [];
  const exts = {
    image: /\.(png|jpe?g|webp|gif|avif)(\?|$)/i,
    video: /\.(mp4|webm|mov|m4v)(\?|$)/i,
    audio: /\.(mp3|wav|ogg|m4a|flac|aac)(\?|$)/i,
  };
  const uniq = [...new Set(all)];
  return kind ? uniq.filter((u) => exts[kind].test(u)) : uniq;
}

/**
 * Reads a scalar field from a tool result. Handles structured JSON and Magnific's TOON text
 * ("key: value" lines), returning the first match in document order (top-level fields come first).
 */
export function field(obj: unknown, keys: string[]): string | undefined {
  const structured = collect(obj, keys).find((v) => typeof v === "string" || typeof v === "number");
  if (structured !== undefined) return String(structured);
  const text = typeof obj === "string" ? obj : typeof (obj as { text?: unknown })?.text === "string" ? (obj as { text: string }).text : JSON.stringify(obj);
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*-?\s*([A-Za-z_][\w]*):\s*"?([^"]*?)"?\s*$/);
    if (m && keys.includes(m[1]) && m[2]) return m[2];
  }
  return undefined;
}

/** All values for a key in a result (structured or TOON). */
export function fields(obj: unknown, key: string): string[] {
  const structured = collect(obj, [key]).flat(2).filter((v): v is string => typeof v === "string");
  if (structured.length) return structured;
  const text = typeof (obj as { text?: unknown })?.text === "string" ? (obj as { text: string }).text : typeof obj === "string" ? obj : "";
  return [...text.matchAll(new RegExp(`^\\s*-?\\s*${key}:\\s*"?([^"\\n]+?)"?\\s*$`, "gm"))].map((m) => m[1]);
}

/** Drops a pooled connection (after signing out, or to force a fresh sign-in). */
export async function closeClient(serverId: string) {
  const e = pool.get(serverId);
  pool.delete(serverId);
  await e?.client.close().catch(() => {});
}

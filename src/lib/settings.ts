import { db } from "./db";
import { decryptSecret, encryptSecret, maskSecret } from "./crypto";

export type Capability = "image" | "video" | "tts" | "music" | "sfx" | "upscale" | "inpaint";
export const ALL_CAPABILITIES: Capability[] = ["image", "video", "tts", "music", "sfx", "upscale", "inpaint"];

/**
 * A generation backend. Everything goes through MCP tool calls:
 *  - kind "magnific": https://mcp.magnific.com, with a native adapter for its tool set
 *  - kind "mcp":      any other MCP server (Veo, Kling, MiniMax, Wan, fal, replicate...). Each capability
 *                     maps to a tool name plus a JSON argument template with {{placeholders}}.
 *  - kind "mock":     built-in offline preview renderer (no credits; placeholder frames via ffmpeg)
 */
export interface McpServerConfig {
  id: string;
  name: string;
  kind: "magnific" | "mcp" | "mock";
  url: string;
  token?: string | null;
  /** Header used for the token. Default "Authorization" with "Bearer " prefix. */
  authHeader?: string;
  enabled: boolean;
  capabilities: Capability[];
  /** For kind "mcp": { image: { tool: "generate_image", args: "{\"prompt\":\"{{prompt}}\"}" }, ... } */
  toolMap?: Partial<Record<Capability, { tool: string; args: string; poll?: { tool: string; args: string } }>>;
}

export interface Settings {
  llmBaseUrl: string;
  llmApiKey: string | null;
  llmModel: string;
  agentModels: Record<string, string>;
  autoAgents: boolean;
  mcpServers: McpServerConfig[];
}

export function defaultServers(): McpServerConfig[] {
  return [
    {
      id: "magnific",
      name: "Magnific",
      kind: "magnific",
      url: process.env.MAGNIFIC_MCP_URL || "https://mcp.magnific.com",
      token: process.env.MAGNIFIC_MCP_TOKEN || null,
      enabled: true,
      capabilities: [...ALL_CAPABILITIES],
    },
    {
      id: "preview",
      name: "Offline preview renderer",
      kind: "mock",
      url: "builtin://preview",
      enabled: true,
      capabilities: [...ALL_CAPABILITIES],
    },
  ];
}

export async function getSettings(): Promise<Settings> {
  let row = await db.appSettings.findUnique({ where: { id: "global" } });
  if (!row) {
    row = await db.appSettings.create({
      data: {
        id: "global",
        llmBaseUrl: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
        llmApiKey: encryptSecret(process.env.LLM_API_KEY || null),
        llmModel: process.env.LLM_MODEL || "gpt-4o",
        mcpServers: defaultServers().map((s) => ({ ...s, token: encryptSecret(s.token) })) as never,
      },
    });
  }
  const servers = ((row.mcpServers as unknown as McpServerConfig[]) || []).map((s) => ({
    ...s,
    token: decryptSecret(s.token),
  }));
  return {
    llmBaseUrl: row.llmBaseUrl,
    llmApiKey: decryptSecret(row.llmApiKey),
    llmModel: row.llmModel,
    agentModels: (row.agentModels as Record<string, string>) || {},
    autoAgents: row.autoAgents,
    mcpServers: servers.length ? servers : defaultServers(),
  };
}

/** Settings safe to send to the browser (secrets masked). */
export async function getPublicSettings() {
  const s = await getSettings();
  return {
    ...s,
    llmApiKey: maskSecret(s.llmApiKey),
    hasLlmKey: !!s.llmApiKey,
    mcpServers: s.mcpServers.map((m) => ({ ...m, token: maskSecret(m.token), hasToken: !!m.token })),
  };
}

const MASK_RE = /••••/;

export async function saveSettings(input: Partial<Settings>) {
  const current = await getSettings();
  const data: Record<string, unknown> = {};
  if (input.llmBaseUrl !== undefined) data.llmBaseUrl = input.llmBaseUrl.trim().replace(/\/$/, "");
  if (input.llmModel !== undefined) data.llmModel = input.llmModel.trim();
  if (input.llmApiKey !== undefined && !MASK_RE.test(input.llmApiKey ?? "")) {
    data.llmApiKey = encryptSecret(input.llmApiKey || null);
  }
  if (input.agentModels !== undefined) data.agentModels = input.agentModels;
  if (input.autoAgents !== undefined) data.autoAgents = input.autoAgents;
  if (input.mcpServers !== undefined) {
    data.mcpServers = input.mcpServers.map((s) => {
      // Keep the stored token when the browser sends back the masked value.
      const prev = current.mcpServers.find((p) => p.id === s.id);
      const token = s.token && MASK_RE.test(s.token) ? prev?.token : s.token;
      return { ...s, token: encryptSecret(token || null) };
    });
  }
  await db.appSettings.update({ where: { id: "global" }, data });
  return getPublicSettings();
}

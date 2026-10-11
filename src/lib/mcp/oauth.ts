import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { db } from "../db";
import { decryptSecret, encryptSecret } from "../crypto";
import { noDatabase } from "../runtime";
import type { McpServerConfig } from "../settings";

/**
 * Sign in to an MCP server with OAuth (how Magnific's MCP authenticates): the studio registers itself
 * as a client, sends you to the provider's sign-in page, and stores the tokens (encrypted) in the
 * database. Tokens refresh on their own; no access token needs to be copied anywhere.
 */
interface Stored {
  client?: OAuthClientInformationMixed;
  tokens?: string; // encrypted JSON
  verifier?: string;
  state?: string;
  connectedAt?: string;
}

const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
export const callbackUrl = () => `${appUrl()}/api/mcp/oauth/callback`;

const authFile = () => path.join(process.cwd(), "data", "mcp-auth.json");

async function load(): Promise<Record<string, Stored>> {
  if (noDatabase()) {
    try {
      return JSON.parse(await fs.readFile(authFile(), "utf8")) as Record<string, Stored>;
    } catch {
      return {};
    }
  }
  const row = await db.appSettings.findUnique({ where: { id: "global" }, select: { mcpAuth: true } });
  return (row?.mcpAuth as Record<string, Stored> | null) ?? {};
}

async function patch(serverId: string, p: Partial<Stored> | null) {
  const all = await load();
  if (p === null) delete all[serverId];
  else all[serverId] = { ...all[serverId], ...p };
  if (noDatabase()) {
    await fs.mkdir(path.dirname(authFile()), { recursive: true });
    await fs.writeFile(authFile(), JSON.stringify(all));
    return;
  }
  await db.appSettings.update({ where: { id: "global" }, data: { mcpAuth: all as never } });
}

export class DbOAuthProvider implements OAuthClientProvider {
  /** Set when the server asks the user to sign in; the API hands it to the browser. */
  authorizationUrl: URL | null = null;
  constructor(private serverId: string) {}

  get redirectUrl() {
    return callbackUrl();
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Krish Studio",
      redirect_uris: [callbackUrl()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  async state() {
    const s = `${this.serverId}.${randomBytes(12).toString("hex")}`;
    await patch(this.serverId, { state: s });
    return s;
  }
  async clientInformation() {
    return (await load())[this.serverId]?.client;
  }
  async saveClientInformation(info: OAuthClientInformationMixed) {
    await patch(this.serverId, { client: info });
  }
  async tokens(): Promise<OAuthTokens | undefined> {
    const raw = decryptSecret((await load())[this.serverId]?.tokens ?? null);
    return raw ? (JSON.parse(raw) as OAuthTokens) : undefined;
  }
  async saveTokens(tokens: OAuthTokens) {
    await patch(this.serverId, { tokens: encryptSecret(JSON.stringify(tokens)) ?? undefined, connectedAt: new Date().toISOString() });
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  async saveCodeVerifier(v: string) {
    await patch(this.serverId, { verifier: v });
  }
  async codeVerifier() {
    const v = (await load())[this.serverId]?.verifier;
    if (!v) throw new Error("Sign-in expired. Press Connect again.");
    return v;
  }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all") return patch(this.serverId, null);
    if (scope === "client") return patch(this.serverId, { client: undefined });
    if (scope === "tokens") return patch(this.serverId, { tokens: undefined });
    if (scope === "verifier") return patch(this.serverId, { verifier: undefined });
  }
}

export async function oauthStatus(serverId: string) {
  const s = (await load())[serverId];
  return { connected: !!s?.tokens, connectedAt: s?.connectedAt ?? null };
}

/** Starts sign-in. Returns the provider's sign-in URL, or null when the stored tokens already work. */
export async function startOAuth(cfg: McpServerConfig): Promise<string | null> {
  // Connect / Reconnect always signs in fresh: stored tokens may have been revoked on the provider's side.
  await patch(cfg.id, { tokens: undefined });
  const p = new DbOAuthProvider(cfg.id);
  const r = await auth(p, { serverUrl: cfg.url });
  if (r === "AUTHORIZED") return null;
  if (!p.authorizationUrl) throw new Error(`${cfg.name} did not return a sign-in page.`);
  return p.authorizationUrl.toString();
}

/** Finishes sign-in from the provider's redirect (state = "<serverId>.<nonce>"). */
export async function finishOAuth(servers: McpServerConfig[], code: string, state: string) {
  const serverId = state.split(".")[0];
  const cfg = servers.find((s) => s.id === serverId);
  if (!cfg) throw new Error("Unknown backend in sign-in response.");
  const stored = (await load())[serverId];
  if (stored?.state && stored.state !== state) throw new Error("Sign-in response did not match. Press Connect again.");
  const r = await auth(new DbOAuthProvider(serverId), { serverUrl: cfg.url, authorizationCode: code });
  if (r !== "AUTHORIZED") throw new Error("Sign-in was not completed.");
  return cfg;
}

export async function disconnectOAuth(serverId: string) {
  await patch(serverId, null);
}

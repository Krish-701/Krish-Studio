import { fail, ok, route } from "@/lib/api";
import { startOAuth } from "@/lib/mcp/oauth";
import { getSettings } from "@/lib/settings";

/** POST { serverId } → { url } to open for sign-in, or { connected: true } when already signed in. */
export const POST = route(async (req: Request) => {
  const { serverId = "magnific" } = await req.json().catch(() => ({}));
  const cfg = (await getSettings()).mcpServers.find((s) => s.id === serverId);
  if (!cfg) return fail("Unknown backend", 404);
  const url = await startOAuth(cfg);
  return ok(url ? { url } : { connected: true });
});

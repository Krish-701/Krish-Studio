import { ok, route } from "@/lib/api";
import { disconnectOAuth } from "@/lib/mcp/oauth";
import { closeClient } from "@/lib/mcp/client";

export const POST = route(async (req: Request) => {
  const { serverId = "magnific" } = await req.json().catch(() => ({}));
  await disconnectOAuth(serverId);
  await closeClient(serverId);
  return ok({ ok: true });
});

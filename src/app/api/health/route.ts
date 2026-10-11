import { db } from "@/lib/db";
import { ok } from "@/lib/api";
import { isLlmConfigured } from "@/lib/llm";
import { getSettings } from "@/lib/settings";

export async function GET() {
  const s = await getSettings();
  await db.$queryRaw`SELECT 1`;
  return ok({
    ok: true,
    llm: await isLlmConfigured(),
    magnific: !!s.mcpServers.find((m) => m.kind === "magnific" && m.enabled && (m.token || m.oauthConnected)),
    queue: process.env.REDIS_URL ? "bullmq" : "in-process",
  });
}

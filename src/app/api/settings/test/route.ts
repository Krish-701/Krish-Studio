import { ok, route } from "@/lib/api";
import { testLlm, validateLlm } from "@/lib/llm";
import { listTools } from "@/lib/mcp/client";
import { getSettings } from "@/lib/settings";
import { errorMessage } from "@/lib/utils";

/** POST { target: "llm" | "validate" } or { target: "mcp", serverId } — checks a connection or validates the model's capabilities. */
export const POST = route(async (req: Request) => {
  const b = await req.json();
  try {
    if (b.target === "validate") {
      const { caps, checks } = await validateLlm();
      const passed = checks.filter((c) => c.ok).length;
      return ok({ ok: checks.find((c) => c.id === "connect")?.ok ?? false, detail: `${passed}/${checks.length} checks passed`, caps, checks });
    }
    if (b.target === "llm") {
      const reply = await testLlm();
      return ok({ ok: true, detail: `Model replied: “${reply.slice(0, 60)}”` });
    }
    const s = await getSettings();
    const server = s.mcpServers.find((m) => m.id === b.serverId);
    if (!server) return ok({ ok: false, detail: "Unknown server" });
    if (server.kind === "mock") return ok({ ok: true, detail: "Built-in renderer is always available." });
    const tools = await listTools(server);
    return ok({ ok: true, detail: `Connected · ${tools.length} tools`, tools: tools.map((t) => t.name) });
  } catch (e) {
    return ok({ ok: false, detail: errorMessage(e) });
  }
});

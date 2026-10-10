import { fail, ok, route, type Params } from "@/lib/api";
import { getAutopilot, pauseAutopilot, startAutopilot, STAGES, type Stage } from "@/worker/autopilot";

export const GET = route(async (_: Request, { params }: Params<"id">) => {
  const { id } = await params;
  return ok({ state: await getAutopilot(id), stages: STAGES });
});

/** { action: "start" | "pause", force?, from? } */
export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  if (b.action === "pause") return ok({ state: await pauseAutopilot(id) });
  if (b.action === "start") {
    const from = STAGES.includes(b.from) ? (b.from as Stage) : undefined;
    return ok({ state: (await startAutopilot(id, { force: !!b.force, from })).state });
  }
  return fail("action must be start or pause");
});

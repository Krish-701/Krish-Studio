import { ok, route, type Params } from "@/lib/api";
import { maybeSummarize } from "@/lib/agents/summary";

export const maxDuration = 120;

/** POST — have the Director post a progress summary now. */
export const POST = route(async (_: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const text = await maybeSummarize(id, { force: true });
  return ok({ summary: text });
});

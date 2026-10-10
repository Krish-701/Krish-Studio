import { ok, route, type Params } from "@/lib/api";
import { retryFailed } from "@/lib/services";

/** POST { action: "retry-failed" } */
export const POST = route(async (_: Request, { params }: Params<"id">) => {
  const { id } = await params;
  return ok({ retried: await retryFailed(id) });
});

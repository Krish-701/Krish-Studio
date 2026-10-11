import { ok, route, type Params } from "@/lib/api";
import { buildAssetLibrary } from "@/lib/services";

/**
 * Asset library build: queues design sheets for every character, background, environment, prop and the
 * colour & mood board. { missingOnly: false } redraws everything; default only fills the gaps.
 */
export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  return ok(await buildAssetLibrary(id, { missingOnly: b?.missingOnly !== false, model: b?.model }));
});

import { fail, ok, route, type Params } from "@/lib/api";
import { queueDesignSheet } from "@/lib/services";

/**
 * AI design sheets.
 * { characterId, kind: "turnaround" }            front / three-quarter / side / back sheet, cut into angle references
 * { characterId, kind: "wardrobe", look, lookDescription }  a named outfit, picked per shot
 * { elementId, kind: "plate" }                   film set plates (4 views) or a prop sheet
 */
export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const b = await req.json();
  if (!b.characterId && !b.elementId) return fail("characterId or elementId required");
  if (b.kind === "wardrobe" && !b.look) return fail("Name the look");
  const job = await queueDesignSheet(id, { characterId: b.characterId, elementId: b.elementId, kind: b.kind, look: b.look, lookDescription: b.lookDescription, model: b.model });
  return ok({ jobId: job.id });
});

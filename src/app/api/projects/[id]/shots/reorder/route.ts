import { ok, route, type Params } from "@/lib/api";
import { reorderShots } from "@/lib/services";

export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const { shotIds } = await req.json();
  await reorderShots(id, shotIds);
  return ok({ ok: true });
});

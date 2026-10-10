import { ok, route, type Params } from "@/lib/api";
import { createShot } from "@/lib/services";

export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const b = await req.json();
  return ok(await createShot(id, { title: b.title || "New shot", ...b }), 201);
});

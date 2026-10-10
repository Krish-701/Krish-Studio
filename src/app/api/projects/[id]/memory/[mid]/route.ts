import { ok, route, type Params } from "@/lib/api";
import { deleteMemory, updateMemoryById } from "@/lib/memory";

export const PATCH = route(async (req: Request, { params }: Params<"id" | "mid">) => {
  const { id, mid } = await params;
  return ok(await updateMemoryById(id, mid, await req.json(), "USER"));
});

export const DELETE = route(async (_: Request, { params }: Params<"id" | "mid">) => {
  const { id, mid } = await params;
  return ok({ deleted: await deleteMemory(id, mid) });
});

import { fail, ok, route, type Params } from "@/lib/api";
import { queueMusic, queueSfx } from "@/lib/services";

export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const b = await req.json();
  if (!b.prompt) return fail("Describe the sound");
  if (b.kind === "music") return ok(await queueMusic(id, b.prompt, Number(b.durationSec) || 30, Number(b.start) || 0));
  if (b.kind === "sfx") return ok(await queueSfx(id, b.prompt, Number(b.durationSec) || 3, Number(b.start) || 0));
  return fail("kind must be music or sfx");
});

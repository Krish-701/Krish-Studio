import { ok, route, type Params } from "@/lib/api";
import { writeFilm, writeSequences } from "@/lib/services";

/**
 * Long-form writing.
 * { what: "film" }       outline + every sequence (Write my film)
 * { what: "outline" }    acts and sequences only, to review before boarding
 * { what: "sequences", sequenceIds? }  board the given (or all unwritten) sequences
 */
export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  if (b.what === "sequences") return ok({ jobs: (await writeSequences(id, b.sequenceIds)).length });
  const job = await writeFilm(id, b.what !== "outline");
  return ok({ jobId: job.id });
});

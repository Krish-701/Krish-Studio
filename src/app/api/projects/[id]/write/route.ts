import { fail, ok, route, type Params } from "@/lib/api";
import { db } from "@/lib/db";
import { SCORE_BLOCK } from "@/lib/script/score";
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
  // Story gate: a story the Script Doctor scored under 6/10 has to change before it is written.
  const p = await db.project.findUniqueOrThrow({ where: { id }, select: { storyScore: true } });
  const sc = p.storyScore as { score?: number; method?: string } | null;
  if (!b.force && sc?.method === "ai" && (sc.score ?? 10) < SCORE_BLOCK) return fail(`Your story scores ${sc.score?.toFixed(1)}/10. Change it or let the Script Doctor improve it before writing.`, 409);
  if (b.what === "sequences") return ok({ jobs: (await writeSequences(id, b.sequenceIds)).length });
  const job = await writeFilm(id, b.what !== "outline");
  return ok({ jobId: job.id });
});

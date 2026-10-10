import { db } from "@/lib/db";
import { ok, route, type Params } from "@/lib/api";
import { enqueue } from "@/lib/queue";
import { SCORE_BLOCK, SCORE_READY } from "@/lib/script/score";

export const GET = route(async (_: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const p = await db.project.findUniqueOrThrow({ where: { id }, select: { storyScore: true } });
  return ok({ score: p.storyScore, block: SCORE_BLOCK, ready: SCORE_READY });
});

/** { improve?: boolean, target?: number } → Script Doctor scores (or improves to 8.5+) as a job. */
export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  const job = await enqueue({ projectId: id, type: "STORY_SCORE", input: { improve: !!b.improve, target: b.target ?? SCORE_READY }, maxAttempts: 1 });
  return ok({ jobId: job.id });
});

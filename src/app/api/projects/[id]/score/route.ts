import { db } from "@/lib/db";
import { ok, route, type Params } from "@/lib/api";
import { enqueue } from "@/lib/queue";
import { SCORE_BLOCK, SCORE_GO, SCORE_READY, useStoryVersion } from "@/lib/script/score";
import { startAutopilot } from "@/worker/autopilot";

export const GET = route(async (_: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const p = await db.project.findUniqueOrThrow({ where: { id }, select: { storyScore: true } });
  return ok({ score: p.storyScore, block: SCORE_BLOCK, go: SCORE_GO, ready: SCORE_READY });
});

/** { improve?: boolean } scores again. { useHistory: number } keeps that version and writes the script. */
export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  if (Number.isInteger(b.useHistory)) {
    const score = await useStoryVersion(id, b.useHistory);
    const started = await startAutopilot(id, { from: "write", force: true });
    return ok({ score, state: started.state });
  }
  const job = await enqueue({ projectId: id, type: "STORY_SCORE", input: { improve: !!b.improve, target: b.target ?? SCORE_READY }, maxAttempts: 1 });
  return ok({ jobId: job.id });
});

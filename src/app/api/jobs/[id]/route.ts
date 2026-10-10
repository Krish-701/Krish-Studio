import { db } from "@/lib/db";
import { fail, ok, route, type Params } from "@/lib/api";
import { cancelJob, retryFailed } from "@/lib/services";

export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const { action } = await req.json();
  const job = await db.job.findUniqueOrThrow({ where: { id } });
  if (action === "retry") return ok({ retried: await retryFailed(job.projectId, [id]) });
  if (action === "cancel") {
    await cancelJob(id);
    return ok({ ok: true });
  }
  return fail("Unknown action");
});

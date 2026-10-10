import { db } from "@/lib/db";
import { ok, route, type Params } from "@/lib/api";
import { publish } from "@/lib/events";
import { queueImages } from "@/lib/services";

/** PATCH { action: "resolve" | "apply" } — apply runs the finding's fix (e.g. corrected prompt + regenerate). */
export const PATCH = route(async (req: Request, { params }: Params<"id" | "fid">) => {
  const { id, fid } = await params;
  const { action } = await req.json();
  const f = await db.agentFinding.update({ where: { id: fid }, data: { resolved: true } });
  const fix = f.fix as { action?: string; prompt?: string } | null;
  if (action === "apply" && f.shotId && fix?.action === "regenerate_image") {
    if (fix.prompt) await db.shot.update({ where: { id: f.shotId }, data: { prompt: fix.prompt } });
    await queueImages(id, [f.shotId]);
  }
  publish(id, { type: "refresh", scope: "all" });
  return ok({ ok: true });
});

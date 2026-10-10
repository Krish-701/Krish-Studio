import { ok, route, type Params } from "@/lib/api";
import { buildImageRequest, buildVideoRequest } from "@/lib/prompt-builder";
import { describePlan } from "@/lib/references";
import { imageModel, videoModel } from "@/lib/generation/catalog";

/** Preview what a generation will send: the prompt, the start/end frames and every reference, before spending credits. */
export const GET = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const q = new URL(req.url).searchParams;
  const kind = q.get("kind") === "image" ? "image" : "video";
  const model = q.get("model") || undefined;
  if (kind === "image") {
    const { req: r, plan } = await buildImageRequest(id, { model });
    return ok({ kind, model: imageModel(r.model)?.name ?? r.model ?? "Auto", prompt: r.prompt, plan, summary: describePlan(plan), refs: r.references ?? [] });
  }
  const r = await buildVideoRequest(id, q.get("mode") || undefined, { model });
  return ok({ kind, model: videoModel(r.model)?.name ?? r.model ?? "Auto", prompt: r.prompt, durationSec: r.durationSec, plan: r.plan, summary: describePlan(r.plan), refs: r.references ?? [], start: r.startFrame ?? null, end: r.endFrame ?? null });
});

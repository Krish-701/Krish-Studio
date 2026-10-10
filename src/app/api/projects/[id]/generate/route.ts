import { fail, ok, route, type Params } from "@/lib/api";
import { enqueue } from "@/lib/queue";
import { queueContactSheets, queueImages, queueMultishot, queueVideos, queueVoiceover, shotsInScope } from "@/lib/services";

/**
 * Generate frames / clips / voiceover / upscale / inpaint for shots.
 * Scope: shotIds[], or sceneId / sequenceId / act, with scope "all" or "missing" (default).
 * kinds: image, contact_sheet (scene grids), video (mode auto|frame|reference|text), multishot (scene clips), voice, upscale, inpaint.
 */
export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const b = await req.json();
  const scoped = b.sceneId || b.sequenceId || b.act;
  const missing = b.scope === "all" ? undefined : b.kind === "video" || b.kind === "multishot" ? ("video" as const) : ("image" as const);
  const target = b.shotIds?.length ? b.shotIds : scoped ? (await shotsInScope(id, { sceneId: b.sceneId, sequenceId: b.sequenceId, act: b.act, missing })).map((s) => s.id) : b.scope === "all" ? "all" : "missing";
  switch (b.kind) {
    case "image":
      return ok({ jobs: (await queueImages(id, target, { model: b.model })).length });
    case "contact_sheet":
      return ok({ jobs: (await queueContactSheets(id, { shotIds: Array.isArray(target) ? target : undefined, missing: target === "missing" ? "image" : undefined, model: b.model })).length });
    case "video":
      return ok({ jobs: (await queueVideos(id, target, b.mode, { model: b.model })).length });
    case "multishot":
      return ok({ jobs: (await queueMultishot(id, { shotIds: Array.isArray(target) ? target : undefined, missing: target === "missing" ? "video" : undefined, model: b.model })).length });
    case "voice": {
      let n = 0;
      for (const s of b.shotIds ?? []) await queueVoiceover(id, s, b.text).then(() => n++);
      return ok({ jobs: n });
    }
    case "upscale":
      return ok(await enqueue({ projectId: id, type: "UPSCALE", shotId: b.shotId, input: { assetId: b.assetId, scale: b.scale ?? "2x" } }));
    case "inpaint":
      return ok(await enqueue({ projectId: id, type: "INPAINT", shotId: b.shotId, input: { assetId: b.assetId, maskAssetId: b.maskAssetId, prompt: b.prompt } }));
    default:
      return fail("Unknown kind");
  }
});

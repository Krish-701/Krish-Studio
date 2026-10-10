import { fail, ok, route, type Params } from "@/lib/api";
import { enqueue } from "@/lib/queue";
import { queueImages, queueVideos, queueVoiceover } from "@/lib/services";

/** Generate frames / clips / voiceover / upscale / inpaint for shots. */
export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const b = await req.json();
  const target = b.shotIds?.length ? b.shotIds : b.scope === "all" ? "all" : "missing";
  switch (b.kind) {
    case "image":
      return ok({ jobs: (await queueImages(id, target, { model: b.model })).length });
    case "video":
      return ok({ jobs: (await queueVideos(id, target, b.mode === "t2v" ? "t2v" : "i2v", { model: b.model })).length });
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

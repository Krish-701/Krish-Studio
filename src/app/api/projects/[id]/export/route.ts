import { fail, ok, route, type Params } from "@/lib/api";
import { enqueue } from "@/lib/queue";

export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const { type, includeMedia } = await req.json();
  if (type === "mp4") return ok(await enqueue({ projectId: id, type: "EXPORT_MP4", maxAttempts: 1 }));
  if (type === "pdf") return ok(await enqueue({ projectId: id, type: "EXPORT_PDF", maxAttempts: 1 }));
  // Editor hand-off: FCPXML + EDL timeline, production log and the media (or a download script).
  if (type === "package") return ok(await enqueue({ projectId: id, type: "EXPORT_PACKAGE", input: { includeMedia }, maxAttempts: 1 }));
  return fail("type must be mp4, pdf or package");
});

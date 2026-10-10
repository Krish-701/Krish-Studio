import { ok, route, type Params } from "@/lib/api";
import { writeWorkspace } from "@/lib/workspace";

/** Refreshes the project's workspace folder (project.json, story.md, memory.md, activity.log) and returns its path. */
export const POST = route(async (_: Request, { params }: Params<"id">) => {
  const { id } = await params;
  return ok({ path: await writeWorkspace(id) });
});

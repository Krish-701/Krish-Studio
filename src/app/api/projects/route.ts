import { ALT_VIDEO_MODEL, DEFAULT_IMAGE_MODEL, DEFAULT_IMAGE_VARIANT, DEFAULT_RESOLUTION, DEFAULT_VIDEO_MODEL } from "@/lib/generation/catalog";
import { db } from "@/lib/db";
import { writeWorkspace } from "@/lib/workspace";
import { ok, route } from "@/lib/api";

export const GET = route(async () => {
  const projects = await db.project.findMany({
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { shots: true, characters: true } } },
  });
  // Cover image: first generated frame.
  const covers = await db.asset.findMany({
    where: { projectId: { in: projects.map((p) => p.id) }, role: "SHOT_IMAGE" },
    orderBy: { createdAt: "asc" },
    distinct: ["projectId"],
    select: { projectId: true, url: true },
  });
  const cover = new Map(covers.map((c) => [c.projectId, c.url]));
  return ok(projects.map((p) => ({ ...p, scriptText: undefined, coverUrl: cover.get(p.id) ?? null })));
});

export const POST = route(async (req: Request) => {
  const body = await req.json();
  const p = await db.project.create({
    data: {
      title: String(body.title || "Untitled film").slice(0, 120),
      logline: body.logline || null,
      aspectRatio: body.aspectRatio || "16:9",
      format: body.format || "short",
      targetRuntimeSec: Math.min(10800, Math.max(15, Number(body.targetRuntimeSec) || 60)),
      resolution: body.resolution || DEFAULT_RESOLUTION,
      language: body.language || "English",
      synopsis: body.synopsis || null,
      // Films started from the wizard stay in setup until "Write my film".
      setupDone: !body.wizard,
      defaults: { image: DEFAULT_IMAGE_MODEL, imageVariant: DEFAULT_IMAGE_VARIANT, video: DEFAULT_VIDEO_MODEL, videoAlt: ALT_VIDEO_MODEL },
    },
  });
  writeWorkspace(p.id).catch(() => {});
  return ok(p, 201);
});

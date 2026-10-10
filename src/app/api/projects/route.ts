import { db } from "@/lib/db";
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
      defaults: { image: "seedream-5-pro", video: "bytedance-seedance-pro-2.5" },
    },
  });
  return ok(p, 201);
});

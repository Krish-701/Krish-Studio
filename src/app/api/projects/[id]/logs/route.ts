import { db } from "@/lib/db";
import { ok, route, type Params } from "@/lib/api";
import { toLogEntry } from "@/lib/activity";

/**
 * GET ?before=<iso>&kind=job,agent|errors&level=&limit=200 — activity log, newest first.
 * kind=errors returns every entry with level "error".
 */
export const GET = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const u = new URL(req.url);
  const before = u.searchParams.get("before");
  const kinds = (u.searchParams.get("kind") ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  const errors = kinds.includes("errors");
  const level = u.searchParams.get("level") || (errors ? "error" : null);
  const limit = Math.min(1000, Math.max(1, Number(u.searchParams.get("limit")) || 200));
  const kindList = kinds.filter((k) => k !== "errors" && k !== "all");
  const rows = await db.activityLog.findMany({
    where: {
      projectId: id,
      ...(before && !isNaN(Date.parse(before)) ? { createdAt: { lt: new Date(before) } } : {}),
      ...(kindList.length ? { kind: { in: kindList } } : {}),
      ...(level ? { level } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
  return ok(rows.map(toLogEntry));
});

/** DELETE — clear the project's activity log. */
export const DELETE = route(async (_: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const { count } = await db.activityLog.deleteMany({ where: { projectId: id } });
  return ok({ deleted: count });
});

import { db } from "@/lib/db";
import { fail, ok, route, type Params } from "@/lib/api";
import { publish } from "@/lib/events";
import { handleOf } from "@/lib/script/writer";

const COLORS = ["#64748b", "#0ea5e9", "#22c55e", "#eab308", "#f97316", "#a855f7", "#ec4899", "#14b8a6"];

/** Film sets (locations) and props, with their reference images. */
export const GET = route(async (_: Request, { params }: Params<"id">) => {
  const { id } = await params;
  return ok(await db.element.findMany({ where: { projectId: id }, orderBy: [{ kind: "asc" }, { createdAt: "asc" }], include: { references: { orderBy: { createdAt: "asc" } } } }));
});

export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const b = await req.json();
  const kind = b.kind === "prop" ? "prop" : "location";
  const name = String(b.name || "").trim();
  if (!name) return fail("Name required");
  const n = await db.element.count({ where: { projectId: id } });
  const el = await db.element.create({
    data: { projectId: id, kind, name, description: b.description ?? "", handle: handleOf(name), locked: b.locked ?? true, color: COLORS[n % COLORS.length] },
  });
  publish(id, { type: "refresh", scope: "characters" });
  return ok(el, 201);
});

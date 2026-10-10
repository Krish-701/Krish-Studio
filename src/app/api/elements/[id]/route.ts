import { db } from "@/lib/db";
import { ok, route, type Params } from "@/lib/api";
import { publish } from "@/lib/events";

const FIELDS = ["name", "description", "locked", "color", "handle", "kind"];

export const PATCH = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const b = await req.json();
  const data = Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));
  const el = await db.element.update({ where: { id }, data });
  publish(el.projectId, { type: "refresh", scope: "characters" });
  return ok(el);
});

export const DELETE = route(async (_: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const el = await db.element.findUniqueOrThrow({ where: { id } });
  await db.scene.updateMany({ where: { locationId: id }, data: { locationId: null } });
  await db.asset.updateMany({ where: { elementId: id }, data: { elementId: null } });
  await db.element.delete({ where: { id } });
  publish(el.projectId, { type: "refresh", scope: "characters" });
  return ok({ ok: true });
});

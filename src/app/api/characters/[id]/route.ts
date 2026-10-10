import { db } from "@/lib/db";
import { ok, route, type Params } from "@/lib/api";
import { publish } from "@/lib/events";

export const PATCH = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const b = await req.json();
  const data = Object.fromEntries(Object.entries(b).filter(([k]) => ["name", "description", "locked", "voiceId", "color", "role", "age", "gender", "handle"].includes(k)));
  const c = await db.character.update({ where: { id }, data });
  publish(c.projectId, { type: "refresh", scope: "characters" });
  return ok(c);
});

export const DELETE = route(async (_: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const c = await db.character.delete({ where: { id } });
  publish(c.projectId, { type: "refresh", scope: "characters" });
  return ok({ ok: true });
});

import { db } from "@/lib/db";
import { ok, route, type Params } from "@/lib/api";
import { publish } from "@/lib/events";

const FIELDS = ["title", "summary", "color", "act", "targetDurationSec"];

export const PATCH = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const b = await req.json();
  const data = Object.fromEntries(Object.entries(b).filter(([k]) => FIELDS.includes(k)));
  const seq = await db.sequence.update({ where: { id }, data });
  publish(seq.projectId, { type: "refresh", scope: "shots" });
  return ok(seq);
});

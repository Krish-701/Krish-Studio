import { db } from "@/lib/db";
import { ok, route, type Params } from "@/lib/api";
import { publish } from "@/lib/events";

const PALETTE = ["#f59e0b", "#22d3ee", "#a78bfa", "#f472b6", "#34d399", "#fb7185", "#60a5fa", "#facc15"];

export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const b = await req.json();
  const count = await db.character.count({ where: { projectId: id } });
  const c = await db.character.create({
    data: { projectId: id, name: String(b.name || "New character").trim(), description: b.description ?? "", color: PALETTE[count % PALETTE.length] },
  });
  publish(id, { type: "refresh", scope: "characters" });
  return ok(c, 201);
});

import path from "path";
import { promises as fs } from "fs";
import { clearExportCache } from "@/lib/export/mp4";
import { localRoot, storageDriver } from "@/lib/storage";
import { db } from "@/lib/db";
import { ok, route, type Params } from "@/lib/api";
import { publish } from "@/lib/events";
import { projectState } from "@/lib/project-state";

export const GET = route(async (_: Request, { params }: Params<"id">) => {
  const { id } = await params;
  return ok(await projectState(id));
});

export const PATCH = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const b = await req.json();
  const allowed = ["title", "logline", "stage", "aspectRatio", "styleLock", "defaults", "scriptText", "format", "targetRuntimeSec", "resolution", "fps", "language", "synopsis", "setupDone", "wizardStep", "brief"];
  const data = Object.fromEntries(Object.entries(b).filter(([k]) => allowed.includes(k)));
  const p = await db.project.update({ where: { id }, data });
  publish(id, { type: "refresh", scope: "project" });
  return ok(p);
});

export const DELETE = route(async (_: Request, { params }: Params<"id">) => {
  const { id } = await params;
  await db.project.delete({ where: { id } });
  // Free disk: export cache always; media too when stored locally (S3 objects are left to bucket lifecycle rules).
  await clearExportCache(id).catch(() => {});
  if (storageDriver === "local") await fs.rm(path.join(localRoot, id), { recursive: true, force: true }).catch(() => {});
  return ok({ ok: true });
});

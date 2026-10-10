import { db } from "@/lib/db";
import { fail, ok, route } from "@/lib/api";
import { getSettings } from "@/lib/settings";
import { COLOR_PRESETS, FORMATS, LOOKS, MOTION_TEMPLATES, CAMERA_MOTIONS, imageModels, setLiveCatalog, videoModels } from "@/lib/generation/catalog";
import { syncMagnificCatalog } from "@/lib/generation/magnific";

/** Model catalog plus the creative presets the UI offers (looks, colour grades, motion templates, film formats). */
export const GET = route(async () => {
  const row = await db.appSettings.findUnique({ where: { id: "global" }, select: { modelCatalog: true, updatedAt: true } });
  await getSettings(); // loads the synced catalog
  return ok({
    image: imageModels(),
    video: videoModels(),
    synced: !!row?.modelCatalog,
    syncedAt: (row?.modelCatalog as { syncedAt?: string } | null)?.syncedAt ?? null,
    looks: LOOKS,
    colorPresets: COLOR_PRESETS,
    motionTemplates: MOTION_TEMPLATES,
    cameraMotions: CAMERA_MOTIONS,
    formats: FORMATS,
  });
});

/** Pull the live model list (with reference limits) from the Magnific MCP server. */
export const POST = route(async () => {
  const s = await getSettings();
  const server = s.mcpServers.find((m) => m.kind === "magnific" && m.enabled && m.token);
  if (!server) return fail("Connect Magnific in Settings first (it needs a token).");
  const cat = await syncMagnificCatalog(server);
  const stored = { ...cat, syncedAt: new Date().toISOString() };
  await db.appSettings.update({ where: { id: "global" }, data: { modelCatalog: stored as never } });
  setLiveCatalog(cat);
  return ok({ image: cat.image.length, video: cat.video.length, syncedAt: stored.syncedAt });
});

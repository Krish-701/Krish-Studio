import { ok, route } from "@/lib/api";
import { getPublicSettings, saveSettings } from "@/lib/settings";

export const GET = route(async () => ok(await getPublicSettings()));
export const PUT = route(async (req: Request) => ok(await saveSettings(await req.json())));

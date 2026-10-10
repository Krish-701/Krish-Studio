import { db } from "@/lib/db";
import { fail, ok, route, type Params } from "@/lib/api";
import { publish } from "@/lib/events";
import { storeFromUrl } from "@/lib/storage";
import type { StyleLock } from "@/lib/prompt-builder";

function meta(html: string, name: string) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, "i");
  const m = html.match(re);
  return m ? (m[1] ?? m[2])?.trim() : undefined;
}

/** Paste a website link as a style reference: stores title/description and pulls its preview image as a style image. */
export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const { url } = await req.json();
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error();
  } catch {
    return fail("Enter a valid http(s) URL");
  }
  let title = parsed.hostname, description = "", image: string | undefined, themeColor: string | undefined;
  try {
    const res = await fetch(parsed, { signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "Mozilla/5.0 FilmStudio/1.0" } });
    const html = (await res.text()).slice(0, 400_000);
    title = meta(html, "og:title") || html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || title;
    description = meta(html, "og:description") || meta(html, "description") || "";
    image = meta(html, "og:image") || meta(html, "twitter:image");
    themeColor = meta(html, "theme-color");
    if (image) image = new URL(image, parsed).toString();
  } catch (e) {
    console.warn("link fetch failed", (e as Error).message);
  }
  const link = await db.asset.create({
    data: { projectId: id, kind: "LINK", role: "STYLE_REF", name: title.slice(0, 200), url: parsed.toString(), meta: { description, image, themeColor } },
  });
  let still = null;
  if (image) {
    try {
      const s = await storeFromUrl(id, "style_ref", image);
      if (s.mime.startsWith("image/")) {
        still = await db.asset.create({ data: { projectId: id, kind: "IMAGE", role: "STYLE_REF", name: `${title.slice(0, 80)} (preview)`, storageKey: s.key, url: s.url, mimeType: s.mime, meta: { fromLink: link.id } } });
        const p = await db.project.findUniqueOrThrow({ where: { id } });
        const lock = (p.styleLock as StyleLock) || {};
        await db.project.update({ where: { id }, data: { styleLock: { ...lock, referenceAssetIds: [...(lock.referenceAssetIds ?? []), still.id], enabled: lock.enabled ?? true } } });
      }
    } catch {}
  }
  publish(id, { type: "refresh", scope: "assets" });
  publish(id, { type: "refresh", scope: "project" });
  return ok({ link, still }, 201);
});

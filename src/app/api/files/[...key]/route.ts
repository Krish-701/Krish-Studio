import { createReadStream, promises as fs } from "fs";
import path from "path";
import { Readable } from "stream";
import { getFile, localRoot, mimeFor, storageDriver } from "@/lib/storage";

/** Serves locally stored media with HTTP range support (needed for video scrubbing). */
export async function GET(req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const { key } = await params;
  const rel = key.map(decodeURIComponent).join("/");
  if (rel.includes("..")) return new Response("Bad path", { status: 400 });
  const type = mimeFor(rel);
  const headers: Record<string, string> = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=31536000, immutable" };

  if (storageDriver === "s3") {
    try {
      const buf = await getFile(rel);
      return new Response(new Uint8Array(buf), { headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  const full = path.join(localRoot, rel);
  let stat;
  try {
    stat = await fs.stat(full);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const range = req.headers.get("range");
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    const start = m?.[1] ? parseInt(m[1]) : 0;
    const end = m?.[2] ? Math.min(parseInt(m[2]), stat.size - 1) : stat.size - 1;
    const stream = Readable.toWeb(createReadStream(full, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": String(end - start + 1) },
    });
  }
  const stream = Readable.toWeb(createReadStream(full)) as ReadableStream;
  return new Response(stream, { headers: { ...headers, "Content-Length": String(stat.size) } });
}

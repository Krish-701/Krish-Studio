import { subscribe } from "@/lib/events";
import type { Params } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Server-Sent Events stream of live studio events for one project. */
export async function GET(req: Request, { params }: Params<"id">) {
  const { id } = await params;
  const enc = new TextEncoder();
  let unsub = () => {};
  let ping: ReturnType<typeof setInterval>;
  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };
      send({ type: "hello" });
      unsub = subscribe(id, send);
      ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ping\n\n`));
        } catch {}
      }, 20_000);
      req.signal.addEventListener("abort", () => {
        clearInterval(ping);
        unsub();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      clearInterval(ping);
      unsub();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
}

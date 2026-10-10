import { EventEmitter } from "events";
import IORedis from "ioredis";

/**
 * Live progress bus. Every state change (job progress, shot status, agent findings, chat tokens)
 * is published here and streamed to browsers over SSE (/api/projects/[id]/events).
 * Uses Redis pub/sub when REDIS_URL is set (so a separate worker process can publish),
 * otherwise an in-process EventEmitter.
 */
export type StudioEvent =
  | { type: "job"; job: { id: string; shotId: string | null; type: string; status: string; progress: number; step: string | null; error: string | null } }
  | { type: "shot"; shotId: string; patch: Record<string, unknown> }
  | { type: "finding"; finding: Record<string, unknown> }
  | { type: "agent"; agent: string; status: "thinking" | "idle" | "acting"; detail?: string }
  | { type: "chat"; messageId: string; agent: string; delta?: string; done?: boolean }
  | { type: "refresh"; scope: "shots" | "assets" | "timeline" | "characters" | "project" | "all" };

const CHANNEL = "filmstudio:events:";

type Bus = {
  emitter: EventEmitter;
  pub?: IORedis;
  sub?: IORedis;
  subscribed?: boolean;
};

const g = globalThis as unknown as { __studioBus?: Bus };

function bus(): Bus {
  if (!g.__studioBus) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(1000);
    const b: Bus = { emitter };
    if (process.env.REDIS_URL) {
      b.pub = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
      b.sub = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
      b.sub.on("pmessage", (_p, channel, msg) => {
        const projectId = channel.slice(CHANNEL.length);
        try {
          emitter.emit(projectId, JSON.parse(msg));
        } catch {}
      });
    }
    g.__studioBus = b;
  }
  return g.__studioBus;
}

export function publish(projectId: string, event: StudioEvent) {
  const b = bus();
  if (b.pub) b.pub.publish(CHANNEL + projectId, JSON.stringify(event)).catch(() => {});
  else b.emitter.emit(projectId, event);
}

export function subscribe(projectId: string, cb: (e: StudioEvent) => void) {
  const b = bus();
  if (b.sub && !b.subscribed) {
    b.subscribed = true;
    b.sub.psubscribe(CHANNEL + "*").catch(() => {});
  }
  b.emitter.on(projectId, cb);
  return () => {
    b.emitter.off(projectId, cb);
  };
}

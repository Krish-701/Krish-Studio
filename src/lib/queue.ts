import { Queue } from "bullmq";
import IORedis from "ioredis";
import type { JobType, Prisma } from "@prisma/client";
import { db } from "./db";
import { publish } from "./events";

/**
 * Job queue. Every long-running generation is a row in `Job` (the source of truth for the
 * progress UI) plus a queue entry that a worker picks up.
 *   - REDIS_URL set  → BullMQ queue "studio" (worker: `npm run worker`, or INLINE_WORKER=1)
 *   - otherwise      → in-process queue with limited concurrency
 */
export const QUEUE_NAME = "studio";
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 4);

type Mem = { pending: string[]; running: number; handler?: (jobId: string) => Promise<void> };
const g = globalThis as unknown as { __studioQueue?: Queue; __memQueue?: Mem; __redis?: IORedis };

export function redisConnection() {
  if (!process.env.REDIS_URL) return null;
  if (!g.__redis) g.__redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  return g.__redis;
}

function bullQueue() {
  const conn = redisConnection();
  if (!conn) return null;
  if (!g.__studioQueue) g.__studioQueue = new Queue(QUEUE_NAME, { connection: conn });
  return g.__studioQueue;
}

function mem(): Mem {
  if (!g.__memQueue) g.__memQueue = { pending: [], running: 0 };
  return g.__memQueue;
}

/** Registers the in-process job handler (called by the inline worker). */
export function setMemoryHandler(handler: (jobId: string) => Promise<void>) {
  mem().handler = handler;
  pump();
}

function pump() {
  const m = mem();
  while (m.handler && m.running < CONCURRENCY && m.pending.length) {
    const id = m.pending.shift()!;
    m.running++;
    m.handler(id)
      .catch((e) => console.error("[queue] job crashed", id, e))
      .finally(() => {
        m.running--;
        pump();
      });
  }
}

async function push(jobId: string, delayMs = 0) {
  const q = bullQueue();
  if (q) {
    await q.add("run", { jobId }, { jobId: `${jobId}-${Date.now()}`, delay: delayMs, removeOnComplete: 500, removeOnFail: 500 });
  } else {
    const run = () => {
      mem().pending.push(jobId);
      pump();
    };
    if (delayMs) setTimeout(run, delayMs);
    else run();
    if (!mem().handler) {
      // Lazily boot the in-process worker the first time something is queued.
      const { startInlineWorker } = await import("@/worker/inline");
      startInlineWorker();
    }
  }
}

export async function enqueue(opts: {
  projectId: string;
  type: JobType;
  shotId?: string | null;
  input?: Prisma.InputJsonValue;
  provider?: string;
  maxAttempts?: number;
}) {
  const job = await db.job.create({
    data: {
      projectId: opts.projectId,
      type: opts.type,
      shotId: opts.shotId ?? null,
      input: opts.input ?? {},
      provider: opts.provider,
      maxAttempts: opts.maxAttempts ?? 3,
      step: "Queued",
    },
  });
  publish(job.projectId, {
    type: "job",
    job: { id: job.id, shotId: job.shotId, type: job.type, status: job.status, progress: 0, step: job.step, error: null },
  });
  await push(job.id);
  return job;
}

/** Re-queue an existing job (retry button / automatic backoff). */
export async function requeue(jobId: string, delayMs = 0, resetAttempts = false) {
  const job = await db.job.update({
    where: { id: jobId },
    data: { status: "QUEUED", progress: 0, step: delayMs ? `Retrying in ${Math.round(delayMs / 1000)}s` : "Queued", error: null, ...(resetAttempts ? { attempts: 0 } : {}) },
  });
  publish(job.projectId, {
    type: "job",
    job: { id: job.id, shotId: job.shotId, type: job.type, status: job.status, progress: 0, step: job.step, error: null },
  });
  await push(job.id, delayMs);
  return job;
}

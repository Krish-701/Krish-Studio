import { Worker } from "bullmq";
import { QUEUE_NAME, redisConnection } from "@/lib/queue";
import { processJob } from "./processors";
import { db } from "@/lib/db";
import { requeue } from "@/lib/queue";

const g = globalThis as unknown as { __bullWorker?: Worker };

export async function startBullWorker() {
  const connection = redisConnection();
  if (!connection || g.__bullWorker) return g.__bullWorker;
  const concurrency = Number(process.env.WORKER_CONCURRENCY || 4);
  g.__bullWorker = new Worker(QUEUE_NAME, async (job) => processJob(job.data.jobId), { connection, concurrency });
  g.__bullWorker.on("failed", (job, err) => console.error("[worker] bull job failed", job?.id, err.message));
  console.log(`[worker] BullMQ worker started (concurrency ${concurrency})`);
  // Jobs that were RUNNING when the previous worker died get picked up again.
  const orphans = await db.job.findMany({ where: { status: "RUNNING", updatedAt: { lt: new Date(Date.now() - 60_000) } } });
  for (const j of orphans) await requeue(j.id);
  return g.__bullWorker;
}

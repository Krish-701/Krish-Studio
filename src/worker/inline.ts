import { memoryHas, requeue, setMemoryHandler } from "@/lib/queue";
import { processJob } from "./processors";

const g = globalThis as unknown as { __inlineWorker?: boolean; __krishSweep?: () => Promise<void>; __krishSweepTimer?: ReturnType<typeof setInterval> };

/** Pick up QUEUED rows the in-memory list lost (a reload, or a worker copy that never saw the insert). */
async function sweepQueued() {
  const { db } = await import("@/lib/db");
  const stale = await db.job.findMany({ where: { status: "QUEUED" } }).catch(() => []);
  for (const j of stale) {
    if (memoryHas(j.id)) continue;
    const age = Date.now() - new Date(j.updatedAt).getTime();
    const step = j.step ?? "";
    if (step.startsWith("Retrying") && age < 30_000) continue;
    if (age < 1_500) continue;
    await requeue(j.id);
  }
}

/** In-process worker: used when REDIS_URL is not set. */
export function startInlineWorker() {
  // Always reattach the handler. A reload can leave the flag set and the queue with no worker.
  setMemoryHandler(processJob);
  g.__krishSweep = sweepQueued;
  if (!g.__krishSweepTimer) g.__krishSweepTimer = setInterval(() => void g.__krishSweep?.().catch((e) => console.error("[worker] sweep", e)), 3000);
  if (g.__inlineWorker) return;
  g.__inlineWorker = true;
  console.log("[worker] in-process queue worker started");
}

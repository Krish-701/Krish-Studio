/** Node-only boot: starts the job worker inside the Next.js server when configured. */
async function boot() {
  if (process.env.REDIS_URL && process.env.INLINE_WORKER === "1") {
    const { startBullWorker } = await import("./worker/bull");
    await startBullWorker();
  } else if (!process.env.REDIS_URL) {
    const { startInlineWorker } = await import("./worker/inline");
    startInlineWorker();
    // Re-run jobs interrupted by a restart.
    const { db } = await import("./lib/db");
    const { requeue } = await import("./lib/queue");
    const stale = await db.job.findMany({ where: { status: { in: ["RUNNING", "QUEUED"] } } }).catch(() => []);
    for (const j of stale) await requeue(j.id);
  }
}

boot().catch((e) => console.error("[boot]", e));
export {};

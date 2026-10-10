import { setMemoryHandler } from "@/lib/queue";
import { processJob } from "./processors";

const g = globalThis as unknown as { __inlineWorker?: boolean };

/** In-process worker: used when REDIS_URL is not set. */
export function startInlineWorker() {
  if (g.__inlineWorker) return;
  g.__inlineWorker = true;
  setMemoryHandler(processJob);
  console.log("[worker] in-process queue worker started");
}

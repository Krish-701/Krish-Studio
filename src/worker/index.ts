/** Standalone worker process: `npm run worker` (requires REDIS_URL). */
import { startBullWorker } from "./bull";

if (!process.env.REDIS_URL) {
  console.error("REDIS_URL is not set. Without Redis the Next.js server runs jobs in-process; no separate worker is needed.");
  process.exit(1);
}
startBullWorker().then(() => console.log("[worker] ready"));

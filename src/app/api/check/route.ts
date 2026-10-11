import { fail, ok, route } from "@/lib/api";
import { runCheck, type CheckStep } from "@/lib/connection-check";

export const maxDuration = 300;

/** POST { step: "llm" | "vision" | "magnific" | "image" } → one connection check. */
export const POST = route(async (req: Request) => {
  const b = await req.json().catch(() => ({}));
  if (!["llm", "vision", "magnific", "image", "video"].includes(b.step)) return fail("step must be llm, vision, magnific, image or video");
  return ok(await runCheck(b.step as CheckStep, { model: b.model, prompt: b.prompt, imageKey: b.imageKey, imageRef: b.imageRef }));
});

import { db } from "@/lib/db";
import { fail, ok, route, type Params } from "@/lib/api";
import { chatJson, isLlmConfigured } from "@/lib/llm";
import { styleText, type StyleLock } from "@/lib/prompt-builder";

/**
 * Rewrite a shot's image prompt or motion prompt with AI. Returns the new text; the editor decides whether to keep it.
 * { target: "prompt" | "motion", instruction?: "make it rainier" }
 */
export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  if (!(await isLlmConfigured())) return fail("Connect an AI model in Settings to rewrite prompts.");
  const target = b.target === "motion" ? "motion" : "prompt";
  const shot = await db.shot.findUniqueOrThrow({
    where: { id },
    include: { project: true, scene: { include: { locationEl: true } }, characters: { include: { character: true } } },
  });
  const prev = await db.shot.findFirst({ where: { projectId: shot.projectId, order: shot.order - 1 }, select: { description: true, motionPrompt: true } });
  const cast = shot.characters.map((c) => `${c.character.name}${c.character.handle ? ` (@${c.character.handle})` : ""}: ${c.character.description}${c.look ? ` — wearing their "${c.look}" look` : ""}`).join("\n");
  const context = [
    `Film: ${shot.project.title}. ${shot.project.logline ?? ""}`,
    `Look: ${styleText(shot.project.styleLock as StyleLock, shot.colorPreset) || "not set"}`,
    shot.scene && `Scene: ${shot.scene.heading} — ${shot.scene.summary ?? ""}${shot.scene.locationEl ? ` (set: ${shot.scene.locationEl.name}: ${shot.scene.locationEl.description})` : ""}`,
    prev && `Previous shot: ${prev.description}`,
    `This shot: ${shot.title}. ${shot.description}. Framing ${shot.shotType ?? "unspecified"}, camera ${shot.cameraMove ?? "static"}, ${shot.durationSec}s.`,
    shot.dialogue && `Dialogue (${shot.speaker ?? "?"}): "${shot.dialogue}"`,
    cast && `Characters in frame:\n${cast}`,
    `Current ${target === "motion" ? "motion prompt" : "image prompt"}: ${(target === "motion" ? shot.motionPrompt : shot.prompt) || "(empty)"}`,
    b.instruction && `Change requested: ${b.instruction}`,
  ].filter(Boolean).join("\n");
  const ask = target === "motion"
    ? "Write the motion prompt for the video model: what moves, in order, over the shot's duration, and how the camera moves. Concrete, present tense, 1-3 sentences, no style words (the look is added separately)."
    : "Write the image prompt for the storyboard frame: subject and action, framing and lens, set details, light. Refer to characters by name. One paragraph, under 80 words, no style words (the look is added separately).";
  const r = await chatJson<{ text: string }>(
    [
      { role: "system", content: "You are a film director's assistant who writes precise prompts for image and video generation models." },
      { role: "user", content: `${context}\n\n${ask}\nJSON: {"text":""}` },
    ],
    { agent: "DIRECTOR", temperature: 0.6 },
  );
  if (!r.text?.trim()) return fail("The model returned nothing; try again.");
  return ok({ target, text: r.text.trim() });
});

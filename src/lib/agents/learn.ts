import { db } from "../db";
import { chatJson, isLlmConfigured } from "../llm";
import { listMemory, memoryKey, writeMemory } from "../memory";
import { logActivity } from "../activity";

/**
 * Self-improvement per project: after every message the filmmaker sends, the crew pulls out lasting
 * lessons (taste, rules, corrections: "less handheld", "Maya never smiles", "shorter shots in fights")
 * and saves them to the project's memory as `lesson` entries. Every agent and the writer read them,
 * so the next shot, scene or rewrite already follows them. Lessons stay per project.
 */
const FEEDBACK = /\b(don'?t|do not|never|always|stop|prefer|instead|too (much|many|long|short|dark|bright|slow|fast)|more|less|make (it|them|him|her)|i (want|like|love|hate|need)|should|must|wrong|not (like|what)|better|keep)\b/i;

const g = globalThis as unknown as { __learnBusy?: Set<string> };
const busy = (g.__learnBusy ??= new Set());

export async function learnFromFeedback(projectId: string, message: string) {
  const text = message.trim();
  if (text.length < 8 || busy.has(projectId)) return [];
  busy.add(projectId);
  try {
    const lessons = (await listMemory(projectId, { category: "lesson" })).slice(0, 40);
    let found: { key: string; content: string; replaces?: string }[] = [];
    if (await isLlmConfigured()) {
      const out = await chatJson<{ lessons: { key: string; content: string; replaces?: string }[] }>(
        [
          {
            role: "system",
            content:
              "You maintain the lessons an AI film crew has learned from its filmmaker on one project. From the filmmaker's latest message, extract only lasting preferences, rules or corrections that should change how future work is done (story, pacing, shot lengths, look, characters, sound, models, how to communicate). Ignore one-off requests, questions and status chatter. Merge with existing lessons: if one is refined or contradicted, return it with the same key in \"replaces\". Return at most 3. Reply with JSON only.",
          },
          {
            role: "user",
            content: `Existing lessons:\n${lessons.map((l) => `- [${l.key}] ${l.content}`).join("\n") || "(none)"}\n\nFilmmaker's message:\n${text.slice(0, 4000)}\n\nJSON: {"lessons":[{"key":"short-kebab-name","content":"one sentence the crew must follow","replaces":"existing key or empty"}]}`,
          },
        ],
        { agent: "DIRECTOR", temperature: 0.1, reasoning: false },
      );
      found = (out.lessons ?? []).filter((l) => l?.content?.trim()).slice(0, 3);
    } else if (FEEDBACK.test(text)) {
      found = [{ key: `lesson-${text.slice(0, 40)}`, content: text.slice(0, 400) }];
    }
    const saved = [];
    for (const l of found) {
      const key = memoryKey(l.replaces || l.key);
      saved.push(await writeMemory(projectId, { key, content: l.content, category: "lesson" }, "DIRECTOR"));
      await logActivity(projectId, { kind: "agent", level: "success", actor: "Director", message: `Learned: ${l.content.slice(0, 200)}`, data: { key } });
    }
    if (saved.length) await db.project.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
    return saved;
  } catch (e) {
    console.warn("[learn] skipped:", (e as Error).message);
    return [];
  } finally {
    busy.delete(projectId);
  }
}

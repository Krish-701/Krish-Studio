import { db } from "./db";
import { publish } from "./events";

/**
 * Shared project memory. One store per project that the user and every agent read and write:
 * decisions, preferences, character and continuity notes, style rules. Each agent sees the
 * whole store in its system prompt and can add, edit or delete entries through tools.
 */

export const MEMORY_CATEGORIES = ["lesson", "decision", "preference", "character", "style", "continuity", "note"] as const;

export function memoryKey(raw: string) {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `note-${Date.now().toString(36)}`;
}

export async function listMemory(projectId: string, opts: { query?: string; category?: string } = {}) {
  const q = opts.query?.trim();
  return db.memoryEntry.findMany({
    where: {
      projectId,
      ...(opts.category ? { category: opts.category } : {}),
      ...(q ? { OR: [{ key: { contains: q, mode: "insensitive" } }, { content: { contains: q, mode: "insensitive" } }] } : {}),
    },
    orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
  });
}

export async function writeMemory(
  projectId: string,
  input: { key: string; content: string; category?: string; pinned?: boolean; mode?: "replace" | "append"; expectedVersion?: number },
  by: string,
) {
  const key = memoryKey(input.key);
  const category = MEMORY_CATEGORIES.includes(input.category as never) ? input.category! : undefined;
  const existing = await db.memoryEntry.findUnique({ where: { projectId_key: { projectId, key } } });
  if (existing && input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
    throw new Error(`Memory "${key}" changed since you read it (now version ${existing.version}). Read it again and re-apply your edit.`);
  }
  const content = existing && input.mode === "append" ? `${existing.content.trimEnd()}\n${input.content.trim()}` : input.content.trim();
  const entry = existing
    ? await db.memoryEntry.update({
        where: { id: existing.id },
        data: { content, ...(category && { category }), ...(input.pinned !== undefined && { pinned: input.pinned }), updatedBy: by, version: { increment: 1 } },
      })
    : await db.memoryEntry.create({ data: { projectId, key, content, category: category ?? "note", pinned: !!input.pinned, updatedBy: by } });
  publish(projectId, { type: "refresh", scope: "memory" });
  return entry;
}

export async function updateMemoryById(projectId: string, id: string, patch: { key?: string; content?: string; category?: string; pinned?: boolean }, by: string) {
  const e = await db.memoryEntry.findFirst({ where: { id, projectId } });
  if (!e) throw new Error("Memory entry not found");
  const entry = await db.memoryEntry.update({
    where: { id },
    data: {
      ...(patch.key !== undefined && { key: memoryKey(patch.key) }),
      ...(patch.content !== undefined && { content: patch.content.trim() }),
      ...(patch.category && MEMORY_CATEGORIES.includes(patch.category as never) && { category: patch.category }),
      ...(patch.pinned !== undefined && { pinned: patch.pinned }),
      updatedBy: by,
      version: { increment: 1 },
    },
  });
  publish(projectId, { type: "refresh", scope: "memory" });
  return entry;
}

export async function deleteMemory(projectId: string, keyOrId: string) {
  const r = await db.memoryEntry.deleteMany({ where: { projectId, OR: [{ id: keyOrId }, { key: memoryKey(keyOrId) }] } });
  publish(projectId, { type: "refresh", scope: "memory" });
  return r.count;
}

/** The memory block every agent gets in its system prompt. Pinned and recent entries first, capped in size. */
export async function memoryPrompt(projectId: string, maxChars = 5000) {
  const [all, project] = await Promise.all([listMemory(projectId), db.project.findUnique({ where: { id: projectId }, select: { brief: true } })]);
  const brief = project?.brief?.trim()
    ? `The filmmaker's brief (their standing instructions to every agent; always follow it):\n${project.brief.trim().slice(0, 3000)}\n\n`
    : "";
  // Lessons learned from the filmmaker's feedback come first: they are how the crew improves on this project.
  const entries = [...all.filter((e) => e.category === "lesson"), ...all.filter((e) => e.category !== "lesson")];
  if (!entries.length) {
    return `${brief}Shared project memory is empty. Save lasting decisions, user preferences and continuity facts with memory_write so every agent can use them.`;
  }
  const lines: string[] = [];
  let size = 0;
  let omitted = 0;
  for (const e of entries) {
    const line = `- [${e.key}] (${e.category}${e.pinned ? ", pinned" : ""}, v${e.version}, by ${e.updatedBy.toLowerCase()}): ${e.content.replace(/\n/g, " ")}`;
    if (size + line.length > maxChars) {
      omitted++;
      continue;
    }
    lines.push(line);
    size += line.length;
  }
  return brief + [
    "Shared project memory (read by every agent and the user; follow it, and keep it current). Entries marked lesson are what the filmmaker taught you on this project:",
    ...lines,
    omitted ? `(${omitted} more entr${omitted === 1 ? "y" : "ies"} not shown; use memory_search.)` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

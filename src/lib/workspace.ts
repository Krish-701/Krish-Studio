import path from "path";
import { promises as fs } from "fs";
import { db } from "./db";
import { localRoot, storageDriver } from "./storage";

/**
 * Each project is its own workspace folder: storage/<projectId>/ holds its media (images/, videos/,
 * audio/, refs/, exports/…) plus a readable snapshot of the project so it can be backed up,
 * copied to another machine or opened without the app:
 *   project.json  settings, models, brief, story score, autopilot state
 *   story.md      idea, brief, outline, scenes and shots with their lengths
 *   memory.md     what the crew remembers, including lessons learned from you
 *   activity.log  the full work log
 */
export function workspaceDir(projectId: string) {
  return path.resolve(localRoot, projectId);
}

export async function writeWorkspace(projectId: string) {
  const p = await db.project.findUnique({
    where: { id: projectId },
    include: {
      sequences: { orderBy: { index: "asc" }, include: { scenes: { orderBy: { index: "asc" }, include: { shots: { orderBy: { order: "asc" } } } } } },
      characters: true,
      elements: true,
      memory: { orderBy: [{ category: "asc" }, { updatedAt: "desc" }] },
    },
  });
  if (!p) return null;
  const dir = workspaceDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  const { sequences, characters, elements, memory, ...project } = p;
  const totalSec = sequences.flatMap((s) => s.scenes.flatMap((c) => c.shots)).reduce((a, s) => a + s.durationSec, 0);
  await fs.writeFile(
    path.join(dir, "project.json"),
    JSON.stringify({ ...project, characters: characters.map(({ name, role, description, handle }) => ({ name, role, handle, description })), sets: elements.map(({ kind, name, description }) => ({ kind, name, description })), boardedSec: Math.round(totalSec), storage: storageDriver }, null, 2),
  );
  const md = [
    `# ${p.title}`,
    `${p.format} · target ${Math.round(p.targetRuntimeSec / 60)} min · boarded ${Math.round(totalSec / 60)} min · ${p.aspectRatio} ${p.resolution}`,
    p.logline && `> ${p.logline}`,
    p.synopsis && `## Story\n\n${p.synopsis}`,
    p.brief && `## Brief to the crew\n\n${p.brief}`,
    ...sequences.map((s) =>
      [
        `## ${s.index + 1}. ${s.title} (Act ${s.act}, ${Math.round(s.targetDurationSec)}s)`,
        s.summary,
        ...s.scenes.map((c) => [`### ${c.heading}`, c.summary ?? "", ...c.shots.map((sh) => `- #${sh.order + 1} ${sh.durationSec}s ${sh.shotType ?? ""} ${sh.title}: ${sh.description}${sh.dialogue ? ` — ${sh.speaker ?? ""}: "${sh.dialogue}"` : ""}`)].join("\n")),
      ].join("\n\n"),
    ),
  ].filter(Boolean);
  await fs.writeFile(path.join(dir, "story.md"), md.join("\n\n") + "\n");
  await fs.writeFile(path.join(dir, "memory.md"), `# Crew memory: ${p.title}\n\n` + memory.map((m) => `- **${m.category}** [${m.key}] ${m.content}`).join("\n") + "\n");
  const logs = await db.activityLog.findMany({ where: { projectId }, orderBy: { createdAt: "asc" }, take: 20000 });
  await fs.writeFile(path.join(dir, "activity.log"), logs.map((l) => `${l.createdAt.toISOString()} ${l.level.toUpperCase().padEnd(7)} ${l.kind.padEnd(7)} ${(l.actor ?? "").padEnd(14)} ${l.message.replace(/\n/g, " ")}`).join("\n") + "\n");
  return dir;
}

import type { Job } from "@prisma/client";
import { db } from "@/lib/db";
import { publish } from "@/lib/events";
import { enqueue } from "@/lib/queue";
import { logActivity } from "@/lib/activity";
import { writeWorkspace } from "@/lib/workspace";
import * as svc from "@/lib/services";
import { improveStory, scoreStory, SCORE_BLOCK, SCORE_READY, type StoryScore } from "@/lib/script/score";
import type { GenContext } from "@/lib/generation/types";

/**
 * Full autopilot. One AUTOPILOT job walks the production stage by stage and re-queues itself
 * (`__deferred`) while a stage's jobs are running, so nothing blocks the worker:
 *   score → write → design → frames → clips → sound → export → done
 * The story gate comes first: below 6 the run stops and asks the filmmaker to change the story;
 * between 6 and 8.5 the Script Doctor rewrites it until it scores 8.5+; then everything runs on its own.
 */
export const STAGES = ["score", "write", "design", "frames", "clips", "sound", "export", "done"] as const;
export type Stage = (typeof STAGES)[number];

export interface AutopilotState {
  status: "running" | "paused" | "needs_input" | "done" | "failed";
  stage: Stage;
  message?: string;
  startedAt?: string;
  updatedAt?: string;
  jobId?: string;
  /** Start even though the story scored under 8.5 (the filmmaker said so). */
  force?: boolean;
}

const STAGE_WORDS: Record<Stage, string> = {
  score: "Scoring the story",
  write: "Writing the film (outline, scenes and shots)",
  design: "Designing characters and sets",
  frames: "Drawing storyboard frames",
  clips: "Generating video clips",
  sound: "Adding voices and music",
  export: "Exporting the film",
  done: "Finished",
};

export async function getAutopilot(projectId: string) {
  const p = await db.project.findUnique({ where: { id: projectId }, select: { autopilot: true } });
  return (p?.autopilot as unknown as AutopilotState | null) ?? null;
}

export async function setAutopilot(projectId: string, patch: Partial<AutopilotState>) {
  const cur = (await getAutopilot(projectId)) ?? { status: "running", stage: "score" };
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() } as AutopilotState;
  await db.project.update({ where: { id: projectId }, data: { autopilot: next as never } });
  publish(projectId, { type: "refresh", scope: "project" });
  return next;
}

/** The Director says something in its chat (milestones, questions for the filmmaker). */
export async function directorSays(projectId: string, text: string) {
  await db.agentMessage.create({ data: { projectId, agent: "DIRECTOR", role: "assistant", content: text } });
  publish(projectId, { type: "chat", messageId: "autopilot", agent: "DIRECTOR", done: true });
}

export async function startAutopilot(projectId: string, opts: { force?: boolean; from?: Stage } = {}) {
  const running = await db.job.findFirst({ where: { projectId, type: "AUTOPILOT", status: { in: ["QUEUED", "RUNNING"] } } });
  if (running) return { job: running, state: await setAutopilot(projectId, { status: "running", ...(opts.force ? { force: true } : {}) }) };
  const prev = await getAutopilot(projectId);
  const stage: Stage = opts.from ?? (prev && prev.status !== "done" && prev.stage !== "done" ? prev.stage : "score");
  await db.project.update({ where: { id: projectId }, data: { setupDone: true } });
  const state = await setAutopilot(projectId, { status: "running", stage, startedAt: new Date().toISOString(), message: STAGE_WORDS[stage], force: !!opts.force });
  const job = await enqueue({ projectId, type: "AUTOPILOT", input: {}, maxAttempts: 3 });
  await setAutopilot(projectId, { jobId: job.id });
  await logActivity(projectId, { kind: "system", actor: "Director", message: `Autopilot started at “${STAGE_WORDS[stage]}”` });
  return { job, state };
}

export async function pauseAutopilot(projectId: string) {
  await db.job.updateMany({ where: { projectId, type: "AUTOPILOT", status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELED", step: "Paused" } });
  await logActivity(projectId, { kind: "system", level: "warn", actor: "you", message: "Autopilot paused (jobs already queued keep running)" });
  return setAutopilot(projectId, { status: "paused", message: "Paused" });
}

/** Jobs of this project still queued or running, except the autopilot job itself. */
async function busy(projectId: string, selfId: string) {
  return db.job.count({ where: { projectId, id: { not: selfId }, type: { not: "AUTOPILOT" }, status: { in: ["QUEUED", "RUNNING"] } } });
}

const wait = (step: string) => ({ __deferred: 8000, step });

export async function runAutopilot(job: Job, ctx: GenContext): Promise<unknown> {
  const projectId = job.projectId;
  let st = await getAutopilot(projectId);
  if (!st || st.status === "paused" || st.status === "done") return { stopped: st?.status ?? "missing" };
  if (st.status === "needs_input" && !st.force) return { stopped: "needs_input" };

  // A stage only moves on once everything it queued has finished.
  const pending = await busy(projectId, job.id);
  if (pending) return wait(`${STAGE_WORDS[st.stage]} · ${pending} job(s) running`);

  const advance = async (to: Stage) => {
    st = await setAutopilot(projectId, { status: "running", stage: to, message: STAGE_WORDS[to] });
    await logActivity(projectId, { kind: "system", level: "info", actor: "Director", message: `Autopilot: ${STAGE_WORDS[to]}` });
    writeWorkspace(projectId).catch(() => {});
  };

  await ctx.onProgress(Math.round((STAGES.indexOf(st.stage) / (STAGES.length - 1)) * 100), STAGE_WORDS[st.stage]);
  switch (st.stage) {
    case "score": {
      let s = await scoreStory(projectId);
      if (s.method === "ai" && s.score < SCORE_BLOCK && !st.force) return needsInput(projectId, s, "rework");
      if (s.method === "ai" && s.score < SCORE_READY) {
        await directorSays(projectId, `The story scores ${s.score.toFixed(1)}/10. The Script Doctor is improving it to ${SCORE_READY}+ before production starts.`);
        s = await improveStory(projectId, { onProgress: ctx.onProgress });
        if (s.score < SCORE_READY && !st.force) return needsInput(projectId, s, "stuck");
      }
      if (s.method === "estimate") await logActivity(projectId, { kind: "system", level: "warn", actor: "Director", message: "No AI model configured: the story score is only an estimate, so autopilot goes ahead." });
      // The improved story must reach the board: rewrite an outline written before it changed.
      const stale = s.rounds && (await db.sequence.count({ where: { projectId } }));
      if (stale) await db.sequence.deleteMany({ where: { projectId } });
      await directorSays(projectId, `Story score ${s.score.toFixed(1)}/10. Starting full production: writing, design, frames, clips, sound and export. I'll post progress as it goes.`);
      await advance("write");
      return wait("Story ready");
    }

    case "write": {
      const seqs = await db.sequence.findMany({ where: { projectId }, select: { id: true, status: true } });
      if (!seqs.length) {
        await svc.writeFilm(projectId, true);
        return wait("Writing the outline");
      }
      const unwritten = seqs.filter((s) => s.status !== "written");
      if (unwritten.length) {
        const failed = await db.job.count({ where: { projectId, type: "WRITE_SEQUENCE", status: "FAILED", updatedAt: { gt: new Date(job.createdAt) } } });
        if (failed >= unwritten.length) throw new Error(`${unwritten.length} sequence(s) could not be written; check the Log tab.`);
        await svc.writeSequences(projectId, unwritten.map((s) => s.id));
        return wait(`Writing ${unwritten.length} sequence(s)`);
      }
      await advance("design");
      return wait("Film written");
    }

    case "design": {
      const chars = await db.character.findMany({ where: { projectId }, include: { references: { select: { meta: true } } } });
      const sets = await db.element.findMany({ where: { projectId, kind: "location" }, include: { references: { select: { meta: true } } } });
      const sheeted = (refs: { meta: unknown }[]) => refs.some((r) => (r.meta as Record<string, unknown> | null)?.fromSheet);
      let queued = 0;
      for (const c of chars.filter((c) => c.role !== "extra" && !sheeted(c.references))) {
        await svc.queueDesignSheet(projectId, { characterId: c.id, kind: "turnaround" });
        queued++;
      }
      for (const e of sets.filter((e) => !sheeted(e.references)).slice(0, 40)) {
        await svc.queueDesignSheet(projectId, { elementId: e.id, kind: "plate" });
        queued++;
      }
      if (queued && !st.message?.startsWith("Design queued")) {
        await setAutopilot(projectId, { message: `Design queued: ${queued} sheet(s)` });
        return wait(`Designing ${queued} character and set sheet(s)`);
      }
      await advance("frames");
      return wait("Design done");
    }

    case "frames": {
      const missing = await db.shot.count({ where: { projectId, imageAssetId: null } });
      if (missing && !st.message?.startsWith("Frames queued")) {
        await svc.queueContactSheets(projectId, { missing: "image" });
        await setAutopilot(projectId, { message: `Frames queued for ${missing} shot(s)` });
        return wait(`Drawing ${missing} frame(s)`);
      }
      await advance("clips");
      return wait("Frames done");
    }

    case "clips": {
      const missing = await db.shot.count({ where: { projectId, videoAssetId: null } });
      if (missing && !st.message?.startsWith("Clips queued")) {
        await svc.queueVideos(projectId, "missing");
        await setAutopilot(projectId, { message: `Clips queued for ${missing} shot(s)` });
        return wait(`Generating ${missing} clip(s)`);
      }
      await advance("sound");
      return wait("Clips done");
    }

    case "sound": {
      if (!st.message?.startsWith("Sound queued")) {
        const lines = await db.shot.findMany({ where: { projectId, dialogue: { not: null }, audioStatus: { not: "DONE" } }, select: { id: true } });
        for (const s of lines) await svc.queueVoiceover(projectId, s.id).catch(() => {});
        const hasMusic = await db.timelineClip.count({ where: { projectId, track: "MUSIC" } });
        const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
        const runtime = (await db.shot.aggregate({ where: { projectId }, _sum: { durationSec: true } }))._sum.durationSec ?? project.targetRuntimeSec;
        if (!hasMusic) {
          const style = (project.styleLock as Record<string, string> | null) ?? {};
          const mood = [style.mood, style.tone, style.prompt].filter(Boolean).join(", ") || "cinematic";
          // Long films get a cue per sequence-sized block; music models cap out at a few minutes.
          for (let start = 0; start < runtime; start += 240) await svc.queueMusic(projectId, `Film score for "${project.title}": ${mood}. ${project.logline ?? ""}`.slice(0, 400), Math.min(240, runtime - start), start);
        }
        await setAutopilot(projectId, { message: `Sound queued: ${lines.length} line(s)${hasMusic ? "" : " and the score"}` });
        return wait("Recording voices and music");
      }
      await advance("export");
      return wait("Sound done");
    }

    case "export": {
      if (!st.message?.startsWith("Export queued")) {
        await enqueue({ projectId, type: "EXPORT_MP4", maxAttempts: 1 });
        await setAutopilot(projectId, { message: "Export queued" });
        return wait("Exporting the film");
      }
      const failed = await db.job.count({ where: { projectId, status: "FAILED", updatedAt: { gt: new Date(job.createdAt) } } });
      await advance("done");
      await setAutopilot(projectId, { status: "done", message: failed ? `Finished with ${failed} failed job(s); see the Log tab` : "Finished" });
      await directorSays(projectId, `Autopilot finished: the film is written, boarded, animated, scored and exported${failed ? `. ${failed} job(s) failed; I listed them in the Log tab and you can retry them from the Queue` : ""}. Open Watch to see it, or Export to download it.`);
      return { done: true, failed };
    }

    case "done":
      return { done: true };
  }
}

async function needsInput(projectId: string, s: StoryScore, why: "rework" | "stuck") {
  const fixes = s.fixes.slice(0, 5).map((f) => `• ${f}`).join("\n");
  const msg =
    why === "rework"
      ? `The story scores ${s.score.toFixed(1)}/10, under ${SCORE_BLOCK}, so I haven't started production. Please change the story (Story score panel or tell me here). What would lift it most:\n${fixes}`
      : `After ${s.rounds ?? 0} rewrite(s) the story scores ${s.score.toFixed(1)}/10, short of ${SCORE_READY}. Tell me what to change, or press "Start anyway". Still open:\n${fixes}`;
  await setAutopilot(projectId, { status: "needs_input", stage: "score", message: msg });
  await directorSays(projectId, msg);
  await logActivity(projectId, { kind: "system", level: "warn", actor: "Director", message: `Autopilot waiting for you: story ${s.score.toFixed(1)}/10` });
  return { needsInput: true, score: s.score };
}

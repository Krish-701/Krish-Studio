# Krish Studio — codebase playbook

This is for any coding agent working on this repo (Claude Code, Codex, Cursor, a local agent). Read it before you change anything.
It says what the app does, where everything lives, how a film flows through the code, the rules that keep it working, and how to test.

## 1. What the app is

An AI film studio in the browser. The filmmaker gives a story idea and a total runtime (30 s to 3 h). AI agents score the story,
improve it, write it (acts → sequences → scenes → shots), build an asset library (characters, backgrounds, environments, props,
colour & mood), draw storyboard frames, animate clips, add voice/music/SFX, cut the timeline and export an MP4 or an editor package.

- **Brain (LLM):** any OpenAI-compatible API. Default is OpenRouter `qwen/qwen3.8-omni-flash` (multimodal, so it also does every image check).
  Reasoning is on, calls stream (`"stream": true`), and each assistant turn's `reasoning_details` is stored and sent back **unmodified**.
- **Generation:** every image, video, voice, music and SFX goes through **MCP tool calls**. The primary backend is **Magnific (Freepik)**,
  `https://mcp.magnific.com`, signed in with OAuth or a static token. Any other MCP server can be a fallback.
  The **offline preview renderer** draws placeholders (solid colours, Ken Burns) and is only used when every real backend is turned off.
- **Default models:** frames GPT Image 2.5 (`gpt-2-mini`, variant `flare`); clips Seedance 2.5 (`bytedance-seedance-pro-2.5`) at 720p;
  alternative Wan 3.0 Prime (`wan-3-0-prime`). Constants live in `src/lib/generation/catalog.ts` (`DEFAULT_*`).

## 2. Stack and running it

Next.js 15 (App Router) + React 19 + Tailwind v4 · Prisma 6 + PostgreSQL · optional Redis/BullMQ · ffmpeg · MCP TypeScript SDK.

```bash
cp .env.example .env            # LLM_API_KEY (OpenRouter), MAGNIFIC_MCP_TOKEN optional (or Settings → Connect Magnific)
docker compose up -d postgres redis
npm install
npx prisma db push              # after ANY schema change too
npm run dev                     # http://localhost:3000
```

| Command | What |
|---|---|
| `npm run dev` | Dev server. The job worker runs inside it (see Queue). |
| `npx tsc --noEmit -p .` | Type check. Must be clean before you commit. |
| `npm run build` | `prisma generate && next build`. Must pass before you commit. |
| `npx prisma db push` / `npx prisma generate` | Apply schema / regenerate the client. |
| `npm run worker` | Separate BullMQ worker (only with `REDIS_URL` and without `INLINE_WORKER=1`). |
| `npm run db:seed` | Demo film "The Last Lighthouse". |

Environment (`.env.example` lists all): `DATABASE_URL`, `REDIS_URL` (empty = in-process queue), `INLINE_WORKER=1`, `APP_URL`
(must be the address the browser uses; the Magnific sign-in returns to `APP_URL/api/mcp/oauth/callback`), `SETTINGS_SECRET` (encrypts keys in the DB),
`STORAGE_DRIVER` local|s3 (+ `S3_*`), `STORAGE_DIR`, `LLM_BASE_URL`, `LLM_API_KEY` / `OPENROUTER_API_KEY`, `LLM_MODEL`, `LLM_REASONING`,
`LLM_VISION_MODEL`, `LLM_STREAM=1` (force streaming on non-OpenRouter hosts), `MAGNIFIC_MCP_URL`, `MAGNIFIC_MCP_TOKEN`,
`SUMMARY_INTERVAL_MIN` (Director progress updates), `WORKER_CONCURRENCY`, `PREVIEW_FALLBACK=1` (tests only: let the preview renderer stand in).

Settings saved in the UI (table `AppSettings`) override env defaults; env keys are used when the DB has none.
**Never hardcode or commit keys.** `.env` is gitignored.

## 3. Map of the code

```
prisma/schema.prisma        data model (read it first)
src/app/                    pages + API routes (route handlers wrap with route() from lib/api.ts)
  page.tsx                  home: projects, Check connections
  projects/[id]/page.tsx    the studio
  settings/page.tsx         AI model, generation backends, Connect Magnific, models catalog
  api/projects/[id]/...     per-project API (see §6)
  api/check                 connection check steps (llm, vision, magnific, image, video)
  api/mcp/oauth/*           Magnific sign-in (start, callback, disconnect)
src/components/
  connection-check.tsx      Check connections card + connectMagnific()
  home/, settings/          home and settings pages
  studio/                   studio views: autopilot-view, script-view, assets-view (Asset Library), characters-view,
                            style-view, storyboard-view, scene-board, shot-card, shot-drawer, shot-motion, timeline-view,
                            watch-view, export-view, film-wizard (new-film setup), right-panel (Director chat, Agents,
                            Memory, Queue, Log), log-panel, pipeline (top bar), store.tsx (client state + SSE), use-models.ts
  ui/                       small UI kit (button, input, badge, dialog, misc). Dark theme tokens in app/globals.css.
src/lib/
  db.ts, api.ts, client.ts, utils.ts, crypto.ts
  settings.ts               getSettings/saveSettings; McpServerConfig; LLM defaults (DEFAULT_LLM)
  llm.ts                    chat() (streaming, reasoning_details passback, retries), chatJson(), visionModelFor(),
                            validateLlm(), testLlm(), testVision(), describeImage()
  events.ts                 publish() → SSE (StudioEvent: job, chat, agent, refresh, log…)
  queue.ts                  enqueue(), requeue() (BullMQ or in-process)
  storage.ts                local or S3 storage; keys look like <projectId>/<folder>/<uuid>.<ext>
  workspace.ts              per-project folder snapshot (project.json, story.md, memory.md, activity.log)
  activity.ts               logActivity() → ActivityLog rows + live "log" events
  memory.ts                 shared per-project memory + the brief; memoryPrompt() goes into every agent prompt
  services.ts               the verbs the UI and agents share: queueImages, queueVideos, queueContactSheets,
                            queueMultishot, queueDesignSheet, buildAssetLibrary, writeFilm, writeSequences,
                            queueVoiceover, queueMusic, queueSfx, createShot, reorderShots, projectOverview…
  prompt-builder.ts         builds every generation request (image, video, contact sheet, multishot): prompt text,
                            style lock, cast, set, environment, props, mood, and the reference plan
  references.ts             planReferences(): which reference images go to a model under its limits, in priority order
  library.ts                asset-library kinds (character, location, environment, prop, mood) — client-safe
  connection-check.ts       runCheck(step) used by /api/check
  timeline.ts, media.ts, ffmpeg.ts
  script/
    writer.ts               long-form writer: outline → sequences → scenes → shots; agent-chosen shot lengths
    score.ts                Script Doctor: scoreStory(), improveStory(), SCORE_BLOCK=6, SCORE_READY=8.5
    parse.ts, extract.ts    import an existing script (Fountain/PDF/text) into scenes and shots
  generation/
    catalog.ts              model catalog (limits, durations, variants), FORMATS, LOOKS, defaults, live sync
    router.ts               generate(cap, ctx, call): tries enabled backends in priority order
    magnific.ts             Magnific MCP adapter (images_generate, video_generate, extend, video_speak, audio…)
    generic-mcp.ts          any MCP server via a tool map; mock.ts = offline preview renderer
    types.ts                ImageRequest, VideoRequest, RefImage, GenResult, GenerationProvider
  mcp/
    client.ts               MCP client pool, callTool(), listTools(); OAuth provider when there's no static token
    oauth.ts                DbOAuthProvider (tokens encrypted in AppSettings.mcpAuth), startOAuth/finishOAuth
    toon.ts                 parses Magnific's TOON text responses
  agents/
    definitions.ts          agent roster + system prompts (DIRECTOR master, WRITER/Script Doctor, CONSISTENCY,
                            MOOD, MONITOR, AUDIO)
    tools.ts                every tool the agents can call (schema + impl)
    runner.ts               runAgent(): the tool-calling loop, prompted-tools fallback, sub-agent spawning, logging
    checks.ts               automatic checks after generations (vision compare with the library; rule-based fallback)
    learn.ts                learnFromFeedback(): user messages → "lesson" memory entries
    summary.ts              maybeSummarize(): Director progress updates in chat + Log
  export/                   mp4.ts (render + cache), package.ts (FCPXML, EDL, Premiere XML, zip), pdf.ts
src/worker/
  processors.ts             processJob(): job lifecycle, retries, deferral, logging; run() switch per JobType
  longform.ts               WRITE_*, DESIGN_SHEET, CONTACT_SHEET, MULTISHOT_VIDEO, EXTEND_VIDEO, LIPSYNC
  autopilot.ts              AUTOPILOT stage machine (score → write → design/asset library → frames → clips → sound → export)
  store.ts                  persist() generated media to storage
  inline.ts / bull.ts / index.ts   worker runners
src/instrumentation*.ts     boots the in-process worker with the Next server and requeues interrupted jobs
```

## 4. Data model (prisma/schema.prisma)

- **Project**: title, format, `targetRuntimeSec`, aspectRatio, `resolution` (default 720p), synopsis, logline, `brief` (the filmmaker's
  standing instructions to all agents), `storyScore` (JSON), `autopilot` (JSON state), `styleLock`, `defaults`
  (`{ image, imageVariant, video, videoAlt }`), `setupDone` (wizard finished), stage.
- **Sequence → Scene → Shot**. Shot: order, title, description, prompt, motionPrompt, shotType, cameraMove, `durationSec` (3–15),
  dialogue/speaker, continuity (cut | continuous | extend), image/video asset ids and statuses, per-shot model overrides.
- **Character** (cast, refs, `sheetAssetId`), **Element** (kind `location` | `environment` | `prop` | `mood`), linked to shots by
  **ShotCharacter** / **ShotElement**.
- **Asset**: every file (frames, clips, refs, sheets, audio). `meta.preview = true` marks placeholders; `meta.fromSheet` marks tiles cut from a sheet.
- **Job**: one row per long task (type, status, progress, step, input, output, attempts). The UI reads jobs; workers update them.
- **TimelineClip** (tracks VIDEO, VOICE, MUSIC, SFX), **AgentMessage** (chat; `role: "summary"` = progress update),
  **AgentFinding** (check results), **MemoryEntry** (shared memory; category `lesson` = learned from the user),
  **ActivityLog** (the Log tab), **AppSettings** (one row `global`: LLM, backends, catalog, `mcpAuth`).

## 5. How a film flows

1. **New film** (`film-wizard.tsx`, `POST /api/projects` with `wizard:true`): format, runtime, story, look, cast, brief.
2. **Story gate** (`script/score.ts`, job `STORY_SCORE`): the Script Doctor scores 9 criteria out of 10.
   Under 6 → writing is blocked (`/write` returns 409) and the user is asked to change the story. 6–8.5 → `improveStory` rewrites the treatment
   round by round. 8.5+ → ready.
3. **Write** (`script/writer.ts`, jobs `WRITE_OUTLINE` then `WRITE_SEQUENCE` per sequence): the outline also creates characters, sets,
   environments, props and a mood entry. Per scene the agent decides **how many shots and each shot's length (3–15 s)** from the story;
   `fitDurations()` keeps the agent's rhythm while landing exactly on the scene's screen time, and sequence/scene targets are normalised
   to the runtime. There is no fixed shot length anywhere; don't add one.
4. **Asset library** (`services.buildAssetLibrary`, job `DESIGN_SHEET`): character turnarounds (cut into 4 angle refs), set and environment
   plates (2×2, cut into refs), prop sheets, one colour & mood board. Each sheet gets a vision check (`checks.libraryCheck`).
5. **Frames** (`CONTACT_SHEET` per scene, or `IMAGE` per shot): `prompt-builder` adds cast, set, environment, props and mood; `references.ts`
   picks refs by priority (characters first, then set ≤2 / environment / prop slots kept, style/palette, mood board always keeps one slot).
6. **Clips** (`VIDEO`, `MULTISHOT_VIDEO`, `EXTEND_VIDEO`): animate from the frame (or reference mode). A clip waits (`__deferred`) while its
   frame is being redrawn or while the previous continuous clip is pending.
7. **Sound** (`TTS`, `MUSIC`, `SFX`, `LIPSYNC`) and **timeline** (`lib/timeline.ts`).
8. **Export** (`EXPORT_MP4`, `EXPORT_PDF`, `EXPORT_PACKAGE`).
9. **Autopilot** (`worker/autopilot.ts`, job `AUTOPILOT`) runs 2–8 by itself, re-queuing itself every few seconds until each stage's jobs finish.
   Pause cancels the autopilot job only; already-queued jobs keep running.

## 6. API (all JSON; errors are `{ error }`)

Projects: `GET/POST /api/projects`; `GET/PATCH/DELETE /api/projects/[id]` (GET returns the full studio state from `lib/project-state.ts`).
Per project (`/api/projects/[id]/…`): `agent` (chat; POST `{message, agent?}`), `write` (`{what: film|outline|sequences}`), `score`
(`{improve?}`), `autopilot` (`{action: start|pause, force?, from?}`), `library` (build missing assets), `generate` (kinds image, contact_sheet,
video, multishot, lipsync, voice, upscale, inpaint), `elements`, `characters`, `design`, `assets` (uploads, song, sheets), `shots`,
`shots/reorder`, `timeline`, `audio`, `export` (`{type: mp4|pdf|package}`), `jobs`, `findings/[fid]`, `memory`, `logs` (GET/DELETE),
`summary` (force a progress update), `workspace` (refresh the folder snapshot), `redo-previews` (GET count / POST regenerate placeholders),
`events` (SSE stream), `script` (import), `link`.
Other: `/api/shots/[id]` (+ `plan`, `rewrite`), `/api/sequences/[id]`, `/api/elements/[id]`, `/api/characters/[id]`, `/api/assets/[id]`,
`/api/jobs/[id]`, `/api/files/[...key]` (serves local storage), `/api/models`, `/api/settings` (+ `test`), `/api/check`, `/api/mcp/oauth/*`, `/api/health`.

## 7. Agents

- `definitions.ts` holds the roster. The **Director** is the master agent with every tool (`tools: ["*"]`); sub-agents have short tool lists.
  The Director delegates with `spawn_subagent` (one level deep).
- Every agent prompt = role prompt + `memoryPrompt()` (the brief, lessons first, then memory) + a project snapshot.
- Tools (`tools.ts`): project/shot reading and editing, writing (`write_film`, `write_sequences`), library (`build_asset_library`,
  `design_sheet`, `create_set`), generation (`generate_images`, `generate_contact_sheets`, `generate_videos`, `generate_multishot`,
  `lip_sync`, voice/music/sfx), progress/retries, style lock, memory, story (`score_story`, `improve_story`), autopilot
  (`start_autopilot`, `pause_autopilot`), models (`list_models`, `set_default_models`), `set_brief`, `report_finding`, export.
- **Adding a tool:** add `{ schema: S(desc, props, required), impl }` to `DEFS` in `tools.ts`, reuse a `services.ts` verb, return small JSON,
  then add the name to the sub-agents that need it in `definitions.ts`. Agents refer to shots by number (#4), never invent ids.
- **Models that can't call tools** fall back to prompted tools automatically (`validateLlm` stores the capability in `AppSettings.llmCaps`).
- Every user message runs `learnFromFeedback`; every finished job or agent turn may run `maybeSummarize`.

## 8. Rules that keep it working

1. **Long work is a Job.** Never generate media inside a request handler. `enqueue()` a job, return its id, let the worker run it and stream progress.
   Inside a job, report with `ctx.onProgress(pct, step)`; return `{ __deferred: ms, step }` to wait without failing.
2. **All generation goes through `generate()` in `router.ts`** with a request from `prompt-builder.ts`. Don't call a provider directly from
   features (the connection check is the one deliberate exception). Don't bring back the silent preview fallback.
3. **References decide consistency.** New kinds of reference go through `prompt-builder` candidates and `references.ts` priorities; keep characters first.
4. **Shot lengths are the agent's call (3–15 s).** Clamp with 3/15 (`SHOT_MIN`/`SHOT_MAX` in writer.ts), never a fixed default like 4 or 5.
5. **LLM calls go through `chat`/`chatJson`** (`llm.ts`) with an `agent` name, so per-agent models, reasoning passback, streaming and retries apply.
   Keep `reasoning_details` exactly as received. Use `visionModelFor()` for images and send local images as data URLs (see `checks.ts`).
6. **Log what matters** with `logActivity()` (it never throws). Publish UI refreshes with `publish(projectId, { type: "refresh", scope })`.
7. **Schema changes:** edit `prisma/schema.prisma`, run `npx prisma db push` and `npx prisma generate`, and update `project-state.ts` if the UI needs it.
8. **Client vs server:** files under `components/` are client components; never import `db`, `fs`, `ffmpeg` or `settings` into them.
   Shared constants must live in client-safe modules (`catalog.ts`, `library.ts`).
9. **Secrets:** API keys come from Settings (encrypted) or env. Never log them, never commit them, never put them in prompts.
10. **Per-project space:** files live under `storage/<projectId>/`; deleting a project deletes its folder. Write new outputs there, not elsewhere.
11. Match the surrounding style: TypeScript strict, small functions, comments only where the why isn't obvious, dark UI with the existing tokens.

## 9. Testing

- Always: `npx tsc --noEmit -p .` and `npm run build`.
- **Without spending credits:** set `PREVIEW_FALLBACK=1` (or turn Magnific off in Settings) so the preview renderer draws placeholders, and point
  the LLM at a mock or a cheap model. Script tests: create a project with `db.project.create`, call `services` functions (e.g. `writeFilm`,
  `buildAssetLibrary`, `queueContactSheets`, `startAutopilot`), set `process.env.REDIS_URL = ""` **before imports** so jobs run in-process,
  then poll until no `QUEUED`/`RUNNING` jobs remain and assert on the DB. Delete test projects and their `storage/<id>` folder afterwards.
- **Real end to end:** home page → **Check connections** (Qwen answers, sees images, Magnific connected, test image), then
  **Make a 10 s test clip**. Then a 30–60 s film on Autopilot.
- UI: run the app and look at the page you changed (Playwright works for screenshots).

## 10. Common tasks

| Task | Where |
|---|---|
| Add or change a model | `generation/catalog.ts` (or Settings → Sync from Magnific); defaults are `DEFAULT_*` there |
| Change what goes into a frame prompt | `prompt-builder.ts` |
| Change which references are sent | `references.ts` (`ROLE_ORDER`, caps) and `prompt-builder.ts` candidates |
| Change writing / pacing | `script/writer.ts` (prompts, `structureFor`, `fitDurations`) |
| Change story scoring | `script/score.ts` (`CRITERIA`, thresholds) |
| Add an autopilot stage | `worker/autopilot.ts` (`STAGES`, switch) + stage chips in `autopilot-view.tsx` |
| Add an agent or tool | `agents/definitions.ts`, `agents/tools.ts`; enum `AgentKind` in the schema for a new agent |
| Add a job type | enum `JobType`, `processors.ts` run() (or `longform.ts`), words in `activity.ts` `jobWords` |
| Add a generation backend | Settings → add an MCP server with a tool map (`generic-mcp.ts`), or a new adapter next to `magnific.ts` |
| New studio page | component in `components/studio/`, add to `View` in `store.tsx` and `NAV` in `studio.tsx` |

## 11. Troubleshooting

- **Frames are solid colours:** they came from the preview renderer. Connect Magnific (Settings or Check connections), then **Redo with Magnific**.
- **"Magnific is not signed in":** press Connect Magnific; make sure `APP_URL` matches the address in the browser.
- **LLM errors:** Settings → Validate model. A 400 mentioning reasoning makes `chat` retry without passed-back details, then without reasoning.
- **Jobs stuck:** check the Queue and Log tabs. Restarting the server requeues interrupted jobs. With Redis, make sure a worker is running.
- **Prisma "column does not exist":** run `npx prisma db push`.

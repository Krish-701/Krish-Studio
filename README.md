# Krish Studio — AI film production

Script → storyboard → clips → timeline with audio → MP4, in the browser. A Director agent and four
specialist sub-agents (Character Consistency, Mood & Tone, Generation Monitor, Audio) run the crew,
and every generation goes through MCP tool calls — Magnific MCP first, with any other MCP server as a fallback.

## Quick start

Requirements: Node 20+, PostgreSQL, ffmpeg (Redis optional).

```bash
cp .env.example .env              # set DATABASE_URL (and REDIS_URL if you use Redis)
docker compose up -d              # optional: local Postgres + Redis
npm install
npx prisma db push                # create tables
npm run db:seed                   # optional: demo film "The Last Lighthouse"
npm run dev                       # http://localhost:3000
```

Then open **Settings** and add:

| What | Where | Why |
|---|---|---|
| Magnific MCP access token | Settings → Generation backends → Magnific | Real images, video, voice, music, SFX, upscale, inpaint |
| OpenAI-compatible base URL + API key + model | Settings → AI assistant | Director chat, AI script breakdown, sub-agents. Use a vision model so consistency/mood checks can look at frames |

**OpenRouter + Qwen (or any reasoning model):** pick the *OpenRouter · Qwen 3.8 Flash* preset, paste your OpenRouter key, keep
**Reasoning** on and press **Validate model**. Reasoning sends `reasoning: { enabled: true }` and every assistant turn's
`reasoning_details` is stored verbatim and passed back unmodified, across tool calls and across conversation turns.
Validate runs the model through everything the studio needs and saves the result:

| Check | If it fails |
|---|---|
| Tool calling (call, result, answer) | Agents switch to prompted tools (tool calls written as JSON blocks) automatically |
| Reasoning and passing `reasoning_details` back | Agents run without reasoning |
| JSON output | JSON is pulled out of plain text |
| Image input | Set a **vision model** (e.g. a Qwen-VL model) for frame checks; without one, consistency and mood checks are rule-based |

Without either, the app still works end to end: scripts are broken down by the rule-based parser,
and the built-in **offline preview renderer** produces placeholder frames, Ken-Burns clips and tones so you can test the whole pipeline
for free. Turn it off in Settings to require real generations.

Production: `npm run build && npm start` (or the `Dockerfile`). With `REDIS_URL` set, jobs go through BullMQ —
run `npm run worker` as a separate process, or set `INLINE_WORKER=1` to run the worker inside Next.js.

## How it works

```
Browser (Next.js 15 / React 19 / Tailwind / Radix)
   │  REST + Server-Sent Events (/api/projects/:id/events)
Next.js API routes ── Prisma ── PostgreSQL
   │
   ├── Job queue (BullMQ on Redis, or in-process) ── worker/processors.ts
   │       └── generation/router.ts ── tries backends in priority order
   │              ├── magnific.ts     → https://mcp.magnific.com (images_generate, video_generate, audio_tts,
   │              │                     audio_music_generate, audio_sfx_generate, images_upscale, images_retouch,
   │              │                     creations_request_upload/finalize_upload, creations_wait)
   │              ├── generic-mcp.ts  → any MCP server (Veo, Kling, MiniMax, Wan…) via a JSON tool mapping
   │              └── mock.ts         → offline preview renderer (ffmpeg)
   ├── Storage: local disk (./storage) or S3 / Cloudflare R2
   └── Agents (OpenAI-compatible chat completions + tool calling)
          Director ──spawn_subagent──▶ Consistency · Mood & Tone · Monitor · Audio
```

### Character consistency
* Characters have front / 3/4 / side / back / full-body reference slots and a **lock**.
* `lib/prompt-builder.ts` assembles every request: shot prompt → framing → each character in frame
  (linked, or a locked character named in the text) with description **and reference images** → style lock (or per-shot override) → style reference images.
* References are uploaded to Magnific once and the creation id is cached on the asset (`providerRef`).
* Image-to-video starts from the approved frame; text-to-video passes character references instead.
* After every frame the Consistency agent compares it with the reference sheet (vision model) and logs findings with a one-click
  "apply fix & regenerate"; the Mood agent checks drift from the style lock.

### Shared project memory
Each project has one memory that the user and every agent share (**Memory** tab in the studio). Entries have a key, a category
(decision, preference, character, style, continuity, note), a version and who last changed them. Every agent gets the memory in its
system prompt and can `memory_search`, `memory_write` (replace or append, with optional version check) and `memory_delete`;
the Director, sub-agents and the automatic frame checks all see the same entries. Tell the Director “remember …” to add one yourself.

### Live progress
Each generation is a `Job` row (queued / running / succeeded / failed, progress %, current step). Workers publish every
change to an event bus (Redis pub/sub or in-memory) that streams to the browser over SSE. Failed jobs retry automatically
with exponential backoff (except non-retryable errors such as no credits), and can be retried per shot or all at once.

### Adding another MCP backend
Settings → Add MCP server, then map capabilities to tools, e.g.

```json
{
  "image": { "tool": "generate_image", "args": "{\"prompt\":\"{{prompt}}\",\"aspect_ratio\":\"{{aspect_ratio}}\",\"image_urls\":{{reference_urls}}}" },
  "video": { "tool": "generate_video", "args": "{\"prompt\":\"{{prompt}}\",\"image_url\":\"{{image_url}}\",\"duration\":{{duration}}}",
             "poll": { "tool": "get_task", "args": "{\"id\":\"{{id}}\"}" } }
}
```

Placeholders: `{{prompt}} {{negative_prompt}} {{aspect_ratio}} {{duration}} {{model}} {{image_url}} {{reference_urls}} {{text}} {{voice_id}} {{mask_url}} {{scale}} {{id}}`.
Reference images are passed as URLs, so set `APP_URL` to a publicly reachable address (or use S3/R2 with `S3_PUBLIC_URL`).

## Project layout

```
prisma/schema.prisma          data model (projects, scenes, shots, characters, assets, jobs, timeline, agents)
src/lib/generation/           MCP providers + router + model catalog
src/lib/agents/               agent definitions, tools, runner, automatic checks
src/lib/script/               PDF/FDX/Fountain extraction + screenplay parser + AI breakdown
src/lib/export/               MP4 (ffmpeg, transitions, audio mix) and storyboard PDF
src/worker/                   job processors, BullMQ worker, in-process worker
src/app/api/                  REST + SSE routes
src/components/studio/        studio UI (pipeline, storyboard canvas, shot editor, timeline, AI panel)
```

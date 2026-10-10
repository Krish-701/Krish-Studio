# Krish Studio — AI film production

Idea or script → storyboard → clips → timeline with audio → MP4, in the browser, from a 30-second ad to a 3-hour feature. A Director agent and four
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

### From 30 seconds to 3 hours
* **New film wizard** (Your film → Your story → Your look → Cast & film sets → Write it): pick a format (Ad, Short, Action,
  Music video, Series episode, Feature), a runtime from 15 s to 3 h on a log slider, frame, resolution and language; the
  "You'll get" panel shows the shots, scenes and sequences it will produce. Or import a PDF / Final Draft / Fountain script.
* **Long-form writer** (`lib/script/writer.ts`): Project → Act → Sequence (~3.5 min) → Scene → Shot. The outline is one call;
  each sequence is then written on its own (scenes, then a shots call per scene) with the film bible (synopsis, look, cast,
  sets, props, outline, memory) and the end of the previous sequence, so a 3-hour film is ~50 small calls, never one huge one.
  "Outline first" lets you review the acts and sequences before boarding. With no AI configured it writes a beat-sheet skeleton.
  Imported scripts get their scene headings turned into film sets and are grouped into sequences the same way.
* **Storyboard** is grouped by act, sequence and scene with coloured headers, an outline strip for the whole film, and batch
  actions per scope (contact sheets, frames, "Check the shots" → clips). Long films start collapsed so 2,000 shots stay fast.

### References: images, videos, audio, colour and contact sheets
Current models take far more than a start frame (Seedance 2.5: 30 image + 10 video + 10 audio + character / style / colour
references and 6-shot multi-prompt; Kling 3.0: character and product refs, start + end frames; Veo 3.1, Gemini Omni, Wan 2.7…).
`lib/generation/catalog.ts` records each model's limits and **Settings → Models & references → Sync from Magnific** pulls the
live list, so new models work without a code change. `lib/references.ts` plans every generation:
* candidates: storyboard frame, end frame, previous clip's last frame, each character's wardrobe look / angles / design sheet,
  the scene's film set plates, props, style images and style videos, a colour-palette swatch, a motion reference video, audio;
* it picks the mode (**Image → Video**, **References**, or **Text**; Auto chooses per model, e.g. Seedance can't mix keyframes
  and references, so identity shots go in reference mode with the frame as a reference), fills each reference type up to the
  model's limit round-robin across characters, and tells the model what each reference is ("image 1 = Mara front…");
* the shot editor's **Check what this clip will send** shows exactly which images go out and what was left out and why.

Consistency tools built on that:
* **AI design sheets**: a turnaround (front, three-quarter, side, back) drawn in one image and cut into angle references;
  **wardrobe looks** per character, picked per shot; **set plates** (4 views) and prop sheets. Characters, sets and props are
  registered in the Magnific library when available and referenced by id.
* **Contact sheets**: a scene's shots (up to 9) are drawn in one grid image, then cut into frames, so a scene shares light,
  set and faces, and it costs one call instead of nine. You can also upload your own contact sheet or turnaround and it is cut up.
* **Multi-shot scene clips**: consecutive shots of a scene in one call (Seedance 2.x / Kling 3.0), split back into shot clips.
* **Continuity** per shot: *cut*, *continuous* (starts on the previous clip's last frame, waits for it) or *extend* (continues
  the previous clip). Motion templates, colour presets (Natural, Moody, Vibrant, Vintage, Teal & Orange, Bleach Bypass,
  Golden Hour, Noir) and a motion reference video per shot.

### Export and editor hand-off
The MP4 export conforms each clip once into a cache (only changed clips re-encode), re-encodes just the transition frames, and joins everything without a second encode; audio is mixed in lanes, so a 3-hour cut
works. **Edit package** zips an FCPXML and EDL timeline, a production log (which model made each shot) and the media (or a
`download_media.sh`) for DaVinci Resolve and Final Cut (FCPXML) or Premiere (EDL: video and dissolves).

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
src/lib/script/               PDF/FDX/Fountain extraction + screenplay parser + AI breakdown + long-form writer
src/lib/references.ts         per-model reference planner (frames, characters, sets, style, colour, motion, audio)
src/lib/media.ts              last frames, palette swatches, grid cutting (ffmpeg)
src/lib/export/               MP4 (reels, transitions, audio mix), storyboard PDF, edit package (FCPXML / EDL / log)
src/worker/                   job processors, BullMQ worker, in-process worker
src/app/api/                  REST + SSE routes
src/components/studio/        studio UI (pipeline, storyboard canvas, shot editor, timeline, AI panel)
```

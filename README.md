# Krish Studio — AI film production

Idea or script → storyboard → clips → timeline with audio → MP4, in the browser, from a 30-second ad to a 3-hour feature. A Director (master) agent and five
specialist sub-agents (Script Doctor, Character Consistency, Mood & Tone, Generation Monitor, Audio) run the crew: they score your story,
improve it to 8.5/10, then make the whole film on autopilot,
and every generation goes through MCP tool calls — Magnific MCP first, with any other MCP server as a fallback.

## Run it

You can run it on your own computer and in the cloud at the same time; each install has its own database and project folders.

**On your computer** (Node 20+, ffmpeg, Docker Desktop):

```bash
git clone https://github.com/radhakrishnanp-lgtm/Krish-Studio && cd Krish-Studio
./scripts/start-local.sh                    # Windows: powershell -ExecutionPolicy Bypass -File scripts\start-local.ps1
```

It creates `.env`, starts Postgres and Redis in Docker, sets up the database and opens http://localhost:3000.
Put your keys in `.env` (or later in **Settings**): `LLM_API_KEY` (OpenRouter) and `MAGNIFIC_MCP_TOKEN` (Freepik / Magnific).

**In the cloud** (any Linux server with Docker):

```bash
git clone https://github.com/radhakrishnanp-lgtm/Krish-Studio && cd Krish-Studio
cp .env.example .env && nano .env           # keys, SETTINGS_SECRET, APP_URL=https://your-domain
./scripts/deploy-cloud.sh                   # docker compose up -d --build: app + Postgres + Redis
```

Run `git pull && ./scripts/deploy-cloud.sh` to update. The database and every project's folder live in Docker volumes and survive updates.
Put HTTPS in front (Caddy, Nginx or your cloud's load balancer) and set `APP_URL` to that address.

Manual setup still works: `cp .env.example .env`, `docker compose up -d postgres redis`, `npm install`, `npx prisma db push`, `npm run dev`.

### The AI that runs the crew

Default: **Qwen3.8 Omni Flash** on OpenRouter (`qwen/qwen3.8-omni-flash`, base URL `https://openrouter.ai/api/v1`), with
`reasoning: { enabled: true }`, streaming (`"stream": true`), and every assistant turn's `reasoning_details` stored and passed back unmodified,
across tool calls and conversation turns. It is multimodal, so it also checks frames. Change it any time in **Settings → AI assistant**
(presets for other OpenRouter models, OpenAI, Anthropic, Gemini, Ollama…) or per agent. **Validate model** tests tool calling, reasoning
pass-back, JSON and image input and saves the result:

| Check | If it fails |
|---|---|
| Tool calling (call, result, answer) | Agents switch to prompted tools (tool calls written as JSON blocks) automatically |
| Reasoning and passing `reasoning_details` back | Agents run without reasoning |
| JSON output | JSON is pulled out of plain text |
| Image input | Set a **vision model** for frame checks; without one, consistency and mood checks are rule-based |

### Models (Freepik / Magnific)

| Use | Default | Notes |
|---|---|---|
| Frames, design sheets, contact sheets | GPT Image 2.5 · Flare (`gpt-2-mini`, variant `flare`) | Ask the Director for any other image model |
| Video clips | Seedance 2.5 at 720p (`bytedance-seedance-pro-2.5`) | Up to 30 s, multi-shot, many references |
| Alternative video | Wan 3.0 Prime at 720p (`wan-3-0-prime`) | Beta in the catalog; up to 30 s, multi-shot |

The agents can list every model (`list_models`) and switch the project's defaults (`set_default_models`) when a story needs more references,
longer takes or sound. **Settings → Models → Sync from Magnific** pulls the live catalog.

Without either, the app still works end to end: scripts are broken down by the rule-based parser,
and the built-in **offline preview renderer** produces placeholder frames, Ken-Burns clips and tones so you can test the whole pipeline
for free. Turn it off in Settings to require real generations.

Production: `npm run build && npm start` (or the `Dockerfile`). With `REDIS_URL` set, jobs go through BullMQ —
run `npm run worker` as a separate process, or set `INLINE_WORKER=1` to run the worker inside Next.js.

## Autopilot: you set the runtime and the story, the agents make the film

1. **Story score.** The Script Doctor scores your idea, outline or script out of 10 on premise, structure, characters, conflict,
   visual storytelling, emotion, originality, fit to the runtime and clarity. **Under 6** it stops and tells you what to change.
   **6 to 8.5**: *Improve to 8.5+* rewrites the treatment round by round (keeping your idea, cast and brief) until it scores 8.5 or more.
2. **Full autopilot.** Once the story is ready: write (outline → scenes → shots) → character and set design sheets → frames →
   clips → voices and music → MP4 export, each stage starting when the previous one's jobs finish. Pause and resume any time.
3. **Shot lengths are the agent's call.** You only set the total runtime. For each scene the writer decides how many shots it needs and
   how long each runs, from 3 to 15 seconds (quick cuts for action, longer holds for emotion and reveals); the lengths are then fitted so the
   film lands on your runtime.
4. **Your brief.** On the Autopilot page (and the last wizard step) write your basic suggestions and prompt for the crew. Every agent reads it.
5. **It learns from you, per project.** Every message you send is checked for lasting preferences and corrections ("less handheld",
   "Maya never smiles", "shorter shots in fights"); they are saved as *lessons* in the project's memory, which every agent and the writer follow.
6. **Talk to it any time.** The Director (master agent) answers mid-production, changes the plan, and delegates to sub-agents:
   Script Doctor, Character Consistency, Mood & Tone, Generation Monitor and Audio. Ask it to study or edit anything.
7. **Progress updates and the Log tab.** The Director posts a short plain-language update in its chat every few minutes while work is running
   (`SUMMARY_INTERVAL_MIN`). The **Log** tab shows everything live: jobs started, finished, retried and failed, every agent message and tool call,
   automatic check findings, your messages and the summaries. Filter, export or clear it.

### Every project is its own workspace

Each project has its own folder, `storage/<projectId>/`, holding its media plus a readable snapshot that is refreshed as work happens:
`project.json` (settings, models, brief, story score, autopilot state), `story.md` (story, outline, scenes, every shot with its length),
`memory.md` (what the crew remembers, including the lessons you taught it) and `activity.log`. Deleting a project deletes its folder.

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

### Shot tools
**Rewrite with AI** rewrites a shot's image or motion prompt from the scene, cast, set and look (with an optional note such as
"make it rainier"). **Lip sync** re-syncs a clip's mouth movement to its voiceover (Magnific `video_speak`). **Use my own song**
in the wizard puts your track on the music lane, sets the runtime to its length and tells the writer to cut to it.
**Watch** plays the cut in story order with the script and dialogue beside it.

### Export and editor hand-off
The MP4 export conforms each clip once into a cache (only changed clips re-encode), re-encodes just the transition frames, and joins everything without a second encode; audio is mixed in lanes, so a 3-hour cut
works. **Edit package** zips an FCPXML and EDL timeline, a production log (which model made each shot) and the media (or a
`download_media.sh`): `timeline.fcpxml` for DaVinci Resolve and Final Cut, `timeline.xml` (FCP7 XML) for Premiere Pro, and
`timeline.edl`. Sound generated with a clip is kept in the mix and in the timelines.

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

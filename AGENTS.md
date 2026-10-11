# Krish Studio — agent notes

Read **PLAYBOOK.md** first: it maps the whole codebase, the film pipeline, the agents and the rules.

Essentials:
- Run locally: `docker compose up -d postgres redis`, `npm install`, `npx prisma db push`, `npm run dev` (http://localhost:3000). Then press **Check connections** on the home page.
- Before every commit: `npx tsc --noEmit -p .` and `npm run build` must pass. After a schema change: `npx prisma db push && npx prisma generate`.
- Long work is a Job (`enqueue()` in `src/lib/queue.ts`, handled in `src/worker/`). Never generate media inside a request handler.
- All media goes through `generate()` in `src/lib/generation/router.ts` with a request built in `src/lib/prompt-builder.ts`. Never fall back to the preview renderer silently.
- All LLM calls go through `chat`/`chatJson` in `src/lib/llm.ts`; keep `reasoning_details` exactly as received.
- Shot lengths are chosen by the agent, 3–15 s (`SHOT_MIN`/`SHOT_MAX` in `src/lib/script/writer.ts`). No fixed shot length.
- Never hardcode, log or commit API keys. Keys come from Settings (encrypted in the DB) or `.env` (gitignored).
- Client components (`src/components/`) must not import server modules (`db`, `fs`, `ffmpeg`, `settings`).

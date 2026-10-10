#!/usr/bin/env bash
# Run Krish Studio on your own computer and open it in the browser.
# Needs Node 20+, ffmpeg and Docker (for Postgres + Redis). Run from the repo folder: ./scripts/start-local.sh
set -e
cd "$(dirname "$0")/.."
[ -f .env ] || { cp .env.example .env; echo "Created .env. Put your OpenRouter key in LLM_API_KEY and your Magnific token in MAGNIFIC_MCP_TOKEN (or add them in Settings)."; }
docker compose up -d postgres redis
[ -d node_modules ] || npm install
npx prisma db push --skip-generate >/dev/null && npx prisma generate >/dev/null
URL="http://localhost:${PORT:-3000}"
( sleep 6; (command -v open >/dev/null && open "$URL") || (command -v xdg-open >/dev/null && xdg-open "$URL") || echo "Open $URL" ) &
npm run dev

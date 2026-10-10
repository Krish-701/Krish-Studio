# Run Krish Studio on Windows and open it in the browser.
# Needs Node 20+, ffmpeg on PATH and Docker Desktop. Run from the repo folder: powershell -ExecutionPolicy Bypass -File scripts\start-local.ps1
Set-Location (Join-Path $PSScriptRoot "..")
if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host "Created .env. Put your OpenRouter key in LLM_API_KEY and your Magnific token in MAGNIFIC_MCP_TOKEN (or add them in Settings)." }
docker compose up -d postgres redis
if (-not (Test-Path node_modules)) { npm install }
npx prisma db push --skip-generate | Out-Null
npx prisma generate | Out-Null
Start-Job { Start-Sleep 6; Start-Process "http://localhost:3000" } | Out-Null
npm run dev

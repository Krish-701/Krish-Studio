#!/usr/bin/env bash
# Run Krish Studio on a cloud server (any Linux VM with Docker: Hetzner, DigitalOcean, AWS EC2, GCP, Azure…).
#   git clone https://github.com/radhakrishnanp-lgtm/Krish-Studio && cd Krish-Studio
#   cp .env.example .env && nano .env      # LLM_API_KEY, MAGNIFIC_MCP_TOKEN, SETTINGS_SECRET, APP_URL=https://your-domain
#   ./scripts/deploy-cloud.sh
# Re-run it after `git pull` to update. Data (database + project folders) lives in Docker volumes and survives updates.
set -e
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "Create .env first: cp .env.example .env, then add your keys."; exit 1; }
grep -q '^SETTINGS_SECRET="change-me' .env && echo "Warning: set SETTINGS_SECRET in .env to a long random string."
docker compose up -d --build
echo "Krish Studio is starting on port ${PORT:-3000}. Point your domain (or http://SERVER_IP:${PORT:-3000}) at it; put HTTPS in front with Caddy or your cloud's load balancer."

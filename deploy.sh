#!/usr/bin/env bash
# Auto-deploy gate for ZollTax. Meant to be invoked remotely (by
# .github/workflows/deploy.yml over SSH) after every push, but only actually
# pulls/rebuilds when THIS server's own .env opts in — a push to GitHub never
# redeploys a server that hasn't explicitly set AUTO_DEPLOY=1 itself. Run from
# anywhere: it cd's to the repo root first.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
  echo "No $ENV_FILE on this server — auto-deploy not configured, skipping."
  exit 0
fi

AUTO_DEPLOY="$(grep -E '^AUTO_DEPLOY=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
if [ "$AUTO_DEPLOY" != "1" ] && [ "$AUTO_DEPLOY" != "true" ]; then
  echo "AUTO_DEPLOY not enabled in $ENV_FILE — skipping. (Set AUTO_DEPLOY=1 there to opt in.)"
  exit 0
fi

echo "AUTO_DEPLOY enabled — pulling and rebuilding..."
git pull --ff-only

compose_files=(-f docker-compose.yml)
if [ -f docker-compose.override.yml ]; then
  compose_files+=(-f docker-compose.override.yml)
fi

docker compose "${compose_files[@]}" --env-file "$ENV_FILE" up -d --build
echo "Deploy complete."

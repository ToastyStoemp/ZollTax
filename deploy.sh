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
echo "  was at: $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
git fetch --prune origin
git pull --ff-only
echo "  now at: $(git rev-parse --short HEAD 2>/dev/null || echo '?') — $(git log -1 --pretty=%s 2>/dev/null)"

compose_files=(-f docker-compose.yml)
if [ -f docker-compose.override.yml ]; then
  compose_files+=(-f docker-compose.override.yml)
fi

# --force-recreate guarantees the running container is replaced with the freshly
# built image, even when Compose would otherwise consider it unchanged (the usual
# "code pushed but the container didn't restart" trap). --remove-orphans cleans up
# any services dropped from the compose file.
# Record the deployed commit where the server can read it at boot. The container
# has no .git, so we write it to the mounted data volume (git is available here,
# on the host, right after the pull). The server reads <dataDir>/commit on start.
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then GIT_SHA="${GIT_SHA}-dirty"; fi
mkdir -p ./data
echo "$GIT_SHA" > ./data/commit
echo "  deployed commit: $GIT_SHA"
docker compose "${compose_files[@]}" --env-file "$ENV_FILE" up -d --build --force-recreate --remove-orphans
echo "Deploy complete."
docker compose "${compose_files[@]}" ps || true

#!/usr/bin/env bash
# Runs ON THE SERVER, as the deploy user, in /opt/ticket-tracker: starts the given image and checks that it is healthy.
# If it is not, the previous version is started again and the script fails, so a bad release never stays up.
#
#   ./deploy.sh ghcr.io/<owner>/<repo>:<sha> [--registry-login-stdin]
#
# DEPLOY_WAIT_SECONDS (default 120) is how long to wait for the new version to become healthy. With
# --registry-login-stdin the registry user and token are read from the first two lines of stdin (the private image
# needs them); the script logs out of the registry when it ends.
#
# deploy.yml copies this file, compose.yaml and the Caddyfile here and calls it over SSH after the migrations.
set -euo pipefail

cd "$(dirname "$0")"
image="${1:?usage: deploy.sh IMAGE}"
state=".deployed-image"
previous=""
[ -f "$state" ] && previous="$(cat "$state")"

[ -f .env ] || { echo "/opt/ticket-tracker/.env is missing: create it from .env.example first." >&2; exit 1; }

if [ "${2:-}" = "--registry-login-stdin" ]; then
  read -r registry_user
  read -r registry_token
  printf '%s' "$registry_token" | docker login ghcr.io -u "$registry_user" --password-stdin >/dev/null
  trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
fi

echo "Pulling $image"
docker pull "$image" # a failed pull leaves the running version untouched

app_state() {
  local id
  id="$(docker compose ps -q app 2>/dev/null || true)"
  [ -n "$id" ] || { echo "missing"; return; }
  docker inspect -f '{{if .State.Running}}{{if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}{{else}}stopped{{end}}' "$id"
}

wait_until_healthy() {
  local status
  for _ in $(seq 1 $(( ${DEPLOY_WAIT_SECONDS:-120} / 3 ))); do
    status="$(app_state)"
    [ "$status" = "healthy" ] && return 0
    sleep 3
  done
  echo "The application did not become healthy (last state: $status)." >&2
  return 1
}

export IMAGE="$image"
# Not fatal: an image that cannot even start must reach the check below, which rolls back.
docker compose up -d --remove-orphans || true

if wait_until_healthy; then
  echo "$image" > "$state"
  docker image prune -f >/dev/null
  echo "Deployed $image"
  exit 0
fi

echo "--- the application's last log lines:" >&2
docker compose logs --tail 40 app >&2 || true
if [ -n "$previous" ] && [ "$previous" != "$image" ]; then
  echo "Rolling back to $previous" >&2
  export IMAGE="$previous"
  docker compose up -d --remove-orphans || true
  wait_until_healthy && echo "The previous version is running again." >&2
else
  echo "There is no previous version to roll back to." >&2
fi
exit 1

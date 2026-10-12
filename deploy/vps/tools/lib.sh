#!/usr/bin/env bash
# Shared by the scripts in this directory; not run by itself. They run ON THE SERVER, as the deploy user.
# Everything goes through the `tools` service of /opt/ticket-tracker/compose.yaml: the image that is deployed,
# the server's .env (database, storage) and a memory limit of its own.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
state_file=".demo-tickets" # how many tickets the demo dataset has: verify and remove need the same number

die() { echo "error: $*" >&2; exit 1; }

require_server() {
  [ -f .env ] || die "$root/.env is missing."
  [ -f .deployed-image ] || die "nothing is deployed yet ($root/.deployed-image is missing): deploy first."
  command -v docker >/dev/null || die "docker is not installed."
  IMAGE="$(cat .deployed-image)"
  export IMAGE
}

# The size of a number like 200_000 or 200,000 or 200000.
parse_count() {
  local n="${1//[_, ]/}"
  [[ "$n" =~ ^[0-9]+$ ]] || die "not a number: $1"
  echo "$n"
}

# The number of tickets of the demo dataset: from --tickets, else the number remembered by seed.sh, else 2000.
default_tickets() {
  if [ -n "${1:-}" ]; then parse_count "$1"
  elif [ -f "$state_file" ]; then cat "$state_file"
  else echo 2000
  fi
}

# Memory for the one-off container. The dataset is built in memory: about 1 GB per 50 000 tickets, at least 1 GB.
# Sets TOOLS_MEMORY (the container's limit) and NODE_OPTIONS (Node's heap, a bit below the limit).
size_memory() {
  local tickets="$1" force="${2:-no}" need avail
  need=$(( tickets / 50 )); [ "$need" -ge 1024 ] || need=1024
  avail="$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || true)"
  avail="${avail:-0}"
  echo "memory for $tickets tickets: about ${need} MB (the server has ${avail} MB available)"
  if [ "$avail" -gt 0 ] && [ "$need" -gt "$avail" ] && [ "$force" != "yes" ]; then
    die "not enough memory for $tickets tickets. Use fewer tickets, add swap or RAM, or pass --force to try anyway."
  fi
  export TOOLS_MEMORY="${need}m"
  export NODE_OPTIONS="--max-old-space-size=$(( need * 85 / 100 ))"
}

# Reads a secret twice without echoing it and checks its length. Usage: ask_secret VARIABLE "what it is"
ask_secret() {
  local name="$1" what="$2" first second
  while true; do
    read -rsp "$what (12 to 128 characters): " first; echo
    [ "${#first}" -ge 12 ] && [ "${#first}" -le 128 ] || { echo "It must be 12 to 128 characters." >&2; continue; }
    read -rsp "Again: " second; echo
    [ "$first" = "$second" ] || { echo "They differ." >&2; continue; }
    printf -v "$name" '%s' "$first"
    export "${name?}"
    return 0
  done
}

# Asks for a phrase to be typed; --yes skips the question (for scripted runs).
confirm() {
  local phrase="$1" typed
  [ "${assume_yes:-no}" = "yes" ] && return 0
  read -rp "Type \"$phrase\" to continue: " typed
  [ "$typed" = "$phrase" ] || die "cancelled."
}

# Runs a command of the application's image in the `tools` container. The names given before `--` are
# environment variables passed through by name (their values never appear in a command line).
tool() {
  local pass=()
  while [ "$1" != "--" ]; do pass+=(-e "$1"); shift; done
  shift
  docker compose run --rm --no-deps -T "${pass[@]}" tools "$@"
}

#!/usr/bin/env bash
# Creates (or completes) the demo dataset in the database and the bucket this server is configured for.
#
#   ./tools/seed.sh [--tickets 2000] [--seed 42] [--force] [--yes] [--rotate-demo-passwords]
#
# --tickets N   the number of tickets, 500 to 1000000 (default 2000). Customers (15 %), comments (5 per ticket)
#               and files (10 %, at most 500) grow with it; accounts, groups and agents stay as they are.
#               Examples: 2000, 20000, 200_000.
# --seed N      the random seed; the same seed and number give the same data.
# --force       try even if the server seems to have too little memory.
# --yes         do not ask for the confirmation (for scripted runs).
#
# The application runs as APP_ENV=production, which refuses demo data. This script runs the seeding once with
# APP_ENV=demo, only for that command: the server's .env and the running application are not changed.
# The 17 demo accounts (admin1/2@example.test, agent01..15@example.test) get the two passwords you type here.
# Safe to repeat: records have fixed ids and are only added when missing. Remove with ./tools/remove.sh.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

tickets="" seed=42 force=no assume_yes=no extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --tickets) tickets="${2:?--tickets needs a value}"; shift 2 ;;
    --seed) seed="${2:?--seed needs a value}"; shift 2 ;;
    --force) force=yes; shift ;;
    --yes) assume_yes=yes; shift ;;
    --rotate-demo-passwords) extra+=("$1"); shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_server
tickets="$(default_tickets "$tickets")"
if [ -f "$state_file" ] && [ "$(cat "$state_file")" != "$tickets" ]; then
  die "a dataset of $(cat "$state_file") tickets was created here. Remove it first (./tools/remove.sh) or use --tickets $(cat "$state_file")."
fi
size_memory "$tickets" "$force"

echo
echo "This adds the demo data ($tickets tickets) to the database and storage of $(grep -E '^PUBLIC_URL=' .env | cut -d= -f2-)."
confirm "seed $tickets"

ask_secret SEED_ADMIN_PASSWORD "Password for the 2 demo administrators"
ask_secret SEED_AGENT_PASSWORD "Password for the 15 demo agents"
echo "$tickets" > "$state_file"
tool SEED_ADMIN_PASSWORD SEED_AGENT_PASSWORD APP_ENV=demo NODE_OPTIONS -- \
  node dist/cli/seed-demo.js --tickets "$tickets" --seed "$seed" "${extra[@]}"
echo
echo "Next: ./tools/verify.sh"

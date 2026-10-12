#!/usr/bin/env bash
# Removes the demo dataset: exactly its own rows (by their fixed ids) and files, nothing else. Real accounts,
# tickets and customers are not touched. If other records still refer to demo data (for example a real ticket in
# a demo group), nothing is deleted and the script says so.
#
#   ./tools/remove.sh [--tickets N] [--dry-run] [--force] [--yes]
#
# --dry-run     only print what would be removed.
# N is the number the dataset was created with; by default the one seed.sh remembered (else 2000).
# To start over: ./tools/remove.sh, then ./tools/seed.sh.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

tickets="" force=no assume_yes=no dry=()
while [ $# -gt 0 ]; do
  case "$1" in
    --tickets) tickets="${2:?--tickets needs a value}"; shift 2 ;;
    --dry-run) dry=(--dry-run); shift ;;
    --force) force=yes; shift ;;
    --yes) assume_yes=yes; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_server
tickets="$(default_tickets "$tickets")"
size_memory "$tickets" "$force"

# The command refuses production, so it is run once as APP_ENV=demo (see seed.sh); it also needs two explicit consents.
run() {
  tool APP_ENV=demo ALLOW_DEMO_RESET=true NODE_OPTIONS -- \
    node dist/cli/seed-reset.js --dataset takehome-demo --confirm takehome-demo --delete-only --tickets "$tickets" "$@"
}

echo "First, what would be removed:"
run --dry-run
[ ${#dry[@]} -eq 0 ] || exit 0

echo
echo "This deletes the demo data ($tickets tickets) from the database and storage of $(grep -E '^PUBLIC_URL=' .env | cut -d= -f2-)."
confirm "remove demo data"
run
rm -f "$state_file"

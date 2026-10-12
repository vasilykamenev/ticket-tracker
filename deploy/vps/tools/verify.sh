#!/usr/bin/env bash
# Checks the demo dataset: counts, references, workflow, dates and that every file is in the bucket.
#
#   ./tools/verify.sh [--tickets N] [--force]
#
# N is the number the dataset was created with; by default the one seed.sh remembered (else 2000).
# Exits with 1 and lists the problems if something is wrong.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

tickets="" force=no
while [ $# -gt 0 ]; do
  case "$1" in
    --tickets) tickets="${2:?--tickets needs a value}"; shift 2 ;;
    --force) force=yes; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_server
tickets="$(default_tickets "$tickets")"
size_memory "$tickets" "$force"
tool APP_ENV=demo NODE_OPTIONS -- node dist/cli/seed-verify.js --tickets "$tickets"

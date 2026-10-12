#!/usr/bin/env bash
# Creates an administrator account (the first one, or another). The password is asked for, hidden, and never
# appears in a command line or in the shell history.
#
#   ./tools/admin-create.sh --email you@example.com [--name "Your Name"]
#
# An existing e-mail is left untouched ("already exists; nothing changed").
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

email="" name=""
while [ $# -gt 0 ]; do
  case "$1" in
    --email) email="${2:?--email needs a value}"; shift 2 ;;
    --name) name="${2:?--name needs a value}"; shift 2 ;;
    *) die "unknown argument: $1 (usage: admin-create.sh --email you@example.com [--name \"Your Name\"])" ;;
  esac
done
[ -n "$email" ] || die "--email is required."

require_server
ask_secret ADMIN_PASSWORD "Password for $email"
args=(--email "$email")
[ -z "$name" ] || args+=(--name "$name")
tool ADMIN_PASSWORD -- node dist/cli/admin-create.js "${args[@]}"

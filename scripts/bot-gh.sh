#!/usr/bin/env bash
# Run any `gh` command with GitHub App bot authentication.
#
# Usage: ./scripts/bot-gh.sh pr create --title "..." --body "..."
# Usage: ./scripts/bot-gh.sh pr edit 117 --body "..."
# Usage: ./scripts/bot-gh.sh pr comment 117 --body "..."
# Usage: ./scripts/bot-gh.sh pr ready 117
#
# `pr create` delegates to the package-backed delivery command so branch push
# and PR creation use one installation identity. Other commands retain the
# legacy bot-authenticated `gh` path below.
#
# Never use `gh` directly for agent-delivered PR work.
# The gh CLI defaults to the human OAuth identity.

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "${1:-}" == "pr" ]] && [[ "${2:-}" == "create" ]]; then
  shift 2
  exec node "${repo_root}/scripts/bot-delivery-compat.js" "$@"
fi

# --- Pre-flight checks ---

if ! command -v node &> /dev/null; then
  echo "Error: node is required but not installed." >&2
  exit 1
fi

if ! command -v gh &> /dev/null; then
  echo "Error: gh CLI is required but not installed." >&2
  exit 1
fi

# The Node launcher keeps the installation token in memory and injects it only
# into the gh child environment. It resolves public identity, repository, and
# installation selection without sourcing arbitrary environment files.
exec node "${repo_root}/scripts/bot-gh-command.js" "$@"

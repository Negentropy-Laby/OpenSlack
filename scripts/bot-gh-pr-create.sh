#!/usr/bin/env bash
# Create a GitHub Pull Request with bot authentication.
#
# Usage: ./scripts/bot-gh-pr-create.sh --title "feat: add new feature" --body "..." --base main --head feature-branch
# All arguments are forwarded to `gh pr create`.
#
# This wrapper ensures the PR is opened by the configured bot identity
# (openslack-agent-operator[bot]), not the human gh CLI OAuth identity.
#
# NEVER use `gh pr create` directly for agent-delivered work.

set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
"${script_dir}/bot-gh.sh" pr create "$@"

pr_number=$("${script_dir}/bot-gh.sh" pr view --json number --jq '.number')
if [[ -z "$pr_number" ]]; then
  echo "Error: Could not resolve the newly-created PR number for workflow governance." >&2
  exit 1
fi
if ! command -v bun &> /dev/null; then
  echo "Error: bun is required to prepare workflow governance evidence." >&2
  exit 1
fi
repo_root="$(cd "${script_dir}/.." && pwd)"
export OPENSLACK_GITHUB_APP_ID="${OPENSLACK_GITHUB_APP_ID:-3728623}"
export OPENSLACK_GITHUB_APP_INSTALLATION_ID="${OPENSLACK_GITHUB_APP_INSTALLATION_ID:-135500236}"
if [[ -z "${OPENSLACK_GITHUB_APP_PRIVATE_KEY:-}" ]]; then
  export OPENSLACK_GITHUB_APP_PRIVATE_KEY="$(<"${repo_root}/.openslack.local/github-app.pem")"
fi
unset GITHUB_TOKEN GH_TOKEN 2>/dev/null || true
(cd "$repo_root" && bun run openslack pr workflow-governance "$pr_number")

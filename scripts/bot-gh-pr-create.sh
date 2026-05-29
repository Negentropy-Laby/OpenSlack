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

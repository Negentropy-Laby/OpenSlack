#!/usr/bin/env bash
# Run any `gh` command with GitHub App bot authentication.
#
# Usage: ./scripts/bot-gh.sh pr create --title "..." --body "..."
# Usage: ./scripts/bot-gh.sh pr edit 117 --body "..."
# Usage: ./scripts/bot-gh.sh pr comment 117 --body "..."
#
# This wrapper:
# 1. Generates a GitHub App installation token via bot-gh-token.js
# 2. Unsets GITHUB_TOKEN to prevent silent fallback to a human PAT
# 3. Sets GH_TOKEN so gh CLI authenticates as the bot
# 4. Forwards all arguments to `gh`
# 5. For `gh pr create`, verifies the PR author is the bot (guardrail)
#
# Never use `gh` directly for agent-delivered PR work.
# The gh CLI defaults to the human OAuth identity.

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

# --- Pre-flight checks ---

if ! command -v node &> /dev/null; then
  echo "Error: node is required but not installed." >&2
  exit 1
fi

if ! command -v gh &> /dev/null; then
  echo "Error: gh CLI is required but not installed." >&2
  exit 1
fi

pem_path="${repo_root}/.openslack.local/github-app.pem"
if [[ -z "${OPENSLACK_GITHUB_APP_PRIVATE_KEY:-}" ]] && [[ ! -f "$pem_path" ]]; then
  echo "Error: No GitHub App private key found." >&2
  echo "  Set OPENSLACK_GITHUB_APP_PRIVATE_KEY or place PEM at: $pem_path" >&2
  exit 1
fi

# --- Generate bot token ---

token="$(cd "$repo_root" && node scripts/bot-gh-token.js)"
if [[ -z "$token" ]]; then
  echo "Error: Failed to generate GitHub App installation token." >&2
  exit 1
fi

# --- Prevent human PAT fallback ---
# Remove GITHUB_TOKEN from this process so gh cannot silently fall back
# to a human personal access token.
unset GITHUB_TOKEN 2>/dev/null || true

# --- Execute gh with bot auth ---

GH_TOKEN="$token" gh "$@"
gh_exit=$?

# --- Post-creation guardrail for `gh pr create` ---
# If this was a PR creation, verify the author is the bot.
# This catches cases where the token was somehow overridden
# or the gh CLI fell back to a different identity.

if [[ $gh_exit -eq 0 ]] && [[ "${1:-}" == "pr" ]] && [[ "${2:-}" == "create" ]]; then
  # Find the most recently created open PR by this branch
  sleep 2  # Allow GitHub to index the new PR
  pr_number=$(GH_TOKEN="$token" gh pr view --json number --jq '.number' 2>/dev/null || true)
  if [[ -n "$pr_number" ]]; then
    author=$(GH_TOKEN="$token" gh pr view "$pr_number" --json author --jq '.author.login' 2>/dev/null || true)
    if [[ -n "$author" ]] && [[ "$author" != "openslack-agent-operator" ]] && [[ "$author" != "openslack-agent-operator[bot]" ]]; then
      echo "" >&2
      echo "WARNING: PR #$pr_number was created under identity '$author' instead of the bot." >&2
      echo "  Close this PR and recreate it using the bot-auth wrapper." >&2
      echo "  See AGENTS.md 'Bot-Authenticated PR Creation' for details." >&2
      exit 1
    fi
  fi
fi

exit $gh_exit

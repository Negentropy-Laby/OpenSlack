#!/usr/bin/env bash
# Genesis Rollback — revert to last known good state.
# Depends only on: bash, python3, git. No OpenSlack runtime required.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -W 2>/dev/null || pwd)"
LKG="$ROOT/.openslack/self/release_channels/last_known_good.yaml"

echo "=== Genesis Rollback ==="

if [ ! -f "$LKG" ]; then
  echo "ERROR: No last_known_good.yaml found at $LKG"
  echo "Cannot rollback without a known-good reference."
  exit 1
fi

STABLE_SHA=$(python -c "import yaml; print(yaml.safe_load(open('$LKG', encoding='utf-8'))['stable_sha'])" 2>/dev/null || echo "")
if [ -z "$STABLE_SHA" ]; then
  echo "ERROR: Could not read stable_sha from last_known_good.yaml"
  exit 1
fi

STABLE_VERSION=$(python -c "import yaml; print(yaml.safe_load(open('$LKG', encoding='utf-8')).get('stable_version', 'unknown'))" 2>/dev/null || echo "unknown")
echo "Last known good: $STABLE_SHA (v$STABLE_VERSION)"
echo "Current HEAD:    $(cd "$ROOT" && git rev-parse HEAD)"

echo ""
echo "Creating revert commit from HEAD back to $STABLE_SHA..."
cd "$ROOT"
if git revert --no-edit "$STABLE_SHA"..HEAD; then
  echo ""
  echo "Rollback revert commit created. Review with: git show HEAD"
  echo "To apply: manually push or merge the revert."
  echo ""
  echo "=== Genesis Rollback: COMPLETE ==="
else
  echo ""
  echo "ERROR: git revert failed. You may need to resolve conflicts manually."
  exit 1
fi

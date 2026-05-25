#!/usr/bin/env bash
# Genesis Validate — check OpenSlack repo integrity without any OpenSlack runtime dependency.
# Runs on: bash, python (with PyYAML), git (no node, no pnpm, no OpenSlack packages).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -W 2>/dev/null || pwd)"

FAILED=0

echo "=== Genesis Validate ==="
echo "ROOT: $ROOT"
echo ""

# 1. openslack.yaml exists and is valid YAML
echo -n "[1/5] openslack.yaml ... "
if [ ! -f "$ROOT/openslack.yaml" ]; then
  echo "FAIL (not found)"
  FAILED=1
else
  if python -c "import yaml; yaml.safe_load(open('$ROOT/openslack.yaml', encoding='utf-8'))" 2>/dev/null; then
    echo "PASS"
  else
    echo "FAIL (invalid YAML)"
    FAILED=1
  fi
fi

# 2. .openslack/ directory structure exists
echo -n "[2/5] .openslack/ state directory ... "
MISSING_DIRS=""
for dir in .openslack/self .openslack/policies .openslack/agents/registry .openslack/tasks .openslack/leases .openslack/audit; do
  if [ ! -d "$ROOT/$dir" ]; then
    MISSING_DIRS="$MISSING_DIRS $dir"
  fi
done
if [ -n "$MISSING_DIRS" ]; then
  echo "FAIL (missing:$MISSING_DIRS)"
  FAILED=1
else
  echo "PASS"
fi

# 3. Constitution exists
echo -n "[3/5] constitution.md ... "
if [ -f "$ROOT/.openslack/self/constitution.md" ]; then
  echo "PASS"
else
  echo "FAIL (missing — create .openslack/self/constitution.md)"
  FAILED=1
fi

# 4. No secrets leaked
echo -n "[4/5] secret scan ... "
SECRETS_FOUND=$(grep -rlE '(sk-[a-zA-Z0-9]{20,})|(-----BEGIN (RSA|EC|OPENSSH|DSA) PRIVATE KEY-----)' "$ROOT" \
  --exclude-dir=.git \
  --exclude-dir=node_modules \
  --exclude-dir=.openslack.local \
  --exclude-dir=dist \
  --exclude-dir=__tests__ 2>/dev/null \
  | grep -vE '/docs/security/collaboration-audit\.md$' || true)
if [ -n "$SECRETS_FOUND" ]; then
  echo "FAIL (potential secret in: $SECRETS_FOUND)"
  FAILED=1
else
  echo "PASS"
fi

# 5. Git repository exists
echo -n "[5/5] git repository ... "
if [ -d "$ROOT/.git" ]; then
  echo "PASS"
else
  echo "FAIL (not a git repository)"
  FAILED=1
fi

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "=== Genesis Validate: PASS ==="
  exit 0
else
  echo "=== Genesis Validate: FAIL ($FAILED checks failed) ==="
  exit 1
fi

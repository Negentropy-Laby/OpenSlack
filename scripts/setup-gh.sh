#!/usr/bin/env bash
# setup-gh.sh — Auto-install GitHub CLI and configure OpenSlack runtime environment.
# Supports: winget (Windows), brew (macOS), apt (Debian/Ubuntu), dnf (Fedora), apk (Alpine), direct download.
# Usage: bash scripts/setup-gh.sh [--auth] [--token <token>]
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

AUTH_FLAG=false
CUSTOM_TOKEN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --auth) AUTH_FLAG=true; shift ;;
    --token) CUSTOM_TOKEN="$2"; shift 2 ;;
    *) shift ;;
  esac
done

echo "=== OpenSlack GitHub CLI Setup ==="
echo ""

# --- Step 1: Detect and install gh ---
if command -v gh &>/dev/null; then
  log_pass "GitHub CLI found: $(gh --version | head -1)"
else
  log_warn "GitHub CLI not found. Attempting auto-install..."

  if command -v winget &>/dev/null; then
    echo "  Installing via winget..."
    winget install --id GitHub.cli --accept-source-agreements --accept-package-agreements 2>&1 || true
  elif command -v brew &>/dev/null; then
    echo "  Installing via brew..."
    brew install gh || true
  elif command -v apt-get &>/dev/null; then
    echo "  Installing via apt..."
    type -p curl >/dev/null || (apt-get update && apt-get install curl -y)
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null
    apt-get update && apt-get install gh -y || true
  elif command -v dnf &>/dev/null; then
    echo "  Installing via dnf..."
    dnf install 'dnf-command(config-manager)' -y || true
    dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo || true
    dnf install gh -y || true
  elif command -v apk &>/dev/null; then
    echo "  Installing via apk..."
    apk add github-cli || true
  else
    # Direct download fallback
    echo "  Downloading directly from GitHub..."
    OS="linux"
    ARCH="amd64"
    [[ "$(uname -s)" == "Darwin" ]] && OS="macOS"
    [[ "$(uname -m)" == "aarch64" ]] && ARCH="arm64"
    if [[ "$(uname -s)" == *"MINGW"* ]] || [[ "$(uname -s)" == *"MSYS"* ]]; then
      OS="windows"
      ARCH="amd64"
    fi
    GH_VERSION="2.63.2"
    URL="https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_${OS}_${ARCH}"
    if [[ "$OS" == "windows" ]]; then URL="${URL}.zip"; else URL="${URL}.tar.gz"; fi
    TMP_DIR=$(mktemp -d)
    curl -sL "$URL" -o "$TMP_DIR/gh_archive"
    if [[ "$OS" == "windows" ]]; then
      unzip -q "$TMP_DIR/gh_archive" -d "$TMP_DIR"
      mkdir -p "$HOME/.local/bin"
      cp "$TMP_DIR/gh_${GH_VERSION}_${OS}_${ARCH}/bin/gh.exe" "$HOME/.local/bin/"
    else
      tar -xzf "$TMP_DIR/gh_archive" -C "$TMP_DIR"
      mkdir -p "$HOME/.local/bin"
      cp "$TMP_DIR/gh_${GH_VERSION}_${OS}_${ARCH}/bin/gh" "$HOME/.local/bin/"
    fi
    rm -rf "$TMP_DIR"
    export PATH="$HOME/.local/bin:$PATH"
  fi

  if command -v gh &>/dev/null; then
    log_pass "GitHub CLI installed: $(gh --version | head -1)"
  else
    log_fail "Could not install GitHub CLI. Install manually: https://github.com/cli/cli"
    exit 1
  fi
fi

# --- Step 2: Authenticate ---
if [ "$AUTH_FLAG" = true ] || [ -n "$CUSTOM_TOKEN" ]; then
  if gh auth status &>/dev/null; then
    log_pass "GitHub CLI already authenticated as: $(gh auth status 2>&1 | grep -o 'Logged in to.*' | head -1)"
  else
    if [ -n "$CUSTOM_TOKEN" ]; then
      echo "$CUSTOM_TOKEN" | gh auth login --with-token
      log_pass "Authenticated with provided token."
    else
      echo ""
      echo "Opening browser for GitHub authentication..."
      echo "Required scopes: repo, read:project, project"
      gh auth login --hostname github.com --web --scopes repo,read:project,project
    fi
  fi
fi

# --- Step 3: Verify scopes ---
if gh auth status &>/dev/null; then
  SCOPES=$(gh auth status 2>&1 | grep -o "Token scopes:.*" | sed 's/Token scopes: //' || echo "")
  if echo "$SCOPES" | grep -q "project"; then
    log_pass "Token has project scope."
  else
    log_warn "Token missing 'project' scope. Project v2 features require it."
    log_warn "Run: gh auth refresh -h github.com -s project"
  fi
else
  log_warn "Not authenticated. Run: gh auth login --scopes repo,read:project,project"
fi

echo ""
echo "=== Setup complete ==="
echo "Next: openslack github doctor    # verify setup"
echo "      openslack github project-init  # auto-create Project v2"

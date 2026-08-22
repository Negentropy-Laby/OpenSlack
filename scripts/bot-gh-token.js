#!/usr/bin/env node
// CWD-independent CommonJS bridge into the package-owned bot authentication.
// This file intentionally contains no JWT, HTTP, repository, or config parser.

const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { tsImport } = require('tsx/esm/api');

const repoRoot = resolve(__dirname, '..');
const moduleUrl = pathToFileURL(resolve(repoRoot, 'packages', 'github', 'src', 'bot-auth.ts')).href;
const parentURL = pathToFileURL(__filename).href;
let modulePromise;

function loadBotAuth() {
  modulePromise ??= tsImport(moduleUrl, { parentURL });
  return modulePromise;
}

async function withConfiguredBotInstallation(options, consumer) {
  const auth = await loadBotAuth();
  return auth.withBotGitHubInstallation({ repoRoot, ...options }, consumer);
}

async function withConfiguredBotLaunchIdentity(options, consumer) {
  const auth = await loadBotAuth();
  return auth.withBotGitHubLaunchIdentity({ repoRoot, ...options }, consumer);
}

async function acquireConfiguredInstallationCredentials(options = {}) {
  const auth = await loadBotAuth();
  return auth.acquireBotGitHubToken({ repoRoot, ...options });
}

async function listConfiguredInstallations(options = {}) {
  const auth = await loadBotAuth();
  return auth.listConfiguredBotGitHubInstallations({ repoRoot, ...options });
}

function formatBotAuthError(error) {
  if (
    error &&
    typeof error === 'object' &&
    typeof error.code === 'string' &&
    typeof error.message === 'string' &&
    /^BOT_[A-Z_]+$/u.test(error.code)
  ) {
    return `${error.code}: ${error.message}`;
  }
  return 'BOT_AUTH_FAILED: GitHub App authentication failed safely.';
}

module.exports = {
  acquireConfiguredInstallationCredentials,
  formatBotAuthError,
  listConfiguredInstallations,
  loadBotAuth,
  withConfiguredBotInstallation,
  withConfiguredBotLaunchIdentity,
};

if (require.main === module) {
  process.stderr.write(
    'Direct token output is disabled. Use bot-gh.sh, bot-gh.ps1, or openslack delivery publish.\n',
  );
  process.exitCode = 2;
}

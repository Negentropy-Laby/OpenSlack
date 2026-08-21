#!/usr/bin/env node
// Launch OpenSlack with one dynamically selected GitHub App installation.
// The App key remains in this resolver process. Its direct OpenSlack child gets
// only one bounded installation-token lease, matching the delivery contract.

const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const { acquireConfiguredInstallationCredentials } = require('./bot-gh-token.js');

const repoRoot = resolve(__dirname, '..');

function createChildEnvironment(credentials) {
  const env = {};
  for (const key of [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.OPENSLACK_GITHUB_AUTH_MODE = 'app';
  env.OPENSLACK_GITHUB_APP_ID = credentials.appId;
  env.OPENSLACK_GITHUB_APP_INSTALLATION_ID = credentials.installationId;
  env.OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN = credentials.value;
  env.OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN_EXPIRES_AT = credentials.expiresAt;
  env.OPENSLACK_GITHUB_APP_INSTALLATION_PERMISSIONS = JSON.stringify(credentials.permissions);
  env.OPENSLACK_GITHUB_APP_SLUG = credentials.appSlug;
  env.GITHUB_OWNER = credentials.owner;
  env.GITHUB_REPO = credentials.repo;
  return env;
}

async function main(args = process.argv.slice(2)) {
  let resolved;
  try {
    resolved = await acquireConfiguredInstallationCredentials({ args, cwd: process.cwd() });
  } catch {
    process.stderr.write('GitHub App installation authentication failed.\n');
    return 1;
  }
  const env = createChildEnvironment(resolved);
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts'), ...args],
    { cwd: process.cwd(), env, stdio: 'inherit', windowsHide: true },
  );
  resolved = undefined;
  if (result.error) {
    process.stderr.write('Could not start OpenSlack with GitHub App authentication.\n');
    return 1;
  }
  return result.status ?? 1;
}

module.exports = { createChildEnvironment };

if (require.main === module) void main().then((status) => process.exit(status));

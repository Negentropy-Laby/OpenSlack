#!/usr/bin/env node
// Compatibility adapter for the historical `gh pr create` wrapper surface.
// It maps arguments into the package-backed `openslack delivery publish` path.

const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { acquireConfiguredInstallationCredentials } = require('./bot-gh-token.js');

const repoRoot = resolve(__dirname, '..');
const valueFlags = new Map([
  ['--title', '--title'],
  ['--body', '--body'],
  ['--body-file', '--body-file'],
  ['--head', '--branch'],
  ['--branch', '--branch'],
  ['--repo', '--repo'],
  ['--remote', '--remote'],
]);

function mapCreateArgs(args) {
  const mapped = ['delivery', 'publish'];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--draft') continue;
    if (arg === '--base') {
      const base = args[index + 1];
      if (base === undefined) {
        throw new Error('Unsupported bot PR compatibility argument: --base');
      }
      if (base !== 'main') {
        throw new Error(
          `DELIVERY_BASE_FORBIDDEN: pull requests must target "main"; received "${base}".`,
        );
      }
      index += 1;
      continue;
    }
    const mappedFlag = valueFlags.get(arg);
    if (!mappedFlag || index + 1 >= args.length) {
      throw new Error(`Unsupported bot PR compatibility argument: ${arg}`);
    }
    mapped.push(mappedFlag, args[index + 1]);
    index += 1;
  }
  return mapped;
}

async function main(args = process.argv.slice(2)) {
  let mapped;
  try {
    mapped = mapCreateArgs(args);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }

  const env = createChildEnvironment();
  let credentials;
  try {
    credentials = await acquireConfiguredInstallationCredentials();
  } catch {
    process.stderr.write('GitHub App installation authentication failed.\n');
    return 1;
  }
  env.OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN = credentials.value;
  env.OPENSLACK_GITHUB_APP_INSTALLATION_ID = credentials.installationId;
  env.OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN_EXPIRES_AT = credentials.expiresAt;
  env.OPENSLACK_GITHUB_APP_INSTALLATION_PERMISSIONS = JSON.stringify(credentials.permissions);

  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts'), ...mapped],
    { cwd: process.cwd(), env, stdio: 'inherit', windowsHide: true },
  );
  if (result.error) {
    process.stderr.write('Could not start the governed delivery command.\n');
    return 1;
  }
  credentials = undefined;
  return result.status ?? 1;
}

module.exports = { mapCreateArgs };

function createChildEnvironment() {
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
  return env;
}

if (require.main === module) void main().then((status) => process.exit(status));

#!/usr/bin/env node
// Launch a non-create `gh` command with a child-only installation token.

const { spawnSync } = require('node:child_process');
const { acquireConfiguredInstallationToken } = require('./bot-gh-token.js');

async function main(args = process.argv.slice(2)) {
  if (!isAllowedCommand(args)) {
    process.stderr.write('The bot gh wrapper permits only pr edit, pr comment, and pr ready.\n');
    return 2;
  }
  let token;
  try {
    token = await acquireConfiguredInstallationToken();
  } catch {
    process.stderr.write('GitHub App installation authentication failed.\n');
    return 1;
  }
  const env = createGhEnvironment(token);
  const result = spawnSync('gh', args, {
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  token = undefined;
  if (result.error) {
    process.stderr.write('Could not start gh with GitHub App authentication.\n');
    return 1;
  }
  return result.status ?? 1;
}

function isAllowedCommand(args) {
  return args[0] === 'pr' && (args[1] === 'edit' || args[1] === 'comment' || args[1] === 'ready');
}

function createGhEnvironment(token) {
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
  env.GH_TOKEN = token;
  env.GH_PAGER = 'cat';
  env.PAGER = 'cat';
  env.GH_PROMPT_DISABLED = '1';
  env.GH_EDITOR = 'false';
  env.GH_BROWSER = 'false';
  env.NO_COLOR = '1';
  return env;
}

module.exports = { isAllowedCommand };

if (require.main === module) void main().then((status) => process.exit(status));

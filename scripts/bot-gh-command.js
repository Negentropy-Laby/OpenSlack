#!/usr/bin/env node
// Launch an allowlisted non-create `gh` command with a child-only token.

const { spawnSync } = require('node:child_process');
const {
  acquireConfiguredInstallationCredentials,
  formatBotAuthError,
} = require('./bot-gh-token.js');
const { createGhEnvironment } = require('./bot-launch-environment.js');

async function main(args = process.argv.slice(2), dependencies = {}) {
  if (!isAllowedCommand(args)) {
    process.stderr.write(
      'BOT_GH_COMMAND_FORBIDDEN: only pr edit, pr comment, pr ready, and issue edit are allowed.\n',
    );
    return 2;
  }
  let credentials;
  try {
    credentials = await (dependencies.acquire ?? acquireConfiguredInstallationCredentials)({
      ghArgs: args,
      useGhRepoEnvironment: true,
      cwd: dependencies.cwd ?? process.cwd(),
      onDiagnostic: dependencies.onDiagnostic ?? writeDiagnostic,
    });
  } catch (error) {
    process.stderr.write(`${formatBotAuthError(error)}\n`);
    return 1;
  }
  const env = createGhEnvironment(credentials, dependencies.env ?? process.env);
  const result = (dependencies.spawn ?? spawnSync)('gh', args, {
    cwd: dependencies.cwd ?? process.cwd(),
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    process.stderr.write('BOT_GH_LAUNCH_FAILED: could not start gh.\n');
    return 1;
  }
  return result.status ?? 1;
}

function isAllowedCommand(args) {
  return (
    (args[0] === 'pr' && (args[1] === 'edit' || args[1] === 'comment' || args[1] === 'ready')) ||
    (args[0] === 'issue' && args[1] === 'edit')
  );
}

function writeDiagnostic(diagnostic) {
  process.stderr.write(`${diagnostic.code}: ${diagnostic.message}\n`);
}

module.exports = { createGhEnvironment, isAllowedCommand, main };

if (require.main === module)
  void main().then((status) => {
    process.exitCode = status;
  });

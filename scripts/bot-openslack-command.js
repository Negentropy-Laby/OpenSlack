#!/usr/bin/env node
// Launch OpenSlack with refreshable GitHub App credentials. The child inherits
// the caller environment except for human tokens and wrapper-managed fields.

const { spawnSync } = require('node:child_process');
const { formatBotAuthError, withConfiguredBotLaunchIdentity } = require('./bot-gh-token.js');
const { createOpenSlackEnvironment, openSlackInvocation } = require('./bot-launch-environment.js');

async function main(args = process.argv.slice(2), dependencies = {}) {
  try {
    return await (dependencies.withIdentity ?? withConfiguredBotLaunchIdentity)(
      {
        cwd: dependencies.cwd ?? process.cwd(),
      },
      (context) => {
        const invocation = openSlackInvocation(args);
        const result = (dependencies.spawn ?? spawnSync)(invocation.command, invocation.args, {
          cwd: dependencies.cwd ?? process.cwd(),
          env: createOpenSlackEnvironment(context, dependencies.env ?? process.env),
          stdio: 'inherit',
          windowsHide: true,
        });
        if (result.error) {
          process.stderr.write('BOT_OPENSLACK_LAUNCH_FAILED: could not start OpenSlack.\n');
          return 1;
        }
        return result.status ?? 1;
      },
    );
  } catch (error) {
    process.stderr.write(`${formatBotAuthError(error)}\n`);
    return 1;
  }
}

module.exports = { createChildEnvironment: createOpenSlackEnvironment, main };

if (require.main === module)
  void main().then((status) => {
    process.exitCode = status;
  });

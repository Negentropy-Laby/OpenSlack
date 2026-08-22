#!/usr/bin/env node
// Compatibility adapter for the historical `gh pr create` wrapper surface.
// It maps arguments into the package-backed `openslack delivery publish` path.

const { spawnSync } = require('node:child_process');
const { formatBotAuthError, withConfiguredBotInstallation } = require('./bot-gh-token.js');
const { createOpenSlackEnvironment, openSlackInvocation } = require('./bot-launch-environment.js');

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
      if (base === undefined) throw new Error('Unsupported bot PR compatibility argument: --base');
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

function mappedRepository(mapped) {
  const index = mapped.indexOf('--repo');
  return index === -1 ? undefined : mapped[index + 1];
}

async function main(args = process.argv.slice(2), dependencies = {}) {
  let mapped;
  try {
    mapped = mapCreateArgs(args);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'DELIVERY_ARGUMENT_INVALID'}\n`,
    );
    return 2;
  }
  try {
    return await (dependencies.withInstallation ?? withConfiguredBotInstallation)(
      {
        cwd: dependencies.cwd ?? process.cwd(),
        explicitRepository: mappedRepository(mapped),
        onDiagnostic: dependencies.onDiagnostic ?? writeDiagnostic,
      },
      (context) => {
        const invocation = openSlackInvocation(mapped);
        const result = (dependencies.spawn ?? spawnSync)(invocation.command, invocation.args, {
          cwd: dependencies.cwd ?? process.cwd(),
          env: createOpenSlackEnvironment(context, dependencies.env ?? process.env),
          stdio: 'inherit',
          windowsHide: true,
        });
        if (result.error) {
          process.stderr.write('BOT_DELIVERY_LAUNCH_FAILED: could not start governed delivery.\n');
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

function writeDiagnostic(diagnostic) {
  process.stderr.write(`${diagnostic.code}: ${diagnostic.message}\n`);
}

module.exports = { mapCreateArgs, mappedRepository, main };

if (require.main === module)
  void main().then((status) => {
    process.exitCode = status;
  });

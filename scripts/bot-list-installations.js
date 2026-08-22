#!/usr/bin/env node

const { formatBotAuthError, listConfiguredInstallations } = require('./bot-gh-token.js');

async function main(dependencies = {}) {
  try {
    const installations = await (dependencies.list ?? listConfiguredInstallations)({
      cwd: dependencies.cwd ?? process.cwd(),
    });
    process.stdout.write(
      `${JSON.stringify({
        schema: 'openslack.github_app_installation_list.v1',
        installations,
      })}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${formatBotAuthError(error)}\n`);
    return 1;
  }
}

module.exports = { main };

if (require.main === module)
  void main().then((status) => {
    process.exitCode = status;
  });

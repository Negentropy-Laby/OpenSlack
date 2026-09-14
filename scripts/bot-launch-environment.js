const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const { require: tsxRequire } = require('tsx/cjs/api');
const { createGhEnvironment, validateGhGoDebug } = tsxRequire(
  resolve(__dirname, '../packages/github/src/gh-environment.ts'),
  __filename,
);

const repoRoot = resolve(__dirname, '..');
const openSlackEntry = resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts');
const tsxLoader = pathToFileURL(require.resolve('tsx')).href;

const managedChildKeys = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENSLACK_GITHUB_TOKEN',
  'OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN',
  'OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN_EXPIRES_AT',
  'OPENSLACK_GITHUB_APP_INSTALLATION_PERMISSIONS',
  'OPENSLACK_GITHUB_APP_PRIVATE_KEY_PATH',
  'OPENSLACK_GITHUB_AUTH_MODE',
  'OPENSLACK_GITHUB_APP_ID',
  'OPENSLACK_GITHUB_APP_INSTALLATION_ID',
  'OPENSLACK_GITHUB_APP_PRIVATE_KEY',
  'OPENSLACK_GITHUB_APP_SLUG',
  'GITHUB_OWNER',
  'GITHUB_REPO',
];

function createOpenSlackEnvironment(context, parentEnvironment = process.env) {
  const value = validateGhGoDebug(parentEnvironment);
  const env = { ...parentEnvironment };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'GODEBUG' || key.toUpperCase() === 'OPENSLACK_BOT_GH_GODEBUG')
      delete env[key];
  }
  if (value) env.OPENSLACK_BOT_GH_GODEBUG = value;
  for (const key of managedChildKeys) delete env[key];
  if (context.forwardPrivateKey !== false) {
    env.OPENSLACK_GITHUB_AUTH_MODE = 'app';
    env.OPENSLACK_GITHUB_APP_ID = context.appId;
    if (context.installationId) {
      env.OPENSLACK_GITHUB_APP_INSTALLATION_ID = context.installationId;
    }
    env.OPENSLACK_GITHUB_APP_PRIVATE_KEY = context.privateKey;
    env.OPENSLACK_GITHUB_APP_SLUG = context.appSlug;
  }
  if (context.owner && context.repo) {
    env.GITHUB_OWNER = context.owner;
    env.GITHUB_REPO = context.repo;
  } else if (
    typeof parentEnvironment.GITHUB_OWNER === 'string' &&
    parentEnvironment.GITHUB_OWNER.trim() &&
    typeof parentEnvironment.GITHUB_REPO === 'string' &&
    parentEnvironment.GITHUB_REPO.trim()
  ) {
    env.GITHUB_OWNER = parentEnvironment.GITHUB_OWNER;
    env.GITHUB_REPO = parentEnvironment.GITHUB_REPO;
  }
  return env;
}

function openSlackInvocation(args) {
  return {
    command: process.execPath,
    args: ['--import', tsxLoader, openSlackEntry, ...args],
  };
}

module.exports = {
  validateGhGoDebug,
  createGhEnvironment,
  createOpenSlackEnvironment,
  openSlackEntry,
  openSlackInvocation,
  repoRoot,
  tsxLoader,
};

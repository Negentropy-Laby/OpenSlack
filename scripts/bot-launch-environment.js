const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

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
  const env = { ...parentEnvironment };
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

function createGhEnvironment(credentials, parentEnvironment = process.env) {
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
    if (parentEnvironment[key] !== undefined) env[key] = parentEnvironment[key];
  }
  // The gh child environment is closed by construction, so ambient Go runtime
  // knobs never reach it. On a network that drops ClientHellos advertising the
  // post-quantum X25519MLKEM768 key share that Go 1.24+ sends by default, every
  // gh call fails with "TLS handshake timeout" and no in-process workaround
  // exists. Operators opt in explicitly by naming this variable, rather than
  // inheriting whichever GODEBUG the caller happens to have set: GODEBUG also
  // carries settings that weaken certificate verification.
  const childGoDebug = parentEnvironment.OPENSLACK_BOT_GH_GODEBUG;
  if (typeof childGoDebug === 'string' && childGoDebug.trim() !== '') {
    env.GODEBUG = childGoDebug;
  }
  env.GH_TOKEN = credentials.value;
  env.GH_REPO = credentials.repository;
  env.GH_PAGER = 'cat';
  env.PAGER = 'cat';
  env.GH_PROMPT_DISABLED = '1';
  env.GH_EDITOR = 'false';
  env.GH_BROWSER = 'false';
  env.NO_COLOR = '1';
  return env;
}

function openSlackInvocation(args) {
  return {
    command: process.execPath,
    args: ['--import', tsxLoader, openSlackEntry, ...args],
  };
}

module.exports = {
  createGhEnvironment,
  createOpenSlackEnvironment,
  openSlackEntry,
  openSlackInvocation,
  repoRoot,
  tsxLoader,
};

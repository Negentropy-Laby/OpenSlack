#!/usr/bin/env node
// Resolve a GitHub App installation and acquire its token for an in-process
// child launcher. Direct token output is intentionally disabled so credentials
// never transit shell variables, argv, Git configuration, or logs.

const { createSign } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const PUBLIC_CONFIG_SCHEMA = 'openslack.github_app_public.v1';
const LOCAL_CONFIG_SCHEMA = 'openslack.github_app_local.v1';
const PUBLIC_CONFIG_PATH = path.resolve(
  __dirname,
  '..',
  '.openslack',
  'integrations',
  'github-app-public.json',
);
const LOCAL_CONFIG_PATH = path.resolve(__dirname, '..', '.openslack.local', 'github-app.json');
const DEFAULT_PRIVATE_KEY_PATH = path.resolve(
  __dirname,
  '..',
  '.openslack.local',
  'github-app.pem',
);
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_INSTALLATION_PAGE_BYTES = 512 * 1024;
const MAX_INSTALLATION_PAGES = 10;
const INSTALLATIONS_PER_PAGE = 100;
const GIT_ORIGIN_TIMEOUT_MS = 10_000;
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;
const INSTALLATION_PAGE_TIMEOUT_MS = 15_000;
const INSTALLATION_DISCOVERY_DEADLINE_MS = 30_000;
const OWNER_PATTERN = /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/u;
const APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/u;

class BotGitHubConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BotGitHubConfigurationError';
  }
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.ctimeMs === right.ctimeMs &&
    left.mtimeMs === right.mtimeMs
  );
}

function readStableUtf8(filePath, maxBytes, required) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size <= 0 || before.size > maxBytes) {
      throw new BotGitHubConfigurationError('GitHub App configuration is invalid.');
    }
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    const pathIdentity = fs.lstatSync(filePath);
    if (
      offset !== bytes.byteLength ||
      pathIdentity.isSymbolicLink() ||
      !sameIdentity(before, after) ||
      !sameIdentity(after, pathIdentity)
    ) {
      throw new BotGitHubConfigurationError('GitHub App configuration is unstable.');
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new BotGitHubConfigurationError('GitHub App configuration is not UTF-8.');
    }
  } catch (error) {
    if (error && error.code === 'ENOENT' && !required) return null;
    if (error instanceof BotGitHubConfigurationError) throw error;
    throw new BotGitHubConfigurationError(
      required
        ? 'Required GitHub App configuration is unavailable.'
        : 'GitHub App configuration could not be read safely.',
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function closedRecord(value, keys, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BotGitHubConfigurationError(message);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new BotGitHubConfigurationError(message);
  }
  return value;
}

function parseRepositorySpec(value) {
  if (typeof value !== 'string' || value.trim() !== value) return null;
  const segments = value.split('/');
  if (segments.length !== 2) return null;
  const [owner, repo] = segments;
  if (
    !owner ||
    !repo ||
    !OWNER_PATTERN.test(owner) ||
    repo === '.' ||
    repo === '..' ||
    !REPOSITORY_PATTERN.test(repo)
  ) {
    return null;
  }
  return { owner, repo, fullName: `${owner}/${repo}` };
}

function readPublicConfig(configPath = PUBLIC_CONFIG_PATH) {
  const text = readStableUtf8(configPath, MAX_CONFIG_BYTES, true);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BotGitHubConfigurationError('Public GitHub App configuration is invalid.');
  }
  const record = closedRecord(
    value,
    ['schema', 'appId', 'appSlug', 'repository'],
    'Public GitHub App configuration is invalid.',
  );
  const repository = parseRepositorySpec(record.repository);
  if (
    record.schema !== PUBLIC_CONFIG_SCHEMA ||
    typeof record.appId !== 'string' ||
    !POSITIVE_DECIMAL_PATTERN.test(record.appId) ||
    typeof record.appSlug !== 'string' ||
    !APP_SLUG_PATTERN.test(record.appSlug) ||
    repository === null
  ) {
    throw new BotGitHubConfigurationError('Public GitHub App configuration is invalid.');
  }
  const normalized = {
    schema: PUBLIC_CONFIG_SCHEMA,
    appId: record.appId,
    appSlug: record.appSlug,
    repository: repository.fullName,
  };
  if (text !== `${JSON.stringify(normalized, null, 2)}\n`) {
    throw new BotGitHubConfigurationError('Public GitHub App configuration is not canonical.');
  }
  return Object.freeze(normalized);
}

function readLocalConfig(options = {}) {
  const env = options.env ?? process.env;
  const configPath = env.OPENSLACK_GITHUB_APP_CONFIG_PATH
    ? path.resolve(env.OPENSLACK_GITHUB_APP_CONFIG_PATH)
    : LOCAL_CONFIG_PATH;
  const text = readStableUtf8(configPath, MAX_CONFIG_BYTES, false);
  if (text === null) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BotGitHubConfigurationError('Local GitHub App configuration is invalid.');
  }
  const record = closedRecord(
    value,
    ['schema', 'appId', 'installationId', 'appSlug', 'privateKeyRef'],
    'Local GitHub App configuration is invalid.',
  );
  if (
    record.schema !== LOCAL_CONFIG_SCHEMA ||
    typeof record.appId !== 'string' ||
    !POSITIVE_DECIMAL_PATTERN.test(record.appId) ||
    !(
      record.installationId === null ||
      (typeof record.installationId === 'string' &&
        POSITIVE_DECIMAL_PATTERN.test(record.installationId))
    ) ||
    typeof record.appSlug !== 'string' ||
    !APP_SLUG_PATTERN.test(record.appSlug) ||
    typeof record.privateKeyRef !== 'string' ||
    record.privateKeyRef.length === 0 ||
    record.privateKeyRef.length > 1024
  ) {
    throw new BotGitHubConfigurationError('Local GitHub App configuration is invalid.');
  }
  return Object.freeze({
    appId: record.appId,
    installationId: record.installationId,
    appSlug: record.appSlug,
  });
}

function explicitRepositoryFromArgs(args) {
  let repository = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    let candidate;
    if (argument === '--repo') {
      candidate = args[index + 1];
      if (candidate === undefined) {
        throw new BotGitHubConfigurationError('The explicit GitHub repository is incomplete.');
      }
      index += 1;
    } else if (argument.startsWith('--repo=')) {
      candidate = argument.slice('--repo='.length);
    } else {
      continue;
    }
    const parsed = parseRepositorySpec(candidate);
    if (parsed === null) {
      throw new BotGitHubConfigurationError('The explicit GitHub repository is invalid.');
    }
    if (repository !== null && repository.fullName !== parsed.fullName) {
      throw new BotGitHubConfigurationError('Multiple GitHub repositories were supplied.');
    }
    repository = parsed;
  }
  return repository;
}

function parseGitHubOrigin(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  let match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(trimmed);
  if (!match) {
    match = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(trimmed);
  }
  if (!match) {
    match = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(trimmed);
  }
  return match ? parseRepositorySpec(`${match[1]}/${match[2]}`) : null;
}

function readVerifiedGitOrigin(cwd) {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_ORIGIN_TIMEOUT_MS,
    maxBuffer: 16 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  const lines = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) return null;
  return parseGitHubOrigin(lines[0]);
}

function resolveTargetRepository(options = {}) {
  const args = options.args ?? [];
  const env = options.env ?? process.env;
  const explicit = explicitRepositoryFromArgs(args);
  if (explicit !== null) return Object.freeze({ ...explicit, source: 'explicit' });

  const hasOwner = typeof env.GITHUB_OWNER === 'string' && env.GITHUB_OWNER.length > 0;
  const hasRepo = typeof env.GITHUB_REPO === 'string' && env.GITHUB_REPO.length > 0;
  if (hasOwner !== hasRepo) {
    throw new BotGitHubConfigurationError(
      'GITHUB_OWNER and GITHUB_REPO must be configured together.',
    );
  }
  if (hasOwner && hasRepo) {
    const target = parseRepositorySpec(`${env.GITHUB_OWNER}/${env.GITHUB_REPO}`);
    if (target === null) {
      throw new BotGitHubConfigurationError('The GitHub repository environment is invalid.');
    }
    return Object.freeze({ ...target, source: 'environment' });
  }

  const origin =
    options.gitOrigin === undefined
      ? (options.readGitOrigin ?? readVerifiedGitOrigin)(options.cwd ?? process.cwd())
      : parseGitHubOrigin(options.gitOrigin);
  if (origin !== null) return Object.freeze({ ...origin, source: 'git_origin' });

  const publicConfig = options.publicConfig ?? readPublicConfig(options.publicConfigPath);
  const fallback = parseRepositorySpec(publicConfig.repository);
  if (fallback === null) {
    throw new BotGitHubConfigurationError('Public GitHub App repository is invalid.');
  }
  return Object.freeze({ ...fallback, source: 'public_config' });
}

function resolveAppIdentity(options = {}) {
  const env = options.env ?? process.env;
  const localConfig =
    options.localConfig === undefined ? readLocalConfig({ env }) : options.localConfig;
  const publicConfig = options.publicConfig ?? readPublicConfig(options.publicConfigPath);
  const appId = env.OPENSLACK_GITHUB_APP_ID || localConfig?.appId || publicConfig.appId;
  const appSlug = env.OPENSLACK_GITHUB_APP_SLUG || localConfig?.appSlug || publicConfig.appSlug;
  const installationHint =
    env.OPENSLACK_GITHUB_APP_INSTALLATION_ID || localConfig?.installationId || null;
  if (!POSITIVE_DECIMAL_PATTERN.test(appId) || !APP_SLUG_PATTERN.test(appSlug)) {
    throw new BotGitHubConfigurationError('GitHub App public identity is invalid.');
  }
  if (installationHint !== null && !POSITIVE_DECIMAL_PATTERN.test(installationHint)) {
    throw new BotGitHubConfigurationError('GitHub App installation hint is invalid.');
  }
  return Object.freeze({ appId, appSlug, installationHint });
}

function b64url(input) {
  return Buffer.from(input).toString('base64url').replace(/=+$/u, '');
}

function jwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey).toString('base64url').replace(/=+$/u, '');
  return `${header}.${payload}.${signature}`;
}

function requestGitHubJson(options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];
    let byteLength = 0;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const request = https.request(
      {
        hostname: 'api.github.com',
        path: options.path,
        method: options.method,
        headers: {
          Authorization: `Bearer ${options.bearer}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'openslack-bot-gh',
        },
      },
      (response) => {
        response.on('data', (chunk) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          byteLength += bytes.byteLength;
          if (byteLength > (options.maxResponseBytes ?? MAX_RESPONSE_BYTES)) {
            finish(() => reject(new Error('GitHub App response exceeded the size limit.')));
            request.destroy();
            return;
          }
          chunks.push(bytes);
        });
        response.on('end', () => {
          finish(() => {
            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
              reject(new Error(`GitHub App request failed with HTTP ${response.statusCode ?? 0}.`));
              return;
            }
            try {
              const text = new TextDecoder('utf-8', { fatal: true }).decode(
                Buffer.concat(chunks, byteLength),
              );
              resolve(JSON.parse(text));
            } catch {
              reject(new Error('GitHub App response was invalid.'));
            }
          });
        });
      },
    );
    request.on('error', () => {
      finish(() => reject(new Error('GitHub App request failed safely.')));
    });
    const timeout = setTimeout(() => {
      finish(() => reject(new Error('GitHub App request timed out.')));
      request.destroy();
    }, options.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS);
    timeout.unref();
    request.end();
  });
}

function validateInstallationPage(value, seenIds) {
  if (!Array.isArray(value) || value.length > INSTALLATIONS_PER_PAGE) {
    throw new BotGitHubConfigurationError('GitHub App installation response is invalid.');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new BotGitHubConfigurationError('GitHub App installation response is invalid.');
    }
    const id = entry.id;
    const account = entry.account;
    if (
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      !account ||
      typeof account !== 'object' ||
      Array.isArray(account) ||
      typeof account.login !== 'string' ||
      !OWNER_PATTERN.test(account.login) ||
      (entry.repository_selection !== 'all' && entry.repository_selection !== 'selected')
    ) {
      throw new BotGitHubConfigurationError('GitHub App installation response is invalid.');
    }
    const stringId = String(id);
    if (seenIds.has(stringId)) {
      throw new BotGitHubConfigurationError('GitHub App installation response is ambiguous.');
    }
    seenIds.add(stringId);
    return Object.freeze({
      id: stringId,
      account: account.login,
      repositorySelection: entry.repository_selection,
    });
  });
}

async function listGitHubAppInstallations(options) {
  const requestPage =
    options.requestPage ??
    (async ({ page, bearer, timeoutMs }) =>
      requestGitHubJson({
        method: 'GET',
        path: `/app/installations?per_page=${INSTALLATIONS_PER_PAGE}&page=${page}`,
        bearer,
        maxResponseBytes: MAX_INSTALLATION_PAGE_BYTES,
        timeoutMs,
      }));
  const bearer = options.bearer ?? jwt(options.appId, options.privateKey);
  const result = [];
  const seenIds = new Set();
  const now = options.now ?? Date.now;
  const deadline = now() + INSTALLATION_DISCOVERY_DEADLINE_MS;
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page += 1) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new BotGitHubConfigurationError('GitHub App installation discovery timed out.');
    }
    let rawPage;
    try {
      rawPage = await requestPage({
        page,
        perPage: INSTALLATIONS_PER_PAGE,
        bearer,
        timeoutMs: Math.min(INSTALLATION_PAGE_TIMEOUT_MS, remainingMs),
      });
    } catch (error) {
      if (error instanceof BotGitHubConfigurationError) throw error;
      throw new BotGitHubConfigurationError('GitHub App installations could not be discovered.');
    }
    const entries = validateInstallationPage(rawPage, seenIds);
    result.push(...entries);
    if (entries.length < INSTALLATIONS_PER_PAGE) return Object.freeze(result);
  }
  throw new BotGitHubConfigurationError('GitHub App installation pagination exceeded its limit.');
}

function selectInstallationForOwner(installations, owner, installationHint = null) {
  const matches = installations.filter(
    (installation) => installation.account.toLowerCase() === owner.toLowerCase(),
  );
  if (matches.length !== 1) {
    throw new BotGitHubConfigurationError(
      matches.length === 0
        ? 'No GitHub App installation matches the target owner.'
        : 'Multiple GitHub App installations match the target owner.',
    );
  }
  const selected = matches[0];
  return Object.freeze({
    ...selected,
    replacedHint: installationHint !== null && installationHint !== selected.id,
  });
}

function readPrivateKey(options = {}) {
  const env = options.env ?? process.env;
  if (typeof env.OPENSLACK_GITHUB_APP_PRIVATE_KEY === 'string') {
    const value = env.OPENSLACK_GITHUB_APP_PRIVATE_KEY;
    if (value.length <= MAX_PRIVATE_KEY_BYTES && value.includes('PRIVATE KEY')) return value;
    throw new BotGitHubConfigurationError('GitHub App private key is invalid.');
  }
  const privateKeyPath = env.OPENSLACK_GITHUB_APP_PRIVATE_KEY_PATH
    ? path.resolve(env.OPENSLACK_GITHUB_APP_PRIVATE_KEY_PATH)
    : DEFAULT_PRIVATE_KEY_PATH;
  const value = readStableUtf8(privateKeyPath, MAX_PRIVATE_KEY_BYTES, true);
  if (!value.includes('PRIVATE KEY')) {
    throw new BotGitHubConfigurationError('GitHub App private key is invalid.');
  }
  return value;
}

async function resolveConfiguredInstallation(options = {}) {
  const env = options.env ?? process.env;
  const publicConfig = options.publicConfig ?? readPublicConfig(options.publicConfigPath);
  const target = resolveTargetRepository({ ...options, env, publicConfig });
  const identity = resolveAppIdentity({ ...options, env, publicConfig });
  let privateKey = options.privateKey ?? readPrivateKey({ env });
  try {
    const installations = await listGitHubAppInstallations({
      appId: identity.appId,
      privateKey,
      requestPage: options.requestPage,
      bearer: options.bearer,
    });
    const installation = selectInstallationForOwner(
      installations,
      target.owner,
      identity.installationHint,
    );
    return Object.freeze({
      ...identity,
      installationId: installation.id,
      installationHintReplaced: installation.replacedHint,
      owner: target.owner,
      repo: target.repo,
      repository: target.fullName,
      repositorySource: target.source,
      privateKey,
    });
  } finally {
    privateKey = undefined;
  }
}

function getInstallationToken(appId, installationId, privateKey, request = requestGitHubJson) {
  return request({
    method: 'POST',
    path: `/app/installations/${installationId}/access_tokens`,
    bearer: jwt(appId, privateKey),
  }).then((data) => parseInstallationTokenResponse(data, installationId));
}

function parseInstallationTokenResponse(data, installationId, now = Date.now()) {
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    typeof data.token !== 'string' ||
    data.token.trim().length === 0 ||
    typeof data.expires_at !== 'string'
  ) {
    throw new Error('GitHub App token response was invalid.');
  }
  const expiry = Date.parse(data.expires_at);
  if (Number.isNaN(expiry) || expiry <= now) {
    throw new Error('GitHub App token response expiry was invalid.');
  }
  const permissions =
    data.permissions && typeof data.permissions === 'object' && !Array.isArray(data.permissions)
      ? Object.fromEntries(
          Object.entries(data.permissions).filter((entry) => typeof entry[1] === 'string'),
        )
      : {};
  return {
    value: data.token,
    expiresAt: data.expires_at,
    installationId: String(installationId),
    permissions,
  };
}

async function acquireConfiguredInstallationCredentials(options = {}) {
  const resolved = await resolveConfiguredInstallation(options);
  let token;
  try {
    token = await (options.getInstallationToken ?? getInstallationToken)(
      resolved.appId,
      resolved.installationId,
      resolved.privateKey,
    );
    return Object.freeze({
      ...token,
      appId: resolved.appId,
      appSlug: resolved.appSlug,
      owner: resolved.owner,
      repo: resolved.repo,
      repository: resolved.repository,
      repositorySource: resolved.repositorySource,
      installationHintReplaced: resolved.installationHintReplaced ?? false,
    });
  } finally {
    token = undefined;
  }
}

async function acquireConfiguredInstallationToken(options = {}) {
  return (await acquireConfiguredInstallationCredentials(options)).value;
}

async function main(args = process.argv.slice(2)) {
  if (args[0] === '--list-installations') {
    const env = process.env;
    const publicConfig = readPublicConfig();
    const identity = resolveAppIdentity({ env, publicConfig });
    let privateKey = readPrivateKey({ env });
    try {
      const installations = await listGitHubAppInstallations({
        appId: identity.appId,
        privateKey,
      });
      process.stdout.write(`${JSON.stringify(installations)}\n`);
      return 0;
    } finally {
      privateKey = undefined;
    }
  }
  process.stderr.write(
    'Direct token output is disabled. Use bot-gh.sh, bot-gh.ps1, or openslack delivery publish.\n',
  );
  return 2;
}

module.exports = {
  BotGitHubConfigurationError,
  PUBLIC_CONFIG_PATH,
  acquireConfiguredInstallationCredentials,
  acquireConfiguredInstallationToken,
  listGitHubAppInstallations,
  parseGitHubOrigin,
  parseInstallationTokenResponse,
  parseRepositorySpec,
  readLocalConfig,
  readPublicConfig,
  resolveAppIdentity,
  resolveConfiguredInstallation,
  resolveTargetRepository,
  selectInstallationForOwner,
};

if (require.main === module) {
  void main()
    .then((status) => process.exit(status))
    .catch(() => {
      process.stderr.write('GitHub App installation discovery failed safely.\n');
      process.exit(1);
    });
}

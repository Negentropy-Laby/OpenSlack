/** Official-source bootstrap. Intentionally uses only Node built-ins before installation. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY = 'https://registry.npmjs.org';
const BUN_VERSION = '1.4.0';
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeKey = key => /^[A-Za-z0-9@/_.+-]{1,180}$/.test(key) ? key : '[redacted-key]';

export class DependencySourceError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'DependencySourceError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new DependencySourceError(code, message, details);
}

function utf8(bytes) {
  try {
    const text = typeof bytes === 'string' ? bytes : decoder.decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) fail('SOURCE_ENCODING', 'UTF-8 BOM is not supported.');
    return text;
  } catch (error) {
    if (error instanceof DependencySourceError) throw error;
    fail('SOURCE_ENCODING', 'Expected valid UTF-8 bytes.');
  }
}

/** Recursive JSONC reader: comments/trailing commas, but never duplicate keys or JS evaluation. */
export function parseJsonc(bytes) {
  const text = utf8(bytes);
  let position = 0;
  function invalid(message = 'Malformed JSONC.') {
    fail('LOCK_SYNTAX', message, { offset: position });
  }
  function whitespace() {
    while (position < text.length) {
      if (/[\t\n\r ]/.test(text[position])) { position++; continue; }
      if (text.startsWith('//', position)) {
        position += 2;
        while (position < text.length && text[position] !== '\n' && text[position] !== '\r') position++;
        continue;
      }
      if (text.startsWith('/*', position)) {
        const end = text.indexOf('*/', position + 2);
        if (end < 0) invalid('Unterminated JSONC comment.');
        position = end + 2;
        continue;
      }
      break;
    }
  }
  function string() {
    const start = position++;
    while (position < text.length) {
      const char = text[position++];
      if (char === '"') {
        try { return JSON.parse(text.slice(start, position)); } catch { invalid('Invalid JSON string.'); }
      }
      if (char === '\\') { position++; continue; }
      if (char.charCodeAt(0) < 32) invalid('Unescaped JSON control character.');
    }
    invalid('Unterminated JSON string.');
  }
  function value(path, depth) {
    if (depth > 128) invalid('JSONC nesting limit exceeded.');
    whitespace();
    const char = text[position];
    if (char === '"') return string();
    if (char === '{') {
      position++;
      const result = Object.create(null);
      const keys = new Set();
      whitespace();
      while (text[position] !== '}') {
        if (text[position] !== '"') invalid('Expected an object key.');
        const key = string();
        if (keys.has(key)) fail('LOCK_DUPLICATE_KEY', 'Duplicate JSON key.', { field: `${path}.${safeKey(key)}`, offset: position });
        keys.add(key);
        whitespace();
        if (text[position++] !== ':') invalid('Expected an object separator.');
        result[key] = value(`${path}.${safeKey(key)}`, depth + 1);
        whitespace();
        if (text[position] === '}') break;
        if (text[position++] !== ',') invalid('Expected an object delimiter.');
        whitespace();
      }
      position++;
      return result;
    }
    if (char === '[') {
      position++;
      const result = [];
      whitespace();
      while (text[position] !== ']') {
        result.push(value(`${path}[${result.length}]`, depth + 1));
        whitespace();
        if (text[position] === ']') break;
        if (text[position++] !== ',') invalid('Expected an array delimiter.');
        whitespace();
      }
      position++;
      return result;
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, position)) { position += literal.length; return parsed; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(position));
    if (number) {
      position += number[0].length;
      const parsed = Number(number[0]);
      if (!Number.isFinite(parsed)) invalid('Non-finite JSON number.');
      return parsed;
    }
    invalid();
  }
  const result = value('$', 0);
  whitespace();
  if (position !== text.length) invalid('Unexpected bytes after JSONC value.');
  return result;
}

function officialURL(source, field, packageKey, registry = false) {
  const details = { field, ...(packageKey === undefined ? {} : { package: safeKey(packageKey) }) };
  if (typeof source !== 'string' || source.length === 0) fail('SOURCE_SHAPE', 'Expected a source URL string.', details);
  let url;
  try { url = new URL(source); } catch { fail('SOURCE_URL', 'Malformed source URL.', details); }
  // Never include a raw URL, userinfo, path, query, fragment, or parser exception in diagnostics.
  details.origin = `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
  if (source.trim() !== source || url.origin !== REGISTRY || url.username || url.password || url.search || url.hash ||
      (registry && url.pathname !== '/') || (!registry && (!url.pathname.includes('/-/') || !url.pathname.endsWith('.tgz')))) {
    fail('SOURCE_NOT_OFFICIAL', 'Only the official public npm source is supported.', details);
  }
}

function npmMetadata(value) {
  const stringMap = map => record(map) && Object.values(map).every(item => typeof item === 'string');
  return Object.entries(value).every(([key, item]) => {
    if (['dependencies', 'peerDependencies', 'optionalDependencies'].includes(key)) return stringMap(item);
    if (key === 'bin') return typeof item === 'string' || stringMap(item);
    if (['optionalPeers', 'os', 'cpu'].includes(key)) return typeof item === 'string' || (Array.isArray(item) && item.every(entry => typeof entry === 'string'));
    return false;
  });
}

function npmIntegrity(value) {
  if (typeof value !== 'string') return false;
  const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const bytes = Buffer.from(match[2], 'base64');
  return bytes.length === { sha1: 20, sha256: 32, sha384: 48, sha512: 64 }[match[1]] && bytes.toString('base64') === match[2];
}

export function validateLockfile(bytes) {
  const lock = parseJsonc(bytes);
  if (!record(lock)) fail('LOCK_SHAPE', 'Expected a lock object.', { field: '$' });
  if (lock.lockfileVersion !== 1 || lock.configVersion !== 1) fail('LOCK_VERSION', 'Unsupported Bun lock/config version.', { field: '$.lockfileVersion/configVersion' });
  const keys = ['lockfileVersion', 'configVersion', 'workspaces', 'packages', 'trustedDependencies'];
  if (Object.keys(lock).some(key => !keys.includes(key))) fail('LOCK_SHAPE', 'Unknown lock root field.', { field: '$' });
  if (Object.hasOwn(lock, 'trustedDependencies') && (!Array.isArray(lock.trustedDependencies) || lock.trustedDependencies.some(name => typeof name !== 'string' || !name))) {
    fail('LOCK_SHAPE', 'Expected a trusted dependency name list.', { field: '$.trustedDependencies' });
  }
  if (!record(lock.workspaces) || !record(lock.workspaces['']) || !record(lock.packages) || Object.keys(lock.packages).length === 0) {
    fail('LOCK_SHAPE', 'Expected workspace and nonempty package tables.', { field: '$.workspaces/packages' });
  }
  for (const [path, workspace] of Object.entries(lock.workspaces)) {
    if (!record(workspace) || typeof workspace.name !== 'string' || !workspace.name ||
        (path !== '' && (path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')))) {
      fail('LOCK_WORKSPACE', 'Invalid workspace declaration.', { field: `$.workspaces.${safeKey(path)}` });
    }
  }
  const counts = { packages: 0, npm: 0, workspaces: 0, explicit: 0, default: 0 };
  for (const [key, entry] of Object.entries(lock.packages)) {
    const field = `$.packages.${safeKey(key)}`;
    const details = { package: safeKey(key), field };
    counts.packages++;
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') fail('LOCK_TUPLE', 'Unsupported package tuple.', details);
    if (entry.length === 1) {
      const split = entry[0].lastIndexOf('@workspace:');
      const name = split > 0 ? entry[0].slice(0, split) : '';
      const path = split > 0 ? entry[0].slice(split + '@workspace:'.length) : '';
      if (!name || !Object.hasOwn(lock.workspaces, path) || path === '' || lock.workspaces[path].name !== name || key !== name) {
        fail('LOCK_WORKSPACE', 'Unrecognized workspace link.', details);
      }
      counts.workspaces++;
      continue;
    }
    const split = entry[0].lastIndexOf('@');
    const name = entry[0].slice(0, split);
    const version = entry[0].slice(split + 1);
    if (entry.length !== 4 || split < 1 || split === entry[0].length - 1 || entry[0].includes('@workspace:') ||
        !/^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(name) ||
        !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?(?:\+[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/.test(version) ||
        typeof entry[1] !== 'string' || !record(entry[2]) || !npmMetadata(entry[2]) || !npmIntegrity(entry[3])) {
      fail('LOCK_TUPLE', 'Expected an npm four-element tuple with source, metadata and integrity.', details);
    }
    counts.npm++;
    if (entry[1] === '') { counts.default++; continue; }
    officialURL(entry[1], `${field}[1]`, key);
    counts.explicit++;
  }
  return counts;
}

export function validateBunfig(config) {
  if (!record(config) || !record(config.install) || Object.keys(config).some(key => key !== 'install')) {
    fail('CONFIG_SHAPE', 'Expected only the reviewed [install] configuration.', { field: 'install' });
  }
  const install = config.install;
  const allowed = ['registry', 'scopes', 'text-lockfile', 'trustedDependencies'];
  for (const key of Object.keys(install)) {
    if (key === 'ca' || key === 'cafile') fail('CONFIG_CA_MIGRATION', 'Use an explicit --cafile, not bunfig CA configuration.', { field: `install.${key}` });
    if (!allowed.includes(key)) fail('CONFIG_SHAPE', 'Unreviewed install configuration field.', { field: `install.${safeKey(key)}` });
  }
  officialURL(install.registry, 'install.registry', undefined, true);
  if (Object.hasOwn(install, 'text-lockfile') && typeof install['text-lockfile'] !== 'boolean') fail('CONFIG_SHAPE', 'Invalid text-lockfile setting.', { field: 'install.text-lockfile' });
  if (Object.hasOwn(install, 'trustedDependencies') && (!record(install.trustedDependencies) || Object.values(install.trustedDependencies).some(value => typeof value !== 'boolean'))) {
    fail('CONFIG_SHAPE', 'Invalid trusted dependency map.', { field: 'install.trustedDependencies' });
  }
  if (Object.hasOwn(install, 'scopes')) {
    if (!record(install.scopes)) fail('CONFIG_SHAPE', 'Expected a scope map.', { field: 'install.scopes' });
    for (const [scope, source] of Object.entries(install.scopes)) {
      const field = `install.scopes.${safeKey(scope)}`;
      if (!/^@?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(scope)) fail('CONFIG_SHAPE', 'Invalid registry scope.', { field });
      if (record(source)) {
        if (Object.keys(source).length !== 1 || !Object.hasOwn(source, 'url')) fail('CONFIG_SHAPE', 'Scope configuration must contain only its public URL.', { field });
        officialURL(source.url, `${field}.url`, undefined, true);
      } else officialURL(source, field, undefined, true);
    }
  }
  return config;
}

export function parseBunfigOutput(stdout) {
  let response;
  try {
    JSON.parse(stdout); // stdout is one strict JSON frame, not the lockfile's JSONC dialect.
    response = parseJsonc(stdout); // The duplicate-key check must precede any value consumption.
  } catch { fail('CONFIG_OUTPUT', 'Bun parser returned an invalid or ambiguous JSON frame.'); }
  if (!record(response) || Object.keys(response).length !== 2 || !Object.hasOwn(response, 'config') || !Object.hasOwn(response, 'bunVersion')) {
    fail('CONFIG_OUTPUT', 'Bun parser response is missing its version/config envelope.');
  }
  if (response.bunVersion !== BUN_VERSION) fail('BUN_VERSION', 'Dependency installation requires Bun 1.4.0.');
  return validateBunfig(response.config);
}

function readOwnedInput(path, field) {
  try { return readFileSync(path); } catch { fail('SOURCE_READ', 'Cannot read required repository input.', { field }); }
}

export function checkDependencySources({ rootDir = DEFAULT_ROOT, env = process.env, cafile } = {}) {
  for (const [key, value] of Object.entries(env)) {
    const normalized = key.toUpperCase();
    if (['NPM_CONFIG_REGISTRY', 'BUN_CONFIG_REGISTRY'].includes(normalized) && value) officialURL(value, `env.${normalized}`, undefined, true);
    if ((/^(?:NPM_CONFIG_|BUN_CONFIG_)CA(?:FILE)?$/.test(normalized) || ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].includes(normalized)) && value && !cafile) {
      fail('CONFIG_CA_MIGRATION', 'Legacy CA configuration requires an explicit --cafile.');
    }
  }
  try {
    lstatSync(join(rootDir, '.npmrc'));
    fail('PROJECT_NPMRC', 'Project .npmrc is unsupported; use the reviewed bunfig and explicit --cafile.', { field: '.npmrc' });
  } catch (error) {
    if (error instanceof DependencySourceError) throw error;
    if (error.code !== 'ENOENT') fail('PROJECT_NPMRC', 'Cannot verify absence of project .npmrc.', { field: '.npmrc' });
  }
  const bytes = readOwnedInput(join(rootDir, 'bun.lock'), 'bun.lock');
  return { ...validateLockfile(bytes), lockSHA256: createHash('sha256').update(bytes).digest('hex') };
}

/** Only child configuration changes. The calling shell and publishing credentials are untouched. */
export function createChildEnvironment(parent, configDirectory) {
  const allowed = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|USER|USERNAME|LOGNAME|TEMP|TMP|TMPDIR|LANG|LANGUAGE|LC_[A-Z_]+|TERM|COLORTERM|CI|GITHUB_ACTIONS|RUNNER_OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i;
  const child = {};
  for (const [key, value] of Object.entries(parent)) if (allowed.test(key) && value !== undefined) child[key] = value;
  child.XDG_CONFIG_HOME = configDirectory;
  return child;
}

export function parseArguments(argv, rootDir = DEFAULT_ROOT) {
  const result = { check: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!['--check', '--cache-dir', '--cafile'].includes(arg) || seen.has(arg)) fail('INSTALL_ARGUMENT', 'Unsupported or duplicate dependency-install option.');
    seen.add(arg);
    if (arg === '--check') { result.check = true; continue; }
    const value = argv[++index];
    if (!value || value.startsWith('-') || value.includes('\0')) fail('INSTALL_ARGUMENT', 'Dependency-install option requires a path.');
    result[arg === '--cafile' ? 'cafile' : 'cacheDir'] = resolve(rootDir, value);
  }
  if (result.check && (result.cacheDir || result.cafile)) fail('INSTALL_ARGUMENT', '--check does not accept installer options.');
  return result;
}

function successfulProcess(result, phase) {
  if (result.error || result.signal || result.status !== 0) {
    fail(phase === 'parser' ? 'CONFIG_EXECUTION' : 'INSTALL_EXECUTION', `Bun ${phase} failed; raw subprocess output is withheld.`, {
      status: Number.isInteger(result.status) ? result.status : null,
      signal: typeof result.signal === 'string' && /^SIG[A-Z0-9]+$/.test(result.signal) ? result.signal : null,
    });
  }
}

export function installDependencies({ rootDir = DEFAULT_ROOT, env = process.env, args = [] } = {}, ports = { spawnSync }) {
  rootDir = resolve(rootDir);
  const options = parseArguments(args, rootDir);
  const report = checkDependencySources({ rootDir, env, cafile: options.cafile });
  if (options.check) return report;
  const configBytes = readOwnedInput(join(rootDir, 'bunfig.toml'), 'bunfig.toml');
  // The first Bun invocation must not read project/global startup configuration or dotenv.
  const directory = mkdtempSync(join(tmpdir(), 'openslack-dependency-install-'));
  try {
    const configDirectory = join(directory, 'config');
    mkdirSync(configDirectory, { mode: 0o700 });
    writeFileSync(join(configDirectory, '.npmrc'), '', { mode: 0o600 });
    writeFileSync(join(configDirectory, '.bunfig.toml'), '', { mode: 0o600 });
    const bootstrap = join(directory, 'bootstrap.toml');
    writeFileSync(bootstrap, '[install]\nauto = "disable"\n', { mode: 0o600 });
    const childEnv = createChildEnvironment(env, configDirectory);
    const parser = ports.spawnSync('bun', ['--no-env-file', `--config=${bootstrap}`, '--eval',
      'try { const input = await Bun.stdin.text(); const config = Bun.TOML.parse(input); console.log(JSON.stringify({bunVersion:Bun.version,config})); } catch { process.exit(2); }'], {
      cwd: directory, env: childEnv, input: configBytes, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    successfulProcess(parser, 'parser');
    parseBunfigOutput(parser.stdout);
    const config = join(directory, 'approved.toml');
    writeFileSync(config, configBytes, { mode: 0o600 });
    const installArgs = ['install', '--no-env-file', `--config=${config}`, '--registry', REGISTRY, '--frozen-lockfile'];
    if (options.cacheDir) installArgs.push('--cache-dir', options.cacheDir);
    if (options.cafile) installArgs.push('--cafile', options.cafile);
    const result = ports.spawnSync('bun', installArgs, {
      cwd: rootDir, env: childEnv, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    const after = createHash('sha256').update(readOwnedInput(join(rootDir, 'bun.lock'), 'bun.lock')).digest('hex');
    if (after !== report.lockSHA256) fail('LOCK_CHANGED', 'Frozen installation changed bun.lock; preserve the file for inspection.');
    successfulProcess(result, 'installer');
    return report;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = installDependencies({ args: process.argv.slice(2) });
    console.log(JSON.stringify({ status: 'OFFICIAL_DEPENDENCY_SOURCES', ...report }));
  } catch (error) {
    const safe = error instanceof DependencySourceError ? error : new DependencySourceError('INSTALL_FAILURE', 'Dependency installation failed.');
    console.error(JSON.stringify({ code: safe.code, message: safe.message, ...safe.details }));
    process.exitCode = 1;
  }
}

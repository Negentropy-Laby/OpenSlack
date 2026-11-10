import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  DependencySourceError,
  checkDependencySources,
  createChildEnvironment,
  installDependencies,
  parseArguments,
  parseBunfigOutput,
  parseJsonc,
  validateBunfig,
  validateLockfile,
} from '../../ci/install-dependencies.mjs';
import {
  testExecutable,
  testProcessEnvironment,
  testTemporaryDirectory,
} from '../../testing/process-fixture.mjs';

const repository = resolve(import.meta.dirname, '../../..');
const official = 'https://registry.npmjs.org';
const tarball = `${official}/example/-/example-1.0.0.tgz`;
const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const acceptedConfig = { install: { registry: official, 'text-lockfile': true } };
const configText = `[install]\nregistry = "${official}"\ntext-lockfile = true\n`;

function npm(source = tarball): unknown[] {
  return ['example@1.0.0', source, {}, integrity];
}

function lock(packages: Record<string, unknown> = { example: npm() }) {
  const workspaces: Record<string, Record<string, unknown>> = {
    '': { name: 'source-fixture' },
    'packages/local': { name: '@fixture/local', version: '1.0.0' },
  };
  return {
    lockfileVersion: 1,
    configVersion: 1,
    workspaces,
    packages,
  };
}

function ownedDirectory(prefix = 'openslack-install-test-') {
  const root = testTemporaryDirectory(prefix);
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixture(packages?: Record<string, unknown>) {
  const root = ownedDirectory();
  writeFileSync(join(root, 'bun.lock'), JSON.stringify(lock(packages)));
  writeFileSync(join(root, 'bunfig.toml'), configText);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'source-fixture', private: true }));
  return root;
}

function isolatedEnvironment(extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' };
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'PATHEXT']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return testProcessEnvironment({ ...env, ...extra });
}

function sourceError(run: () => unknown) {
  let thrown: unknown;
  try { run(); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(DependencySourceError);
  expect((thrown as { code: unknown }).code).toMatch(/^[A-Z][A-Z0-9_]+$/);
  return thrown as Error & { code: string; details?: unknown };
}

function successfulSpawn(config: unknown = acceptedConfig) {
  return vi.fn((_command: string, args: string[], _options?: unknown) => {
    if (args.includes('install')) return { status: 0, signal: null, stdout: '', stderr: '' };
    return {
      status: 0,
      signal: null,
      stdout: JSON.stringify({ bunVersion: '1.4.0', config }),
      stderr: '',
    };
  });
}

describe('strict dependency lock source parsing', () => {
  it('accepts JSONC comments and trailing commas without changing URL or escaped string bytes', () => {
    const parsed = parseJsonc(Buffer.from('/* header */ {"url":"https://registry.npmjs.org/x//y", // comment\n "escaped":"quote: \\\"", "items":[1,2,],}'));
    expect(parsed).toEqual({ url: 'https://registry.npmjs.org/x//y', escaped: 'quote: "', items: [1, 2] });
  });

  it.each([
    ['root', '{"packages":{},"packages":{}}'],
    ['nested', '{"packages":{"example":[],"example":[]}}'],
    ['escape-equivalent', '{"packages":{},"\\u0070ackages":{}}'],
    ['nested escape-equivalent', '{"x":{"registry":1,"\\u0072egistry":2}}'],
  ])('rejects %s duplicate keys rather than accepting last-wins input', (_label, bytes) => {
    const error = sourceError(() => parseJsonc(Buffer.from(bytes)));
    expect(`${error.message} ${JSON.stringify(error.details)}`).toMatch(/duplicate/i);
  });

  it.each([
    Buffer.from([0xc3, 0x28]),
    Buffer.from('{"x":"unterminated}'),
    Buffer.from('{/* unterminated'),
    Buffer.from('{"x":1} {"other":2}'),
    Buffer.from('{"x":NaN}'),
    Buffer.from('{"x":undefined}'),
    Buffer.from('{"x":1,,}'),
  ])('rejects malformed JSONC or invalid UTF-8 %#', bytes => {
    sourceError(() => parseJsonc(bytes));
  });

  it('classifies every npm tuple and workspace link without a hard-coded inventory', () => {
    const bytes = JSON.stringify(lock({
      example: npm(),
      'example-empty': ['example-empty@2.0.0', '', {}, integrity],
      '@fixture/local': ['@fixture/local@workspace:packages/local'],
    }));
    expect(validateLockfile(Buffer.from(bytes))).toMatchObject({
      packages: 3, npm: 2, workspaces: 1, explicit: 1, default: 1,
    });
  });

  it('accepts an entirely implicit npm source table under the controlled registry contract', () => {
    expect(validateLockfile(Buffer.from(JSON.stringify(lock({ example: npm('') }))))).toMatchObject({
      packages: 1, npm: 1, workspaces: 0, explicit: 0, default: 1,
    });
  });

  it.each([
    ['unknown lockfile version', { ...lock(), lockfileVersion: 2 }],
    ['unknown config version', { ...lock(), configVersion: 2 }],
    ['missing lockfile version', { ...lock(), lockfileVersion: undefined }],
    ['missing package table', { ...lock(), packages: undefined }],
    ['array package table', { ...lock(), packages: [] }],
    ['unknown root structure', { ...lock(), futureSourceTable: {} }],
    ['missing tuple source', lock({ example: ['example@1.0.0', {}, integrity] })],
    ['future tuple structure', lock({ example: { source: tarball } })],
    ['extra tuple field', lock({ example: [...npm(), 'future'] })],
    ['non-string source', lock({ example: ['example@1.0.0', {}, {}, integrity] })],
    ['non-object metadata', lock({ example: ['example@1.0.0', '', [], integrity] })],
    ['missing integrity', lock({ example: ['example@1.0.0', '', {}, null] })],
    ['unregistered workspace', lock({ example: ['example@workspace:packages/missing'] })],
    ['workspace name mismatch', lock({ example: ['example@workspace:packages/local'] })],
    ['workspace traversal', lock({ '@fixture/local': ['@fixture/local@workspace:../outside'] })],
    ['fake single-field npm entry', lock({ example: ['example@1.0.0'] })],
    ['file identity in npm tuple', lock({ example: ['example@file:../outside', '', {}, integrity] })],
    ['git identity in npm tuple', lock({ example: ['example@git+https://fixture.invalid/repo', '', {}, integrity] })],
    ['unknown tuple metadata', lock({ example: ['example@1.0.0', '', { futureSource: tarball }, integrity] })],
    ['malformed dependency metadata', lock({ example: ['example@1.0.0', '', { dependencies: [] }, integrity] })],
    ['non-version npm identity', lock({ example: ['example@not-a-version', '', {}, integrity] })],
    ['malformed integrity', lock({ example: ['example@1.0.0', '', {}, 'not-an-integrity'] })],
  ])('rejects %s without silently skipping entries', (_label, value) => {
    sourceError(() => validateLockfile(Buffer.from(JSON.stringify(value))));
  });

  it.each([
    tarball.replace('registry.npmjs.org', 'registry.npmmirror.com'),
    tarball.replace('registry.npmjs.org', 'registry.npmjs.org.evil.invalid'),
    tarball.replace('https:', 'http:'),
    tarball.replace('registry.npmjs.org', 'registry.npmjs.org:444'),
    tarball.replace('registry.npmjs.org', 'user:secret@registry.npmjs.org'),
    `${tarball}?token=secret`,
    `${tarball}#secret`,
    'file:///example/-/example-1.0.0.tgz',
  ])('rejects a nonofficial or credential-bearing source %#', source => {
    const error = sourceError(() => validateLockfile(Buffer.from(JSON.stringify(lock({ example: npm(source) })))));
    expect(error.code).toBe('SOURCE_NOT_OFFICIAL');
    const diagnostic = `${error.message} ${JSON.stringify(error.details)}`;
    expect(diagnostic).toContain('example');
    expect(diagnostic).not.toContain('secret');
    expect(diagnostic).not.toContain('user:');
    expect(diagnostic).not.toContain('?token=');
  });
});

describe('default, scoped and parsed Bun configuration', () => {
  it('accepts official string and object scoped registries', () => {
    const value = {
      install: {
        registry: official,
        scopes: { '@types': official, '@fixture': { url: official } },
      },
    };
    expect(validateBunfig(value)).toEqual(value);
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { install: null },
    { install: { registry: 'https://registry.npmmirror.com' } },
    { install: { registry: official, scopes: [] } },
    { install: { registry: official, scopes: { '@types': 'https://registry.npmmirror.com' } } },
    { install: { registry: official, scopes: { '@types': { url: 'https://registry.npmmirror.com' } } } },
    { install: { registry: official, scopes: { '@types': { token: 'secret' } } } },
    { install: { registry: { url: official, username: 'user', password: 'secret' } } },
  ])('classifies invalid configuration without untyped property errors %#', config => {
    const error = sourceError(() => validateBunfig(config));
    expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain('secret');
  });

  it('validates a single framed parser response and Bun toolchain identity', () => {
    expect(parseBunfigOutput(JSON.stringify({ bunVersion: '1.4.0', config: acceptedConfig }))).toEqual(acceptedConfig);
  });

  it.each([
    ['', 'CONFIG_OUTPUT'],
    ['notice\n{"bunVersion":"1.4.0","config":{}}', 'CONFIG_OUTPUT'],
    ['{}', 'CONFIG_OUTPUT'],
    ['null', 'CONFIG_OUTPUT'],
    ['[]', 'CONFIG_OUTPUT'],
    ['{"bunVersion":"1.3.11","config":{}}', 'BUN_VERSION'],
    ['{"bunVersion":"1.4.0","config":null}', 'CONFIG_SHAPE'],
    ['{"bunVersion":"1.4.0","config":{},"config":{}}', 'CONFIG_OUTPUT'],
    ['/* not a JSON frame */ {"bunVersion":"1.4.0","config":{"install":{"registry":"https://registry.npmjs.org"}}}', 'CONFIG_OUTPUT'],
  ])('rejects malformed output or missing parser evidence %#', (stdout, code) => {
    expect(sourceError(() => parseBunfigOutput(stdout)).code).toBe(code);
  });

  it('does not expose parser output or config secrets on framing failure', () => {
    const error = sourceError(() => parseBunfigOutput('notice token=fixture-secret\n{"password":"fixture-secret"}'));
    expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain('fixture-secret');
  });
});

describe('dependency download preflight and environment isolation', () => {
  it('checks lock bytes and source counts without requiring Bun or creating files', () => {
    const root = fixture();
    const before = readdirSync(root);
    const bytes = readFileSync(join(root, 'bun.lock'));
    const report = checkDependencySources({ rootDir: root, env: { PATH: '' } });
    expect(report).toMatchObject({ packages: 1, npm: 1, explicit: 1, default: 0 });
    expect(report.lockSHA256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(readdirSync(root)).toEqual(before);
    expect(readFileSync(join(root, 'bun.lock'))).toEqual(bytes);
  });

  it.each(['NPM_CONFIG_REGISTRY', 'npm_config_registry', 'BUN_CONFIG_REGISTRY', 'bun_config_registry'])('rejects mirror %s before any Bun execution', key => {
    const root = fixture();
    const spawn = successfulSpawn();
    sourceError(() => installDependencies({ rootDir: root, env: { [key]: 'https://registry.npmmirror.com' } }, { spawnSync: spawn }));
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a malformed lock before calling a potentially absent Bun', () => {
    const root = fixture();
    writeFileSync(join(root, 'bun.lock'), '{"lockfileVersion":2}');
    const spawn = successfulSpawn();
    sourceError(() => installDependencies({ rootDir: root, env: { PATH: '' } }, { spawnSync: spawn }));
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects root npmrc without reading its credential-bearing contents', () => {
    const root = fixture();
    writeFileSync(join(root, '.npmrc'), 'registry=https://user:fixture-secret@registry.npmmirror.com\n');
    const spawn = successfulSpawn();
    const error = sourceError(() => installDependencies({ rootDir: root, env: {} }, { spawnSync: spawn }));
    expect(spawn).not.toHaveBeenCalled();
    expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain('fixture-secret');
  });

  it('strips child auth and dynamic configuration without mutating the simulated publishing parent', () => {
    const parent = {
      HOME: '/fixture/home', PATH: '/fixture/bin',
      HTTPS_PROXY: 'http://proxy.invalid:8080', NO_PROXY: 'localhost',
      NPM_TOKEN: 'npm-fixture-secret', NODE_AUTH_TOKEN: 'node-fixture-secret',
      NPM_CONFIG_REGISTRY: official, npm_config_userconfig: '/fixture/private-npmrc',
      BUN_CONFIG_REGISTRY: official, BUN_OPTIONS: '--preload=/fixture/inject.js',
      NODE_OPTIONS: '--require=/fixture/inject.cjs',
    };
    const before = { ...parent };
    const configDirectory = ownedDirectory();
    const child = createChildEnvironment(parent, configDirectory);
    expect(parent).toEqual(before);
    expect(child).toMatchObject({ HOME: parent.HOME, PATH: parent.PATH, HTTPS_PROXY: parent.HTTPS_PROXY, NO_PROXY: parent.NO_PROXY });
    for (const key of ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_CONFIG_REGISTRY', 'npm_config_userconfig', 'BUN_CONFIG_REGISTRY', 'BUN_OPTIONS', 'NODE_OPTIONS']) {
      expect(child[key], key).toBeUndefined();
    }
    expect(JSON.stringify(child)).not.toContain('fixture-secret');
    expect(parent.NODE_AUTH_TOKEN).toBe('node-fixture-secret');
  });

  it('requires explicit migration of legacy CA configuration instead of silently discarding it', () => {
    const root = fixture();
    const spawn = successfulSpawn();
    const error = sourceError(() => installDependencies({ rootDir: root, env: { NPM_CONFIG_CAFILE: '/fixture/legacy.pem' } }, { spawnSync: spawn }));
    expect(`${error.message} ${JSON.stringify(error.details)}`).toMatch(/cafile/i);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('controlled Bun parser and frozen installer invocation', () => {
  it('uses an existing empty npmrc and inert bootstrap config before its first Bun call', () => {
    const root = fixture();
    const beforeLock = readFileSync(join(root, 'bun.lock'));
    const beforeEnvironment = { ...isolatedEnvironment() };
    let parserDirectory = '';
    const spawn = successfulSpawn();
    spawn.mockImplementation((_command: string, args: string[], options: any) => {
      if (!args.includes('install')) {
        parserDirectory = options.cwd;
        expect(options.cwd).not.toBe(root);
        expect(args).toEqual(expect.arrayContaining(['--no-env-file', '--eval']));
        const configArgument = args.find(argument => argument.startsWith('--config='));
        expect(configArgument).toBeDefined();
        expect(Buffer.from(options.input)).toEqual(Buffer.from(configText));
        expect(readFileSync(join(options.env.XDG_CONFIG_HOME, '.npmrc'), 'utf8')).toBe('');
        expect(existsSync(configArgument!.slice('--config='.length))).toBe(true);
      } else {
        expect(args).toEqual(expect.arrayContaining(['install', '--frozen-lockfile', '--registry', official]));
        expect(options.cwd).toBe(root);
        const configArgument = args.find(argument => argument.startsWith('--config='));
        expect(configArgument).toBeDefined();
        expect(readFileSync(configArgument!.slice('--config='.length), 'utf8')).toContain(official);
      }
      return { status: 0, signal: null, stdout: args.includes('install') ? '' : JSON.stringify({ bunVersion: '1.4.0', config: acceptedConfig }), stderr: '' };
    });
    installDependencies({ rootDir: root, env: beforeEnvironment }, { spawnSync: spawn });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(existsSync(parserDirectory)).toBe(false);
    expect(readFileSync(join(root, 'bun.lock'))).toEqual(beforeLock);
    expect(beforeEnvironment).toEqual(isolatedEnvironment());
  });

  it('stops after the inert parser when scoped registry validation fails', () => {
    const root = fixture();
    const spawn = successfulSpawn({ install: { registry: official, scopes: { '@fixture': 'https://registry.npmmirror.com' } } });
    sourceError(() => installDependencies({ rootDir: root, env: {} }, { spawnSync: spawn }));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).not.toContain('install');
  });

  it.each([
    { status: 1, signal: null, stdout: '', stderr: 'credential=fixture-secret' },
    { status: null, signal: 'SIGTERM', stdout: '', stderr: 'fixture-secret' },
    { status: null, signal: null, error: new Error('fixture-secret'), stdout: '', stderr: '' },
  ])('classifies a parser process failure without leaking raw output %#', failure => {
    const spawn = vi.fn(() => failure);
    const error = sourceError(() => installDependencies({ rootDir: fixture(), env: {} }, { spawnSync: spawn }));
    expect(error.code).toBe('CONFIG_EXECUTION');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain('fixture-secret');
  });

  it('does not retry an installer failure or expose its raw stderr', () => {
    const spawn = successfulSpawn();
    spawn.mockImplementation((_command, args) => args.includes('install')
      ? { status: 3, signal: null, stdout: '', stderr: 'token=fixture-secret' }
      : { status: 0, signal: null, stdout: JSON.stringify({ bunVersion: '1.4.0', config: acceptedConfig }), stderr: '' });
    const error = sourceError(() => installDependencies({ rootDir: fixture(), env: {} }, { spawnSync: spawn }));
    expect(error.code).toBe('INSTALL_EXECUTION');
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain('fixture-secret');
  });

  it('resolves an explicit relative CA file against the repository root', () => {
    const root = fixture();
    mkdirSync(join(root, 'certificates'));
    const ca = join(root, 'certificates', 'fixture.pem');
    writeFileSync(ca, 'synthetic-test-certificate');
    const spawn = successfulSpawn();
    installDependencies({ rootDir: root, env: {}, args: ['--cafile', 'certificates/fixture.pem'] }, { spawnSync: spawn });
    const installer = spawn.mock.calls.find(([, args]) => args.includes('install'))!;
    expect(installer[1]).toEqual(expect.arrayContaining(['--cafile', ca]));
  });

  it('performs check mode without parser, installer, or temporary configuration files', () => {
    const root = fixture();
    const before = readdirSync(root);
    const spawn = successfulSpawn();
    installDependencies({ rootDir: root, env: { PATH: '' }, args: ['--check'] }, { spawnSync: spawn });
    expect(spawn).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual(before);
  });

  it.each([
    ['--registry', 'https://registry.npmmirror.com'],
    ['--no-verify'], ['--ignore-scripts'], ['--force'], ['example'], ['--'],
    ['--cafile'], ['--cache-dir'], ['--check', '--execute'],
    ['--cache-dir', 'first', '--cache-dir', 'second'],
  ].map(args => ({ args })))('does not pass through unreviewed arguments $args', ({ args }) => {
    sourceError(() => parseArguments(args, repository));
  });

  it('accepts supported check and path options as complete argument arrays', () => {
    expect(parseArguments(['--check'], repository)).toMatchObject({ check: true });
    expect(parseArguments(['--cache-dir', 'cache-fixture', '--cafile', 'ca-fixture.pem'], repository)).toMatchObject({
      check: false,
      cacheDir: join(repository, 'cache-fixture'),
      cafile: join(repository, 'ca-fixture.pem'),
    });
  });
});

describe('dependency-free preinstall CLI', () => {
  it.each([false, true])('runs --check without Bun or node_modules, invalidLock=%s', invalidLock => {
    const root = fixture();
    const script = join(root, 'scripts', 'ci', 'install-dependencies.mjs');
    mkdirSync(dirname(script), { recursive: true });
    copyFileSync(join(repository, 'scripts', 'ci', 'install-dependencies.mjs'), script);
    if (invalidLock) writeFileSync(join(root, 'bun.lock'), '{"lockfileVersion":2}');
    const node = testExecutable('node', isolatedEnvironment());
    const env = isolatedEnvironment({ PATH: '' });
    const before = readdirSync(root);
    const result = spawnSync(node, [script, '--check'], { cwd: root, env, encoding: 'utf8', timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(invalidLock ? 1 : 0);
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
    expect(readdirSync(root)).toEqual(before);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/ENOENT|Cannot find (?:module|package)/);
    if (invalidLock) expect(`${result.stdout}${result.stderr}`).toMatch(/[A-Z][A-Z0-9_]+/);
  });
});

describe('Bun 1.4.0 installed configuration isolation', () => {
  it('ignores hostile HOME, dotenv and dynamic-loading inputs during real dependency-free frozen installation', () => {
    const root = fixture({ '@fixture/local': ['@fixture/local@workspace:packages/local'] });
    const home = join(root, 'synthetic-home');
    mkdirSync(home);
    const local = join(root, 'packages', 'local');
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, 'package.json'), JSON.stringify({ name: '@fixture/local', version: '1.0.0' }));
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'source-fixture', private: true, workspaces: ['packages/*'],
      dependencies: { '@fixture/local': 'workspace:*' },
    }));
    const frozen = lock({ '@fixture/local': ['@fixture/local@workspace:packages/local'] });
    frozen.workspaces[''].dependencies = { '@fixture/local': 'workspace:*' };
    writeFileSync(join(root, 'bun.lock'), JSON.stringify(frozen));
    const marker = join(root, 'dynamic-loading-should-not-run');
    const preload = join(root, 'hostile-preload.cjs');
    writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'EXECUTED'); throw new Error('HOSTILE_DYNAMIC_LOAD');`);
    const mirror = 'http://127.0.0.1:1';
    const globalNpmrc = `registry=${mirror}\n//registry.npmjs.org/:_authToken=global-fixture-secret\n`;
    const globalBunfig = `preload = [${JSON.stringify(preload)}]\n[install]\nregistry = ${JSON.stringify(mirror)}\n`;
    writeFileSync(join(home, '.npmrc'), globalNpmrc);
    writeFileSync(join(home, '.bunfig.toml'), globalBunfig);
    writeFileSync(join(root, '.env'), [
      `NPM_CONFIG_REGISTRY=${mirror}`,
      `BUN_CONFIG_REGISTRY=${mirror}`,
      `NODE_OPTIONS=--require=${preload}`,
      `BUN_OPTIONS=--preload=${preload}`,
      'NODE_AUTH_TOKEN=dotenv-fixture-secret',
    ].join('\n'));
    const env = isolatedEnvironment({
      HOME: home, USERPROFILE: home,
      NODE_OPTIONS: `--require=${preload}`,
      BUN_OPTIONS: `--preload=${preload}`,
      NODE_AUTH_TOKEN: 'parent-publish-fixture-secret',
      NPM_TOKEN: 'parent-npm-fixture-secret',
    });
    const beforeEnvironment = { ...env };
    const beforeLock = readFileSync(join(root, 'bun.lock'));
    const bun = testExecutable('bun', isolatedEnvironment());
    const calls: { args: string[]; result: ReturnType<typeof spawnSync> }[] = [];
    const spawn = (_command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => {
      expect(_command).toBe('bun');
      expect(options.env).toMatchObject({ HOME: home });
      for (const key of ['NODE_OPTIONS', 'BUN_OPTIONS', 'NODE_AUTH_TOKEN', 'NPM_TOKEN']) {
        expect(options.env?.[key], key).toBeUndefined();
      }
      const result = spawnSync(bun, args, options);
      calls.push({ args: [...args], result });
      return result;
    };
    installDependencies({ rootDir: root, env }, { spawnSync: spawn });
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toContain('--eval');
    expect(calls[1].args).toContain('install');
    for (const { args, result } of calls) {
      expect(result.error, args.join(' ')).toBeUndefined();
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toMatch(/HOSTILE_DYNAMIC_LOAD|fixture-secret|127\.0\.0\.1:1/);
    }
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(home, '.npmrc'), 'utf8')).toBe(globalNpmrc);
    expect(readFileSync(join(home, '.bunfig.toml'), 'utf8')).toBe(globalBunfig);
    expect(env).toEqual(beforeEnvironment);
    expect(env.NODE_AUTH_TOKEN).toBe('parent-publish-fixture-secret');
    expect(readFileSync(join(root, 'bun.lock'))).toEqual(beforeLock);
  });
});

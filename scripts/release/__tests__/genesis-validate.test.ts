import { executableCandidates } from '../../../packages/core/src/process-discovery.js';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryRoots: string[] = [];
const describeOnBashHosts = process.platform === 'win32' ? describe.skip : describe;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describeOnBashHosts('genesis validation Python selection', () => {
  it('falls back to python3 when python exists without PyYAML', () => {
    const fixture = createFixture();
    writePythonFixture(fixture.bin, 'python', { yamlAvailable: false, parseSucceeds: false });
    writePythonFixture(fixture.bin, 'python3', { yamlAvailable: true, parseSucceeds: true });

    const result = runGenesis(fixture);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[1/5] openslack.yaml ... PASS');
    expect(readFileSync(fixture.pythonLog, 'utf-8').trim().split('\n')).toEqual([
      'python:probe',
      'python3:probe',
      'python3:parse',
    ]);
  });

  it('distinguishes missing PyYAML from invalid YAML', () => {
    const fixture = createFixture();
    writePythonFixture(fixture.bin, 'python', { yamlAvailable: false, parseSucceeds: false });
    writePythonFixture(fixture.bin, 'python3', { yamlAvailable: false, parseSucceeds: false });

    const result = runGenesis(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[1/5] openslack.yaml ... FAIL (PyYAML not installed)');
    expect(result.stdout).not.toContain('FAIL (invalid YAML)');
  });

  it('fails closed with a distinct diagnostic when no interpreter exists', () => {
    const fixture = createFixture();

    const result = runGenesis(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[1/5] openslack.yaml ... FAIL (python/python3 not found)');
    expect(result.stdout).not.toContain('FAIL (PyYAML not installed)');
    expect(result.stdout).not.toContain('FAIL (invalid YAML)');
  });

  it('still reports invalid YAML after selecting a PyYAML-capable interpreter', () => {
    const fixture = createFixture();
    writePythonFixture(fixture.bin, 'python3', { yamlAvailable: true, parseSucceeds: false });

    const result = runGenesis(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[1/5] openslack.yaml ... FAIL (invalid YAML)');
  });
});

describeOnBashHosts('genesis validation secret scan', () => {
  it('reports secrets in tracked, untracked and binary files and honours exclusions', () => {
    const fixture = createFixture();
    seedSecretFixture(fixture.root);

    const result = runGenesis(fixture);

    expect(result.stdout).toContain('[4/5] secret scan ... FAIL (potential secret in:');
    for (const reported of ['src/leak.ts', 'src/leak2.ts', 'untracked.ts', 'binary.bin']) {
      expect(result.stdout).toContain(reported);
    }
    for (const excluded of [
      'src/__tests__/allowed.test.ts',
      'src/__tests__/deep/nested/deep.test.ts',
      '__tests__/toplevel.test.ts',
      'docs/security/collaboration-audit.md',
      'ignored.ts',
    ]) {
      expect(result.stdout).not.toContain(excluded);
    }
  });

  it('passes when only excluded locations contain the pattern', () => {
    const fixture = createFixture();
    writeSecret(fixture.root, 'src/__tests__/allowed.test.ts');
    writeSecret(fixture.root, 'src/__tests__/deep/nested/deep.test.ts');
    writeSecret(fixture.root, '__tests__/toplevel.test.ts');
    writeSecret(fixture.root, 'docs/security/collaboration-audit.md');
    addTrackedFiles(fixture.root);

    const result = runGenesis(fixture);

    expect(result.stdout).toContain('[4/5] secret scan ... PASS');
  });

  it('does not over-exclude near-miss directory names', () => {
    const fixture = createFixture();
    writeSecret(fixture.root, 'src/__tests__x/notexcluded.ts');
    writeSecret(fixture.root, 'a__tests__/x.ts');
    addTrackedFiles(fixture.root);

    const result = runGenesis(fixture);

    expect(result.stdout).toContain('src/__tests__x/notexcluded.ts');
    expect(result.stdout).toContain('a__tests__/x.ts');
  });

  it('ignores files excluded by the repository ignore rules', () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.root, '.gitignore'), 'ignored.ts\n', 'utf-8');
    writeSecret(fixture.root, 'ignored.ts');
    addTrackedFiles(fixture.root);

    const result = runGenesis(fixture);

    expect(result.stdout).toContain('[4/5] secret scan ... PASS');
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "openslack-genesis-'python-"));
  temporaryRoots.push(root);
  const bin = join(root, 'bin');
  const scripts = join(root, 'scripts');
  const pythonLog = join(root, 'python.log');
  mkdirSync(bin, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  for (const directory of [
    '.openslack/self',
    '.openslack/policies',
    '.openslack/agents/registry',
    '.openslack/tasks',
    '.openslack/leases',
    '.openslack/audit',
  ]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFileSync(join(root, 'openslack.yaml'), 'schema: openslack.workspace.v1\n', 'utf-8');
  writeFileSync(join(root, '.openslack/self/constitution.md'), '# Constitution\n', 'utf-8');
  copyFileSync(
    resolve(import.meta.dirname, '..', '..', 'genesis-validate.sh'),
    join(scripts, 'genesis-validate.sh'),
  );
  for (const executable of ['dirname', 'git', 'grep']) {
    symlinkSync(resolveExecutable(executable), join(bin, executable));
  }
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' });
  return { root, bin, pythonLog };
}

function writePythonFixture(
  bin: string,
  name: 'python' | 'python3',
  behavior: { yamlAvailable: boolean; parseSucceeds: boolean },
): void {
  const path = join(bin, name);
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'if [ "$2" = "import yaml; assert callable(yaml.safe_load)" ]; then',
      `  printf '%s:probe\\n' '${name}' >> "$GENESIS_PYTHON_LOG"`,
      `  exit ${behavior.yamlAvailable ? 0 : 1}`,
      'fi',
      `printf '%s:parse\\n' '${name}' >> "$GENESIS_PYTHON_LOG"`,
      `exit ${behavior.parseSucceeds ? 0 : 1}`,
      '',
    ].join('\n'),
    'utf-8',
  );
  chmodSync(path, 0o755);
}

function runGenesis(fixture: ReturnType<typeof createFixture>) {
  return spawnSync('/bin/bash', [join(fixture.root, 'scripts/genesis-validate.sh')], {
    cwd: fixture.root,
    env: {
      ...process.env,
      PATH: fixture.bin,
      GENESIS_PYTHON_LOG: fixture.pythonLog,
    },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function resolveExecutable(name: string): string {
  for (const candidate of executableCandidates(name)) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${name} is required for the genesis validation fixture.`);
}

const SECRET_TOKEN = 'sk-abcdefghijklmnopqrstuvwxyz012345';
const SECRET_KEY_HEADER = '-----BEGIN RSA PRIVATE KEY-----';

function writeSecret(
  root: string,
  relative: string,
  contents = `const token = '${SECRET_TOKEN}';\n`,
): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

/** Stage everything written so far so the fixture has tracked files. */
function addTrackedFiles(root: string): void {
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' });
}

/**
 * Seed one location per scan rule. `untracked.ts` is written after staging so
 * it stays untracked-but-not-ignored, which the scan must still report.
 */
function seedSecretFixture(root: string): void {
  writeSecret(root, 'src/clean.ts', 'export const ok = 1;\n');
  writeSecret(root, 'src/leak.ts');
  writeSecret(root, 'src/leak2.ts', `/* ${SECRET_KEY_HEADER} */\n`);
  writeSecret(root, 'src/__tests__/allowed.test.ts');
  writeSecret(root, 'src/__tests__/deep/nested/deep.test.ts');
  writeSecret(root, '__tests__/toplevel.test.ts');
  writeSecret(root, 'src/__tests__x/notexcluded.ts');
  writeSecret(root, 'a__tests__/x.ts');
  writeSecret(root, 'docs/security/collaboration-audit.md');
  writeSecret(root, 'ignored.ts');
  writeFileSync(join(root, '.gitignore'), 'ignored.ts\n', 'utf-8');
  writeFileSync(
    join(root, 'binary.bin'),
    Buffer.concat([
      Buffer.from([0, 1, 2]),
      Buffer.from(SECRET_KEY_HEADER, 'ascii'),
      Buffer.from([0, 3]),
    ]),
  );
  addTrackedFiles(root);
  writeSecret(root, 'untracked.ts');
}

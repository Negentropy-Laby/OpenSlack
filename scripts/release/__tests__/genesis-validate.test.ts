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
import { delimiter, join, resolve } from 'node:path';
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

  it('still reports invalid YAML after selecting a PyYAML-capable interpreter', () => {
    const fixture = createFixture();
    writePythonFixture(fixture.bin, 'python3', { yamlAvailable: true, parseSucceeds: false });

    const result = runGenesis(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[1/5] openslack.yaml ... FAIL (invalid YAML)');
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
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${name} is required for the genesis validation fixture.`);
}

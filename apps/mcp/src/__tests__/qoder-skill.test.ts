import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  OPENSLACK_DEMO_RESET_TOOL_NAME,
  OPENSLACK_MUTATION_TOOL_NAMES,
  OPENSLACK_READ_TOOL_NAMES,
} from '@openslack/qoder-adapter';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const skillRoot = join(
  repositoryRoot,
  'integrations',
  'qoder-work',
  'skills',
  'openslack-organization-control',
);
const temporaryRoots: string[] = [];
const bashAvailable = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;
const powershellAvailable =
  spawnSync('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
    encoding: 'utf8',
  }).status === 0;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-qoder-skill-'));
  temporaryRoots.push(root);
  return root;
}

function files(root: string): string[] {
  const result: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else result.push(path);
    }
  };
  walk(root);
  return result.sort();
}

function shellPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const windowsDrive = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  return windowsDrive ? `/mnt/${windowsDrive[1]!.toLowerCase()}/${windowsDrive[2]!}` : normalized;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

describe('Qoder Organization Control Skill qualification', () => {
  it('has canonical frontmatter, valid relative links, and only the exact catalog profiles', () => {
    const skill = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');
    expect(skill).toMatch(
      /^---\r?\nname: openslack-organization-control\r?\ndescription: [^\r\n]+\r?\n---\r?\n/,
    );
    const allText = files(skillRoot)
      .filter((path) => /\.(?:md|yaml)$/.test(path))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    const observedTools = [...new Set(allText.match(/openslack_[a-z_]+/g) ?? [])].sort();
    expect(observedTools).toEqual(
      [
        ...OPENSLACK_READ_TOOL_NAMES,
        ...OPENSLACK_MUTATION_TOOL_NAMES,
        OPENSLACK_DEMO_RESET_TOOL_NAME,
      ].sort(),
    );
    expect(allText).toMatch(/exact 12, 16, or 17\s+production profiles/);
    expect(allText).toMatch(/one-time root\s+`confirmationToken`/);
    expect(allText).toMatch(/never creates a GitHub review/);
    expect(allText).not.toMatch(/run_shell|raw_command|direct_merge|approve_github_pr/);

    for (const path of files(skillRoot).filter((value) => value.endsWith('.md'))) {
      const text = readFileSync(path, 'utf8');
      for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = match[1]!;
        if (/^(?:https?:|#)/.test(target)) continue;
        expect(isAbsolute(target), `${path}: ${target}`).toBe(false);
        expect(existsSync(resolve(dirname(path), target)), `${path}: ${target}`).toBe(true);
      }
    }
  });

  it.runIf(bashAvailable)(
    'runs the Bash installer idempotently with an explicit temp override and rejects unsafe targets',
    () => {
      const target = tempRoot();
      const script = shellPath(join(skillRoot, 'install', 'install.sh'));
      const shellTarget = shellPath(target);
      const first = spawnSync('bash', [script, '--target-root', shellTarget], { encoding: 'utf8' });
      expect(first.status, first.stderr).toBe(0);
      const installed = join(target, 'openslack-organization-control');
      expect(existsSync(join(installed, 'SKILL.md'))).toBe(true);
      const before = files(installed).map((path) => readFileSync(path).toString('base64'));
      const second = spawnSync('bash', [script, '--target-root', shellTarget], {
        encoding: 'utf8',
      });
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain('already up to date');
      expect(files(installed).map((path) => readFileSync(path).toString('base64'))).toEqual(before);
      expect(
        spawnSync('bash', [script, '--target-root', 'relative/path'], { encoding: 'utf8' }).status,
      ).not.toBe(0);
      expect(
        spawnSync('bash', [script, '--target-root', '/'], { encoding: 'utf8' }).status,
      ).not.toBe(0);
      expect(
        spawnSync('bash', [script, '--target-root', '/tmp/..'], { encoding: 'utf8' }).status,
      ).not.toBe(0);
      expect(
        spawnSync('bash', [script, '--target-root', '/tmp'], { encoding: 'utf8' }).status,
      ).not.toBe(0);
    },
    30_000,
  );

  it.runIf(bashAvailable)('rejects a symlink component in a Bash installer target', () => {
    const script = shellPath(join(skillRoot, 'install', 'install.sh'));
    const result = spawnSync(
      'bash',
      [
        '-c',
        [
          'set -u',
          'test_root="$(mktemp -d)"',
          'trap \'rm -rf -- "$test_root"\' EXIT',
          'mkdir -p -- "$test_root/real"',
          'ln -s -- "$test_root/real" "$test_root/link"',
          `${shellQuote(script)} --target-root "$test_root/link/nested"`,
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('symlink component');
  });

  it.runIf(powershellAvailable)(
    'runs the PowerShell installer idempotently and rejects a relative override',
    () => {
      const target = tempRoot();
      const script = join(skillRoot, 'install', 'install.ps1');
      const command = [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-TargetRoot',
        target,
      ];
      const first = spawnSync('powershell', command, { encoding: 'utf8' });
      expect(first.status, first.stderr).toBe(0);
      const second = spawnSync('powershell', command, { encoding: 'utf8' });
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain('already up to date');
      const rejected = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-TargetRoot',
          'relative/path',
        ],
        { encoding: 'utf8' },
      );
      expect(rejected.status).not.toBe(0);

      const filesystemRootAlias = `${join(parse(target).root, 'openslack-root-alias')}${sep}..`;
      const broad = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-TargetRoot',
          filesystemRootAlias,
        ],
        { encoding: 'utf8' },
      );
      expect(broad.status).not.toBe(0);
      expect(broad.stderr).toContain('broad directory');

      const junctionRoot = tempRoot();
      const real = join(junctionRoot, 'real');
      const link = join(junctionRoot, 'link');
      mkdirSync(real);
      symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      const reparse = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-TargetRoot',
          join(link, 'nested'),
        ],
        { encoding: 'utf8' },
      );
      expect(reparse.status).not.toBe(0);
      expect(reparse.stderr).toContain('reparse-point component');
    },
    30_000,
  );
});

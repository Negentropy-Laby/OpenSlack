import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export type ReleaseTarget = 'windows-x64' | 'linux-x64';

export interface TargetDefinition {
  id: ReleaseTarget;
  bunTarget: 'bun-windows-x64' | 'bun-linux-x64';
  executable: 'openslack.exe' | 'openslack';
  archiveExtension: '.zip' | '.tar.gz';
  nativePackage: '@napi-rs/keyring-win32-x64-msvc' | '@napi-rs/keyring-linux-x64-gnu';
  nativeFile: 'keyring.win32-x64-msvc.node' | 'keyring.linux-x64-gnu.node';
}

export const TARGETS: Record<ReleaseTarget, TargetDefinition> = {
  'windows-x64': {
    id: 'windows-x64',
    bunTarget: 'bun-windows-x64',
    executable: 'openslack.exe',
    archiveExtension: '.zip',
    nativePackage: '@napi-rs/keyring-win32-x64-msvc',
    nativeFile: 'keyring.win32-x64-msvc.node',
  },
  'linux-x64': {
    id: 'linux-x64',
    bunTarget: 'bun-linux-x64',
    executable: 'openslack',
    archiveExtension: '.tar.gz',
    nativePackage: '@napi-rs/keyring-linux-x64-gnu',
    nativeFile: 'keyring.linux-x64-gnu.node',
  },
};

export function hostTarget(): ReleaseTarget {
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-x64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  throw new Error(`Unsupported release host: ${process.platform}-${process.arch}`);
}

export function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf-8',
    stdio: 'pipe',
    windowsHide: true,
  });
  if (!options.allowFailure && (result.error || result.status !== 0)) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim().slice(-4000);
    throw new Error(`${command} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

export function findExecutable(name: string): string {
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    for (const suffix of suffixes) {
      const candidate = join(directory, `${name}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`${name} is required for release verification.`);
}

export function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

export interface GitContentState {
  dirty: boolean;
  staged: boolean;
  unstaged: boolean;
  untracked: string[];
}

/**
 * Determine whether a release checkout contains content that is not represented
 * by HEAD. `git status --porcelain` is deliberately not used here: on Windows a
 * CRLF/stat refresh can report `.M` even when the index and worktree blobs are
 * byte-identical. Release provenance must describe content, not filesystem stat
 * cache noise.
 */
export function getGitContentState(root: string): GitContentState {
  const staged = gitDiffHasContent(root, [
    'diff',
    '--cached',
    '--quiet',
    '--ignore-submodules',
    '--',
  ]);
  const unstaged = gitDiffHasContent(root, ['diff', '--quiet', '--ignore-submodules', '--']);
  const untrackedResult = run('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    allowFailure: true,
  });
  if (untrackedResult.error || untrackedResult.status !== 0) {
    throw new Error('git failed while checking untracked release inputs.');
  }
  const untracked = String(untrackedResult.stdout ?? '')
    .split('\0')
    .filter(Boolean)
    .sort();
  return { dirty: staged || unstaged || untracked.length > 0, staged, unstaged, untracked };
}

function gitDiffHasContent(root: string, args: string[]): boolean {
  const result = run('git', args, { cwd: root, allowFailure: true });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error('git failed while checking release content state.');
  }
  return result.status === 1;
}

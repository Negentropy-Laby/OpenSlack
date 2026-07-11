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

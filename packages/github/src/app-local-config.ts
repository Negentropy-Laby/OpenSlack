import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseSecretReference } from '@openslack/credentials';
import { isGitHubAppSlug } from './app-slug.js';

export interface GitHubAppLocalConfig {
  schema: 'openslack.github_app_local.v1';
  appId: string;
  installationId: string | null;
  appSlug: string;
  privateKeyRef: string;
}

export class GitHubAppLocalConfigError extends Error {
  readonly code = 'APP_LOCAL_CONFIG_INVALID';

  constructor(message = 'GitHub App local configuration is invalid.') {
    super(message);
    this.name = 'GitHubAppLocalConfigError';
  }
}

function sameFileIdentity(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.ctimeMs === right.ctimeMs &&
    left.mtimeMs === right.mtimeMs
  );
}

function readStableConfig(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || before.size <= 0 || before.size > 65_536) {
      throw new GitHubAppLocalConfigError();
    }
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(fd, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(fd);
    const pathStat = lstatSync(path);
    if (
      offset !== bytes.byteLength ||
      !sameFileIdentity(before, after) ||
      pathStat.isSymbolicLink() ||
      !sameFileIdentity(after, pathStat)
    ) {
      throw new GitHubAppLocalConfigError();
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new GitHubAppLocalConfigError();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
    if (error instanceof GitHubAppLocalConfigError) throw error;
    throw new GitHubAppLocalConfigError();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readGitHubAppLocalConfig(
  localStateRoot: string | undefined,
): GitHubAppLocalConfig | null {
  if (!localStateRoot) return null;
  const path = join(resolve(localStateRoot), 'github-app.json');
  const content = readStableConfig(path);
  if (content === null) return null;

  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw new GitHubAppLocalConfigError();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitHubAppLocalConfigError();
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schema !== 'openslack.github_app_local.v1' ||
    typeof candidate.appId !== 'string' ||
    !/^\d+$/.test(candidate.appId) ||
    !(
      candidate.installationId === null ||
      (typeof candidate.installationId === 'string' && /^\d+$/.test(candidate.installationId))
    ) ||
    !isGitHubAppSlug(candidate.appSlug) ||
    typeof candidate.privateKeyRef !== 'string'
  ) {
    throw new GitHubAppLocalConfigError();
  }
  try {
    const reference = parseSecretReference(candidate.privateKeyRef);
    if (reference.scheme !== 'keychain') throw new GitHubAppLocalConfigError();
  } catch {
    throw new GitHubAppLocalConfigError();
  }
  return candidate as unknown as GitHubAppLocalConfig;
}

export function bindGitHubAppInstallation(
  localStateRoot: string,
  installationId: string,
): { config: GitHubAppLocalConfig; changed: boolean } {
  if (!/^\d+$/.test(installationId)) throw new GitHubAppLocalConfigError();
  const current = readGitHubAppLocalConfig(localStateRoot);
  if (!current) throw new GitHubAppLocalConfigError('GitHub App local configuration is missing.');
  if (current.installationId !== null) {
    if (current.installationId !== installationId) {
      throw new GitHubAppLocalConfigError(
        'GitHub App local configuration is already bound to another installation.',
      );
    }
    return { config: current, changed: false };
  }

  const config = { ...current, installationId };
  const path = join(resolve(localStateRoot), 'github-app.json');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, path);
  } catch {
    throw new GitHubAppLocalConfigError(
      'GitHub App installation binding could not be saved safely.',
    );
  } finally {
    rmSync(temporary, { force: true });
  }
  return { config, changed: true };
}

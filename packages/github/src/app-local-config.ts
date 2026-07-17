import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

export function readGitHubAppLocalConfig(
  localStateRoot: string | undefined,
): GitHubAppLocalConfig | null {
  if (!localStateRoot) return null;
  const path = join(resolve(localStateRoot), 'github-app.json');
  let content: string;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 65_536) {
      throw new GitHubAppLocalConfigError();
    }
    content = readFileSync(path, 'utf-8');
  } catch (error) {
    if (error instanceof GitHubAppLocalConfigError) throw error;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return null;
    throw new GitHubAppLocalConfigError();
  }

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

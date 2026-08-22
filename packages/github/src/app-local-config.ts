import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseSecretReference } from '@openslack/credentials';
import { isGitHubAppSlug } from './app-slug.js';
import { POSITIVE_GITHUB_ID_PATTERN } from './app-jwt.js';
import { readStableLocalUtf8 } from './stable-local-file.js';

export interface GitHubAppLocalConfig {
  schema: 'openslack.github_app_local.v1';
  appId: string;
  installationId: string | null;
  appSlug: string;
  privateKeyRef: string;
  clientId?: string;
  webhookSecretRef?: string;
  clientSecretRef?: string;
}

export class GitHubAppLocalConfigError extends Error {
  readonly code = 'APP_LOCAL_CONFIG_INVALID';

  constructor(message = 'GitHub App local configuration is invalid.') {
    super(message);
    this.name = 'GitHubAppLocalConfigError';
  }
}

function readStableConfig(path: string): string | null {
  try {
    return readStableLocalUtf8(path, { maxBytes: 65_536 });
  } catch {
    throw new GitHubAppLocalConfigError();
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
  const requiredKeys = ['schema', 'appId', 'installationId', 'appSlug', 'privateKeyRef'];
  const manifestKeys = ['clientId', 'webhookSecretRef', 'clientSecretRef'];
  const keys = Object.keys(candidate);
  const hasManifestFields = manifestKeys.some((key) => key in candidate);
  const expectedKeys = new Set(
    hasManifestFields ? [...requiredKeys, ...manifestKeys] : requiredKeys,
  );
  if (
    keys.length !== expectedKeys.size ||
    keys.some((key) => !expectedKeys.has(key)) ||
    candidate.schema !== 'openslack.github_app_local.v1' ||
    typeof candidate.appId !== 'string' ||
    !POSITIVE_GITHUB_ID_PATTERN.test(candidate.appId) ||
    !(
      candidate.installationId === null ||
      (typeof candidate.installationId === 'string' &&
        POSITIVE_GITHUB_ID_PATTERN.test(candidate.installationId))
    ) ||
    !isGitHubAppSlug(candidate.appSlug) ||
    typeof candidate.privateKeyRef !== 'string' ||
    (hasManifestFields &&
      (typeof candidate.clientId !== 'string' ||
        !/^[A-Za-z0-9._-]{3,128}$/u.test(candidate.clientId) ||
        typeof candidate.webhookSecretRef !== 'string' ||
        typeof candidate.clientSecretRef !== 'string'))
  ) {
    throw new GitHubAppLocalConfigError();
  }
  try {
    const references = [candidate.privateKeyRef];
    if (hasManifestFields) {
      references.push(candidate.webhookSecretRef as string, candidate.clientSecretRef as string);
    }
    const parsed = references.map((reference) => parseSecretReference(reference));
    if (
      parsed.some((reference) => reference.scheme !== 'keychain') ||
      new Set(references).size !== references.length
    ) {
      throw new GitHubAppLocalConfigError();
    }
  } catch {
    throw new GitHubAppLocalConfigError();
  }
  return candidate as unknown as GitHubAppLocalConfig;
}

export function bindGitHubAppInstallation(
  localStateRoot: string,
  installationId: string,
): { config: GitHubAppLocalConfig; changed: boolean } {
  if (!POSITIVE_GITHUB_ID_PATTERN.test(installationId)) throw new GitHubAppLocalConfigError();
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

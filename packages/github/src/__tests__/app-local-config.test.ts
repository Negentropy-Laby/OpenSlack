import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bindGitHubAppInstallation, readGitHubAppLocalConfig } from '../app-local-config.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('GitHub App non-secret local config', () => {
  it('binds an App Manifest config once and remains idempotent', () => {
    const root = localState({ installationId: null });

    expect(readGitHubAppLocalConfig(root)).toMatchObject({ installationId: null });
    expect(bindGitHubAppInstallation(root, '456')).toMatchObject({
      changed: true,
      config: { installationId: '456' },
    });
    expect(bindGitHubAppInstallation(root, '456')).toMatchObject({ changed: false });
    expect(() => bindGitHubAppInstallation(root, '789')).toThrow(
      'already bound to another installation',
    );
    expect(readFileSync(join(root, 'github-app.json'), 'utf-8')).not.toContain(
      'private-key-canary',
    );
  });

  it('rejects invalid credential references before credential access', () => {
    const root = localState({ privateKeyRef: 'file:private.pem' });
    expect(() => readGitHubAppLocalConfig(root)).toThrow('local configuration is invalid');
  });
});

function localState(
  override: Partial<{
    installationId: string | null;
    privateKeyRef: string;
  }>,
): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-app-config-'));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'github-app.json'),
    `${JSON.stringify(
      {
        schema: 'openslack.github_app_local.v1',
        appId: '123',
        installationId: '456',
        appSlug: 'local-app',
        privateKeyRef: 'keychain:openslack/test-app',
        ...override,
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

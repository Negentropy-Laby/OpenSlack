import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GitHubAuthRequiredError,
  getClient,
  parseGitHubRepoSpec,
  resolveGitHubRepoTarget,
} from '../client.js';

const ENV_KEYS = [
  'GITHUB_OWNER',
  'GITHUB_REPO',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENSLACK_GITHUB_AUTH_MODE',
  'OPENSLACK_GITHUB_APP_ID',
  'OPENSLACK_GITHUB_APP_INSTALLATION_ID',
  'OPENSLACK_GITHUB_APP_PRIVATE_KEY',
  'OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN',
] as const;

const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  originalEnv.clear();
});

describe('GitHub client repository and auth resolution', () => {
  it('parses shorthand, HTTPS, and SSH GitHub repository references', () => {
    expect(parseGitHubRepoSpec('Negentropy-Laby/OpenSlack')).toEqual({
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
    });
    expect(parseGitHubRepoSpec('https://github.com/Negentropy-Laby/OpenSlack.git')).toEqual({
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
    });
    expect(parseGitHubRepoSpec('git@github.com:Negentropy-Laby/OpenSlack.git')).toEqual({
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
    });
  });

  it('prefers explicit repo over environment repo', () => {
    process.env.GITHUB_OWNER = 'env-owner';
    process.env.GITHUB_REPO = 'env-repo';

    expect(resolveGitHubRepoTarget({ repoFullName: 'explicit-owner/explicit-repo' })).toEqual({
      owner: 'explicit-owner',
      repo: 'explicit-repo',
      source: 'explicit',
    });
  });

  it('rejects invalid explicit repo instead of falling back to origin', () => {
    process.env.GITHUB_OWNER = 'env-owner';
    process.env.GITHUB_REPO = 'env-repo';

    expect(() => resolveGitHubRepoTarget({ repoFullName: 'not a github repo' })).toThrow(
      'Invalid GitHub repository',
    );
  });

  it('uses environment owner and repo when explicit repo is absent', () => {
    process.env.GITHUB_OWNER = 'Negentropy-Laby';
    process.env.GITHUB_REPO = 'OpenSlack';

    expect(resolveGitHubRepoTarget()).toEqual({
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      source: 'env',
    });
  });

  it('uses git remote origin when explicit repo and env repo are absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openslack-gh-client-'));
    try {
      execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
      execFileSync(
        'git',
        ['remote', 'add', 'origin', 'https://github.com/Negentropy-Laby/OpenSlack.git'],
        {
          cwd: dir,
          stdio: 'ignore',
        },
      );

      expect(resolveGitHubRepoTarget({ cwd: dir })).toEqual({
        owner: 'Negentropy-Laby',
        repo: 'OpenSlack',
        source: 'git_remote',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires live credentials when requested', async () => {
    await expect(
      getClient({
        repoFullName: 'Negentropy-Laby/OpenSlack',
        auth: 'auto',
        requireLive: true,
      }),
    ).rejects.toBeInstanceOf(GitHubAuthRequiredError);
  });

  it('fails closed in configured app-only mode instead of using a human token', async () => {
    process.env.OPENSLACK_GITHUB_AUTH_MODE = 'app';
    process.env.GH_TOKEN = 'human-token-must-not-be-used';
    await expect(getClient({ repoFullName: 'Negentropy-Laby/OpenSlack' })).rejects.toBeInstanceOf(
      GitHubAuthRequiredError,
    );
  });

  it('fails closed for explicit app auth even when requireLive is false', async () => {
    process.env.GH_TOKEN = 'human-token-must-not-be-used';
    await expect(
      getClient({
        repoFullName: 'Negentropy-Laby/OpenSlack',
        auth: 'app',
        requireLive: false,
      }),
    ).rejects.toBeInstanceOf(GitHubAuthRequiredError);
  });

  it('returns explicit dry-run client only when dry-run auth is requested', async () => {
    const client = await getClient({
      repoFullName: 'Negentropy-Laby/OpenSlack',
      auth: 'dry-run',
      requireLive: false,
    });

    expect(client.isDryRun).toBe(true);
    expect(client.authMode).toBe('dry_run');
    expect(client.owner).toBe('Negentropy-Laby');
    expect(client.repo).toBe('OpenSlack');
  });

  it('treats a forwarded short-lived installation token as GitHub App auth', async () => {
    process.env.OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN = 'installation-token-canary';

    const client = await getClient({
      repoFullName: 'Negentropy-Laby/OpenSlack',
      auth: 'app',
      requireLive: true,
    });

    expect(client.authMode).toBe('github_app_installation');
    expect(client.isDryRun).toBe(false);
  });
});

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GitHubAuthRequiredError,
  getClient,
  parseGitHubRepoSpec,
  resolveGitHubAppLocalStateRoot,
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
let noAppRoot: string;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  noAppRoot = mkdtempSync(join(tmpdir(), 'openslack-gh-no-app-'));
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
  rmSync(noAppRoot, { recursive: true, force: true });
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

  it('resolves App local state from the primary workspace for a linked worktree', () => {
    const container = mkdtempSync(join(tmpdir(), 'openslack-gh-worktree-'));
    const primary = join(container, 'primary');
    const linked = join(container, 'linked');
    try {
      mkdirSync(primary);
      execFileSync('git', ['init'], { cwd: primary, stdio: 'ignore' });
      writeFileSync(
        join(primary, 'openslack.yaml'),
        'schema: openslack.workspace.v1\ncanonical_remote:\n  provider: github\n  owner: acme\n  repo: project\n  default_branch: main\n',
      );
      execFileSync('git', ['add', 'openslack.yaml'], { cwd: primary, stdio: 'ignore' });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=OpenSlack Test',
          '-c',
          'user.email=test@openslack.local',
          'commit',
          '-m',
          'test: initialize workspace',
        ],
        { cwd: primary, stdio: 'ignore' },
      );
      const primaryLocalState = join(primary, '.openslack.local');
      mkdirSync(primaryLocalState);
      writeFileSync(
        join(primaryLocalState, 'github-app.json'),
        '{"schema":"openslack.github_app_local.v1","appId":"123","installationId":"456","appSlug":"local-app","privateKeyRef":"keychain:openslack/test-app"}\n',
      );
      execFileSync('git', ['worktree', 'add', '-b', 'agent/test-worktree', linked], {
        cwd: primary,
        stdio: 'ignore',
      });

      expect(resolveGitHubAppLocalStateRoot(linked)).toBe(primaryLocalState);
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  });

  it('does not trust an unregistered workspace that forges another repository gitdir', () => {
    const container = mkdtempSync(join(tmpdir(), 'openslack-gh-forged-gitdir-'));
    const primary = join(container, 'external-primary');
    const forged = join(container, 'forged-workspace');
    try {
      mkdirSync(primary);
      mkdirSync(forged);
      execFileSync('git', ['init'], { cwd: primary, stdio: 'ignore' });
      writeFileSync(
        join(primary, 'openslack.yaml'),
        'schema: openslack.workspace.v1\ncanonical_remote:\n  provider: github\n  owner: external\n  repo: project\n  default_branch: main\n',
      );
      execFileSync('git', ['add', 'openslack.yaml'], { cwd: primary, stdio: 'ignore' });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=OpenSlack Test',
          '-c',
          'user.email=test@openslack.local',
          'commit',
          '-m',
          'test: initialize external repository',
        ],
        { cwd: primary, stdio: 'ignore' },
      );
      const externalLocalState = join(primary, '.openslack.local');
      mkdirSync(externalLocalState);
      writeFileSync(
        join(externalLocalState, 'github-app.json'),
        '{"schema":"openslack.github_app_local.v1","appId":"999","installationId":"888","appSlug":"external-app","privateKeyRef":"keychain:external/app"}\n',
      );
      writeFileSync(
        join(forged, 'openslack.yaml'),
        'schema: openslack.workspace.v1\ncanonical_remote:\n  provider: github\n  owner: forged\n  repo: project\n  default_branch: main\n',
      );
      writeFileSync(join(forged, '.git'), `gitdir: ${join(primary, '.git')}\n`);

      expect(resolveGitHubAppLocalStateRoot(forged)).toBe(join(forged, '.openslack.local'));
      expect(resolveGitHubAppLocalStateRoot(forged)).not.toBe(externalLocalState);
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  });

  it('requires live credentials when requested', async () => {
    await expect(
      getClient({
        repoFullName: 'Negentropy-Laby/OpenSlack',
        auth: 'auto',
        requireLive: true,
        localStateRoot: join(noAppRoot, '.openslack.local'),
      }),
    ).rejects.toBeInstanceOf(GitHubAuthRequiredError);
  });

  it('fails closed in configured app-only mode instead of using a human token', async () => {
    process.env.OPENSLACK_GITHUB_AUTH_MODE = 'app';
    process.env.GH_TOKEN = 'human-token-must-not-be-used';
    await expect(
      getClient({
        repoFullName: 'Negentropy-Laby/OpenSlack',
        localStateRoot: join(noAppRoot, '.openslack.local'),
      }),
    ).rejects.toBeInstanceOf(GitHubAuthRequiredError);
  });

  it('fails closed for explicit app auth even when requireLive is false', async () => {
    process.env.GH_TOKEN = 'human-token-must-not-be-used';
    await expect(
      getClient({
        repoFullName: 'Negentropy-Laby/OpenSlack',
        auth: 'app',
        requireLive: false,
        localStateRoot: join(noAppRoot, '.openslack.local'),
      }),
    ).rejects.toBeInstanceOf(GitHubAuthRequiredError);
  });

  it('does not fall back to a human token when App environment config is partial', async () => {
    process.env.OPENSLACK_GITHUB_APP_ID = '123';
    process.env.GH_TOKEN = 'human-token-must-not-be-used';
    await expect(
      getClient({ repoFullName: 'Negentropy-Laby/OpenSlack', auth: 'auto' }),
    ).rejects.toBeInstanceOf(GitHubAuthRequiredError);
  });

  it('does not fall back to a human token when local App metadata is invalid', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-gh-invalid-app-'));
    try {
      mkdirSync(join(root, '.openslack.local'));
      writeFileSync(
        join(root, 'openslack.yaml'),
        'schema: openslack.workspace.v1\ncanonical_remote:\n  provider: github\n  owner: acme\n  repo: project\n  default_branch: main\n',
      );
      writeFileSync(join(root, '.openslack.local', 'github-app.json'), '{"schema":"bad"}\n');
      process.env.GITHUB_TOKEN = 'human-token-must-not-be-used';
      await expect(
        getClient({ cwd: root, repoFullName: 'acme/project', auth: 'auto' }),
      ).rejects.toBeInstanceOf(GitHubAuthRequiredError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains the human-token development fallback when no App config exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-gh-no-app-config-'));
    try {
      process.env.GITHUB_TOKEN = 'development-token';
      await expect(
        getClient({ cwd: root, repoFullName: 'Negentropy-Laby/OpenSlack', auth: 'auto' }),
      ).resolves.toMatchObject({ authMode: 'token', isDryRun: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

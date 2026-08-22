import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireToken = vi.hoisted(() => vi.fn());
const clearTokenCache = vi.hoisted(() => vi.fn());
const resolveLocalStateRoot = vi.hoisted(() => vi.fn());

vi.mock('@openslack/github', () => ({
  requireAppInstallationToken: requireToken,
  clearTokenCache,
  resolveGitHubAppLocalStateRoot: resolveLocalStateRoot,
  inspectInstallationRepositoryAccess: vi.fn(),
}));

import { GitHubDeliveryProbe } from '../probe.js';
import { GitHubDeliveryService } from '../service.js';

const sha = 'a'.repeat(40);
const rootDir = resolve('/ordinary/workspace');

beforeEach(() => {
  requireToken.mockReset();
  clearTokenCache.mockReset();
  resolveLocalStateRoot.mockReset();
  resolveLocalStateRoot.mockImplementation((root: string) => resolve(root, '.openslack.local'));
  requireToken.mockResolvedValue({
    token: 'installation-token',
    expiresAt: '2026-07-11T01:00:00.000Z',
    tokenType: 'installation',
    appId: '123',
    installationId: '456',
    permissions: {
      contents: 'write',
      pull_requests: 'write',
      workflows: 'write',
      issues: 'write',
    },
  });
});

describe('default installed-workspace credential path', () => {
  it('resolves delivery publication credentials from the workspace local state root', async () => {
    const service = new GitHubDeliveryService({
      gitPublisher: {
        push: vi.fn(() => ({ branchSha: sha, remoteSha: sha })),
        readRemoteSha: vi.fn(() => sha),
      },
      githubApiFactory: () => ({
        findOpenPullRequests: vi.fn(async () => []),
        createDraftPullRequest: vi.fn(async () => pullRequest()),
        updatePullRequest: vi.fn(async () => pullRequest()),
        getPullRequest: vi.fn(async () => pullRequest()),
        listChecks: vi.fn(async () => []),
      }),
      sleep: async () => {},
    });

    await service.publish({
      rootDir,
      owner: 'acme',
      repo: 'project',
      branch: 'agent/topic',
      base: 'main',
      title: 'runtime: publish topic',
      body: 'body',
    });

    expect(requireToken).toHaveBeenCalledWith({
      localStateRoot: resolve(rootDir, '.openslack.local'),
      repository: { owner: 'acme', repo: 'project' },
    });
    expect(resolveLocalStateRoot).toHaveBeenCalledWith(rootDir);
  });

  it('uses the same local credential source for read-only delivery diagnostics', async () => {
    const probe = new GitHubDeliveryProbe({
      gitPublisher: {
        push: vi.fn(() => ({ branchSha: sha, remoteSha: sha })),
        readRemoteSha: vi.fn(() => sha),
        deleteRemoteRef: vi.fn(),
      },
      repositoryInspector: async ({ owner, repo }) => ({
        owner,
        repo,
        accessible: true,
        complete: true,
        totalAccessibleRepositories: 1,
        pagesScanned: 1,
      }),
    });

    await probe.diagnose({ rootDir, owner: 'acme', repo: 'project' });

    expect(requireToken).toHaveBeenCalledWith({
      localStateRoot: resolve(rootDir, '.openslack.local'),
      repository: { owner: 'acme', repo: 'project' },
    });
    expect(resolveLocalStateRoot).toHaveBeenCalledWith(rootDir);
  });

  it('does not mistake an installation hint for a forwarded token and can refresh after 401', async () => {
    const previousInstallationId = process.env.OPENSLACK_GITHUB_APP_INSTALLATION_ID;
    const previousToken = process.env.OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN;
    const previousExpiry = process.env.OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN_EXPIRES_AT;
    const previousPermissions = process.env.OPENSLACK_GITHUB_APP_INSTALLATION_PERMISSIONS;
    process.env.OPENSLACK_GITHUB_APP_INSTALLATION_ID = '456';
    delete process.env.OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN;
    delete process.env.OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN_EXPIRES_AT;
    delete process.env.OPENSLACK_GITHUB_APP_INSTALLATION_PERMISSIONS;
    const first = {
      findOpenPullRequests: vi.fn(async () => {
        throw { status: 401 };
      }),
      createDraftPullRequest: vi.fn(async () => pullRequest()),
      updatePullRequest: vi.fn(async () => pullRequest()),
      getPullRequest: vi.fn(async () => pullRequest()),
      listChecks: vi.fn(async () => []),
    };
    const second = {
      findOpenPullRequests: vi.fn(async () => []),
      createDraftPullRequest: vi.fn(async () => pullRequest()),
      updatePullRequest: vi.fn(async () => pullRequest()),
      getPullRequest: vi.fn(async () => pullRequest()),
      listChecks: vi.fn(async () => []),
    };
    const service = new GitHubDeliveryService({
      gitPublisher: {
        push: vi.fn(() => ({ branchSha: sha, remoteSha: sha })),
        readRemoteSha: vi.fn(() => sha),
      },
      githubApiFactory: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
      sleep: async () => {},
    });

    try {
      await expect(
        service.publish({
          rootDir,
          owner: 'acme',
          repo: 'project',
          branch: 'agent/topic',
          base: 'main',
          title: 'runtime: publish topic',
          body: 'body',
        }),
      ).resolves.toMatchObject({ state: 'AWAITING_GATES' });
      expect(requireToken).toHaveBeenCalledTimes(2);
      expect(clearTokenCache).toHaveBeenCalledTimes(2);
    } finally {
      restoreEnvironment('OPENSLACK_GITHUB_APP_INSTALLATION_ID', previousInstallationId);
      restoreEnvironment('OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN', previousToken);
      restoreEnvironment('OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN_EXPIRES_AT', previousExpiry);
      restoreEnvironment('OPENSLACK_GITHUB_APP_INSTALLATION_PERMISSIONS', previousPermissions);
    }
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function pullRequest() {
  return {
    number: 42,
    url: 'https://github.com/acme/project/pull/42',
    headOwner: 'acme',
    headRepo: 'project',
    headRef: 'agent/topic',
    headSha: sha,
  };
}

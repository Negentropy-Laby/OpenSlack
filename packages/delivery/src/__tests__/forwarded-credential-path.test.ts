import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GitHubDeliveryService,
  type DeliveryGitHubApi,
  type GitBranchPublisher,
} from '../index.js';

const sha = 'a'.repeat(40);
const keys = [
  'OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN',
  'OPENSLACK_GITHUB_APP_INSTALLATION_ID',
  'OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN_EXPIRES_AT',
  'OPENSLACK_GITHUB_APP_INSTALLATION_PERMISSIONS',
] as const;
const original = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of keys) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  original.clear();
});

describe('forwarded delivery credentials', () => {
  it('uses only the short-lived installation token and non-secret permission evidence', async () => {
    setForwardedCredentials();
    const publisher = gitPublisher();
    const factory = vi.fn(() => githubApi());
    const service = new GitHubDeliveryService({
      gitPublisher: publisher,
      githubApiFactory: factory,
      sleep: async () => {},
    });

    const result = await service.publish({
      rootDir: '/repo',
      owner: 'acme',
      repo: 'project',
      branch: 'agent/topic',
      title: 'github: publish branch',
      body: 'body',
    });

    expect(result.state).toBe('AWAITING_GATES');
    expect(publisher.push).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'short-lived-installation-token' }),
    );
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        token: expect.objectContaining({
          value: 'short-lived-installation-token',
          installationId: '456',
          permissions: {
            contents: 'write',
            pull_requests: 'write',
            workflows: 'write',
          },
        }),
      }),
    );
  });

  it('fails closed before Git mutation when forwarded permission evidence is malformed', async () => {
    setForwardedCredentials();
    process.env.OPENSLACK_GITHUB_APP_INSTALLATION_PERMISSIONS = '{not-json';
    const publisher = gitPublisher();
    const service = new GitHubDeliveryService({
      gitPublisher: publisher,
      githubApiFactory: () => githubApi(),
    });

    await expect(
      service.publish({
        rootDir: '/repo',
        owner: 'acme',
        repo: 'project',
        branch: 'agent/topic',
        title: 'github: publish branch',
        body: 'body',
      }),
    ).rejects.toMatchObject({ code: 'DELIVERY_AUTH_REQUIRED' });
    expect(publisher.push).not.toHaveBeenCalled();
  });
});

function setForwardedCredentials(): void {
  for (const key of keys) original.set(key, process.env[key]);
  process.env.OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN = 'short-lived-installation-token';
  process.env.OPENSLACK_GITHUB_APP_INSTALLATION_ID = '456';
  process.env.OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN_EXPIRES_AT = '2030-01-01T00:00:00.000Z';
  process.env.OPENSLACK_GITHUB_APP_INSTALLATION_PERMISSIONS = JSON.stringify({
    contents: 'write',
    pull_requests: 'write',
    workflows: 'write',
  });
}

function gitPublisher(): GitBranchPublisher & {
  push: ReturnType<typeof vi.fn>;
  readRemoteSha: ReturnType<typeof vi.fn>;
} {
  return {
    push: vi.fn(() => ({ branchSha: sha, remoteSha: sha })),
    readRemoteSha: vi.fn(() => sha),
  };
}

function githubApi(): DeliveryGitHubApi {
  const pullRequest = {
    number: 42,
    url: 'https://github.com/acme/project/pull/42',
    headOwner: 'acme',
    headRepo: 'project',
    headRef: 'agent/topic',
    headSha: sha,
  };
  return {
    findOpenPullRequests: vi.fn(async () => []),
    createDraftPullRequest: vi.fn(async () => pullRequest),
    updatePullRequest: vi.fn(async () => pullRequest),
    getPullRequest: vi.fn(async () => pullRequest),
    listChecks: vi.fn(async () => []),
  };
}

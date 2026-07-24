import { describe, expect, it, vi } from 'vitest';
import {
  DeliveryError,
  GitHubDeliveryService,
  type DeliveryGitHubApi,
  type DeliveryPullRequest,
  type DeliveryTokenProvider,
  type GitBranchPublisher,
} from '../index.js';

const sha = 'a'.repeat(40);
const baseInput = {
  rootDir: '/repo',
  owner: 'acme',
  repo: 'project',
  branch: 'agent/topic',
  base: 'main',
  title: 'runtime: publish delivery',
  body: 'body',
};

describe('GitHubDeliveryService', () => {
  it('rejects a non-main base before token, push, or API side effects', async () => {
    const tokenProvider = tokens();
    const publisher = gitPublisher();
    const apiFactory = vi.fn(() => githubApi());
    const service = new GitHubDeliveryService({
      tokenProvider,
      gitPublisher: publisher,
      githubApiFactory: apiFactory,
    });

    await expect(
      service.publish({ ...baseInput, base: 'integration/notification-delivery-0.3' }),
    ).rejects.toMatchObject({
      code: 'DELIVERY_BASE_FORBIDDEN',
      retryable: false,
    });
    expect(tokenProvider.acquire).not.toHaveBeenCalled();
    expect(publisher.push).not.toHaveBeenCalled();
    expect(apiFactory).not.toHaveBeenCalled();
  });

  it('creates once, synchronizes all SHAs, and returns empty checks as awaiting gates', async () => {
    const api = githubApi();
    const service = createService({ api });
    const result = await service.publish(baseInput);
    expect(result).toMatchObject({
      state: 'AWAITING_GATES',
      action: 'created',
      branchSha: sha,
      prHeadSha: sha,
      checksStatus: 'empty',
      history: ['PREPARED', 'PUSHED', 'PR_CREATED', 'HEAD_SYNCHRONIZED', 'AWAITING_GATES'],
    });
    expect(api.createDraftPullRequest).toHaveBeenCalledTimes(1);
    expect(api.listChecks).toHaveBeenCalledWith(expect.objectContaining({ ref: sha }));
  });

  it('updates the one exact open PR instead of creating a duplicate', async () => {
    const existing = pullRequest(7);
    const api = githubApi({ find: [existing] });
    const result = await createService({ api }).publish(baseInput);
    expect(result.action).toBe('updated');
    expect(result.prNumber).toBe(7);
    expect(api.findOpenPullRequests).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'project',
      headOwner: 'acme',
      head: 'agent/topic',
    });
    expect(api.updatePullRequest).toHaveBeenCalledWith(expect.objectContaining({ number: 7 }));
    expect(api.createDraftPullRequest).not.toHaveBeenCalled();
  });

  it('recovers idempotently when PR creation races with another publisher', async () => {
    const raced = pullRequest(9);
    const api = githubApi();
    api.findOpenPullRequests.mockResolvedValueOnce([]).mockResolvedValueOnce([raced]);
    api.createDraftPullRequest.mockRejectedValueOnce({
      status: 422,
      response: { data: { errors: [{ code: 'already_exists' }] } },
    });
    api.updatePullRequest.mockResolvedValueOnce(raced);
    api.getPullRequest.mockResolvedValue(raced);
    const result = await createService({ api }).publish(baseInput);
    expect(result).toMatchObject({ action: 'updated', prNumber: 9 });
    expect(api.createDraftPullRequest).toHaveBeenCalledTimes(1);
    expect(api.updatePullRequest).toHaveBeenCalledWith(expect.objectContaining({ number: 9 }));
  });

  it('does not update a mismatched PR returned after a create race', async () => {
    const mismatched = { ...pullRequest(10), headRef: 'agent/other-topic' };
    const api = githubApi();
    api.findOpenPullRequests.mockResolvedValueOnce([]).mockResolvedValueOnce([mismatched]);
    api.createDraftPullRequest.mockRejectedValueOnce({
      status: 422,
      response: { data: { errors: [{ code: 'already_exists' }] } },
    });

    await expect(createService({ api }).publish(baseInput)).rejects.toMatchObject({
      code: 'DELIVERY_PR_CONFLICT',
    });
    expect(api.updatePullRequest).not.toHaveBeenCalled();
  });

  it('fails before mutation when permissions are missing or exact-head PRs are duplicated', async () => {
    const publisher = gitPublisher();
    const missing = createService({ publisher, permissions: { contents: 'write' } });
    await expect(missing.publish(baseInput)).rejects.toMatchObject({
      code: 'DELIVERY_PERMISSION_DENIED',
    });
    expect(publisher.push).not.toHaveBeenCalled();

    const duplicated = githubApi({ find: [pullRequest(1), pullRequest(2)] });
    await expect(createService({ api: duplicated }).publish(baseInput)).rejects.toMatchObject({
      code: 'DELIVERY_PR_CONFLICT',
      retryable: false,
    });
    expect(duplicated.createDraftPullRequest).not.toHaveBeenCalled();
  });

  it('invalidates and retries exactly once after an authentication push failure', async () => {
    const publisher = gitPublisher();
    publisher.push
      .mockImplementationOnce(() => {
        throw new DeliveryError(
          'DELIVERY_PUSH_FAILED',
          'Git branch publication failed: authentication failed',
          true,
        );
      })
      .mockReturnValueOnce({ branchSha: sha, remoteSha: sha });
    const tokenProvider = tokens();
    const result = await createService({ publisher, tokenProvider }).publish(baseInput);
    expect(result.state).toBe('AWAITING_GATES');
    expect(tokenProvider.invalidate).toHaveBeenCalledTimes(1);
    expect(tokenProvider.acquire).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(publisher.push).toHaveBeenCalledTimes(2);
  });

  it('fails closed when refreshed push credentials lose required permissions', async () => {
    const publisher = gitPublisher();
    publisher.push.mockImplementationOnce(() => {
      throw new DeliveryError(
        'DELIVERY_PUSH_FAILED',
        'Git branch publication failed: authentication failed',
        true,
      );
    });
    const tokenProvider = tokens();
    tokenProvider.acquire.mockResolvedValueOnce({
      value: 'initial-token',
      expiresAt: '2026-07-11T01:00:00.000Z',
      installationId: 'test-installation',
      permissions: { contents: 'write', pull_requests: 'write', workflows: 'write' },
    });
    tokenProvider.acquire.mockResolvedValueOnce({
      value: 'refreshed-token',
      expiresAt: '2026-07-11T02:00:00.000Z',
      installationId: 'test-installation',
      permissions: { contents: 'read', pull_requests: 'write', workflows: 'write' },
    });
    await expect(
      createService({ publisher, tokenProvider }).publish(baseInput),
    ).rejects.toMatchObject({ code: 'DELIVERY_PERMISSION_DENIED' });
    expect(publisher.push).toHaveBeenCalledTimes(1);
  });

  it('refreshes the installation token once after an API authentication failure', async () => {
    const first = githubApi();
    first.findOpenPullRequests.mockRejectedValueOnce({ status: 401 });
    const second = githubApi();
    const tokenProvider = tokens();
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const service = new GitHubDeliveryService({
      tokenProvider,
      gitPublisher: gitPublisher(),
      githubApiFactory: factory,
      sleep: async () => {},
    });
    const result = await service.publish(baseInput);
    expect(result.state).toBe('AWAITING_GATES');
    expect(tokenProvider.invalidate).toHaveBeenCalledTimes(1);
    expect(tokenProvider.acquire).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('shares one authentication refresh budget across push and API operations', async () => {
    const publisher = gitPublisher();
    publisher.push
      .mockImplementationOnce(() => {
        throw new DeliveryError(
          'DELIVERY_PUSH_FAILED',
          'Git branch publication failed: authentication failed',
          true,
        );
      })
      .mockReturnValueOnce({ branchSha: sha, remoteSha: sha });
    const api = githubApi();
    api.findOpenPullRequests.mockRejectedValueOnce({ status: 401 });
    const tokenProvider = tokens();

    await expect(
      createService({ publisher, api, tokenProvider }).publish(baseInput),
    ).rejects.toMatchObject({ code: 'DELIVERY_AUTH_REQUIRED' });
    expect(tokenProvider.invalidate).toHaveBeenCalledTimes(1);
    expect(tokenProvider.acquire).toHaveBeenCalledTimes(2);
  });

  it('does not query checks when the PR head never synchronizes', async () => {
    const api = githubApi({ headSha: 'b'.repeat(40) });
    await expect(
      createService({ api, headSyncAttempts: 2 }).publish(baseInput),
    ).rejects.toMatchObject({ code: 'DELIVERY_HEAD_STALE', retryable: true });
    expect(api.getPullRequest).toHaveBeenCalledTimes(2);
    expect(api.listChecks).not.toHaveBeenCalled();
  });

  it.each([
    { status: 404, retryable: false },
    { status: 422, retryable: false },
    { status: 429, retryable: true },
    { status: 503, retryable: true },
  ])(
    'classifies HTTP $status failures without exposing response data',
    async ({ status, retryable }) => {
      const api = githubApi();
      api.findOpenPullRequests.mockRejectedValueOnce({
        status,
        response: { data: { message: `github-api-secret-canary-${status}` } },
      });

      const failure = await createService({ api })
        .publish(baseInput)
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: 'DELIVERY_PR_FAILED', retryable });
      expect((failure as Error & { cause?: Error }).cause?.message).toBe(
        `GitHub API failure (HTTP ${status}).`,
      );
      expect(JSON.stringify(failure)).not.toContain('github-api-secret-canary');
    },
  );

  it('marks allowlisted transport failures retryable and unknown failures terminal', async () => {
    const retryableApi = githubApi();
    retryableApi.findOpenPullRequests.mockRejectedValueOnce({
      code: 'ETIMEDOUT',
      message: 'transport-secret-canary',
    });
    const retryable = await createService({ api: retryableApi })
      .publish(baseInput)
      .catch((error: unknown) => error);
    expect(retryable).toMatchObject({ code: 'DELIVERY_PR_FAILED', retryable: true });
    expect((retryable as Error & { cause?: Error }).cause?.message).toBe(
      'GitHub API transport failure (ETIMEDOUT).',
    );

    const terminalApi = githubApi();
    terminalApi.findOpenPullRequests.mockRejectedValueOnce(new Error('unknown-secret-canary'));
    const terminal = await createService({ api: terminalApi })
      .publish(baseInput)
      .catch((error: unknown) => error);
    expect(terminal).toMatchObject({ code: 'DELIVERY_PR_FAILED', retryable: false });
    expect(JSON.stringify(terminal)).not.toContain('unknown-secret-canary');
  });

  it('fails before querying checks when the remote ref drifts after PR synchronization', async () => {
    const api = githubApi();
    const publisher = gitPublisher();
    publisher.readRemoteSha.mockReturnValueOnce('b'.repeat(40));
    await expect(createService({ api, publisher }).publish(baseInput)).rejects.toMatchObject({
      code: 'DELIVERY_HEAD_STALE',
      retryable: true,
    });
    expect(publisher.readRemoteSha).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'project',
        branch: 'agent/topic',
        token: 'transport-only-token',
      }),
    );
    expect(api.listChecks).not.toHaveBeenCalled();
  });
});

function createService(
  options: {
    api?: ReturnType<typeof githubApi>;
    publisher?: ReturnType<typeof gitPublisher>;
    tokenProvider?: ReturnType<typeof tokens>;
    permissions?: Record<string, string>;
    headSyncAttempts?: number;
  } = {},
) {
  const tokenProvider = options.tokenProvider ?? tokens(options.permissions);
  const api = options.api ?? githubApi();
  return new GitHubDeliveryService({
    tokenProvider,
    gitPublisher: options.publisher ?? gitPublisher(),
    githubApiFactory: () => api,
    sleep: async () => {},
    headSyncAttempts: options.headSyncAttempts,
    now: () => new Date('2026-07-11T00:00:00.000Z'),
  });
}

function tokens(
  permissions: Readonly<Record<string, string>> = {
    contents: 'write',
    pull_requests: 'write',
    workflows: 'write',
  },
) {
  return {
    acquire: vi.fn(async () => ({
      value: 'transport-only-token',
      expiresAt: '2026-07-11T01:00:00.000Z',
      installationId: 'test-installation',
      permissions,
    })),
    invalidate: vi.fn(),
  } satisfies DeliveryTokenProvider;
}

function gitPublisher() {
  return {
    push: vi.fn(() => ({ branchSha: sha, remoteSha: sha })),
    readRemoteSha: vi.fn(() => sha),
  } satisfies GitBranchPublisher;
}

function pullRequest(number: number, headSha = sha): DeliveryPullRequest {
  return {
    number,
    url: `https://github.com/acme/project/pull/${number}`,
    headOwner: 'acme',
    headRepo: 'project',
    headRef: 'agent/topic',
    headSha,
  };
}

function githubApi(options: { find?: DeliveryPullRequest[]; headSha?: string } = {}) {
  const current = pullRequest(options.find?.[0]?.number ?? 42, options.headSha ?? sha);
  return {
    findOpenPullRequests: vi.fn(async () => options.find ?? []),
    createDraftPullRequest: vi.fn(async () => current),
    updatePullRequest: vi.fn(async () => current),
    getPullRequest: vi.fn(async () => current),
    listChecks: vi.fn(async () => []),
  } satisfies DeliveryGitHubApi;
}

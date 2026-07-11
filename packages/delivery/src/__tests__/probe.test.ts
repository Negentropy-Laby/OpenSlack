import { describe, expect, it, vi } from 'vitest';
import { GitHubDeliveryProbe } from '../probe.js';
import type { DeliveryTokenProvider, GitProbePublisher } from '../types.js';

const TOKEN = 'installation-token-canary';

describe('GitHub delivery write probe', () => {
  it('reports selected-repository scope and permissions without writing a ref', async () => {
    const publisher = fakePublisher();
    const probe = createProbe(publisher);
    await expect(probe.diagnose(input())).resolves.toMatchObject({
      state: 'READY_FOR_PROBE',
      repositoryAccess: { accessible: true },
    });
    expect(publisher.push).not.toHaveBeenCalled();
    expect(publisher.deleteRemoteRef).not.toHaveBeenCalled();
  });

  it('confirms installation scope, pushes a temporary ref, and deletes it', async () => {
    const publisher = fakePublisher();
    const probe = createProbe(publisher);
    const result = await probe.run(input());
    expect(result).toMatchObject({
      state: 'PROBE_CLEANED',
      cleanup: 'PASS',
      repositoryAccess: { accessible: true },
    });
    expect(publisher.push).toHaveBeenCalledTimes(1);
    expect(publisher.deleteRemoteRef).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'openslack/probes/write-12345678-abcd' }),
    );
  });

  it('does not push when the selected repository is not in installation scope', async () => {
    const publisher = fakePublisher();
    const probe = new GitHubDeliveryProbe({
      tokenProvider: tokenProvider(),
      gitPublisher: publisher,
      repositoryInspector: async ({ owner, repo }) => ({
        owner,
        repo,
        accessible: false,
        complete: true,
        totalAccessibleRepositories: 1,
        pagesScanned: 1,
      }),
    });
    await expect(probe.run(input())).rejects.toMatchObject({
      code: 'DELIVERY_REPOSITORY_NOT_INSTALLED',
    });
    expect(publisher.push).not.toHaveBeenCalled();
  });

  it('returns an exact restricted cleanup command when deletion fails', async () => {
    const publisher = fakePublisher();
    publisher.deleteRemoteRef.mockImplementation(() => {
      throw new Error(`delete failed with ${TOKEN}`);
    });
    const probe = createProbe(publisher);
    const failure = probe.run(input());
    await expect(failure).rejects.toMatchObject({
      code: 'DELIVERY_PROBE_CLEANUP_FAILED',
      remediation:
        'openslack delivery cleanup-ref --branch openslack/probes/write-12345678-abcd --repo acme/repo --apply',
    });
    await failure.catch((error: unknown) =>
      expect(error instanceof Error ? error.message : String(error)).not.toContain(TOKEN),
    );
  });

  it('cleans a ref discovered after push verification throws', async () => {
    const publisher = fakePublisher();
    publisher.push.mockImplementation(() => {
      throw new Error('post-push verification failed');
    });
    const probe = createProbe(publisher);
    await expect(probe.run(input())).rejects.toThrow('post-push verification failed');
    expect(publisher.readRemoteSha).toHaveBeenCalled();
    expect(publisher.deleteRemoteRef).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'openslack/probes/write-12345678-abcd' }),
    );
  });

  it('restricts manual cleanup to probe refs', async () => {
    const publisher = fakePublisher();
    const probe = createProbe(publisher);
    await expect(probe.cleanupRef({ ...input(), branch: 'main' })).rejects.toThrow(
      /restricted to OpenSlack temporary probe refs/,
    );
    expect(publisher.deleteRemoteRef).not.toHaveBeenCalled();
  });
});

function createProbe(publisher: ReturnType<typeof fakePublisher>) {
  return new GitHubDeliveryProbe({
    tokenProvider: tokenProvider(),
    gitPublisher: publisher,
    uuid: () => '12345678-abcd',
    now: () => new Date('2026-07-11T00:00:00.000Z'),
    repositoryInspector: async ({ owner, repo }) => ({
      owner,
      repo,
      accessible: true,
      complete: true,
      totalAccessibleRepositories: 3,
      pagesScanned: 1,
    }),
  });
}

function tokenProvider(): DeliveryTokenProvider {
  return {
    acquire: vi.fn(async () => ({
      value: TOKEN,
      expiresAt: '2026-07-11T01:00:00.000Z',
      installationId: '456',
      permissions: { contents: 'write', pull_requests: 'write', issues: 'write' },
    })),
    invalidate: vi.fn(),
  };
}

function fakePublisher() {
  return {
    push: vi.fn(() => ({ branchSha: 'a'.repeat(40), remoteSha: 'a'.repeat(40) })),
    readRemoteSha: vi.fn(() => 'a'.repeat(40)),
    deleteRemoteRef: vi.fn(),
  } satisfies GitProbePublisher;
}

function input() {
  return { rootDir: '/workspace', owner: 'acme', repo: 'repo' };
}

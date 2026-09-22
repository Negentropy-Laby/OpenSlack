import { describe, expect, it, vi } from 'vitest';
import { createInstallationClient, getClient } from '../client.js';
import {
  createCleanupBrokerClient,
  withCleanupBrokerClient,
} from '../internal/cleanup-broker-client-scope.js';

const options = {
  owner: 'owner',
  repo: 'repo',
  auth: 'app' as const,
  requireLive: true,
  strictEvidence: true,
};
const client = () =>
  createInstallationClient('fixture-not-a-credential', { owner: 'owner', repo: 'repo' });

describe('private cleanup broker GitHub client scope', () => {
  it('pins actual Octokit requests to private fetch, never global fetch', async () => {
    const fallback = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    const fixed = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 123 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    try {
      const owned = createCleanupBrokerClient('synthetic-token', 'owner', 'repo', fixed);
      await withCleanupBrokerClient(owned, async () => {
        const actual = await getClient(options);
        expect((await actual.octokit.repos.get({ owner: 'owner', repo: 'repo' })).data.id).toBe(
          123,
        );
      });
      expect(fixed).toHaveBeenCalledOnce();
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      fallback.mockRestore();
    }
  });
  it('reuses the owned live client without changing environment', async () => {
    const before = { ...process.env };
    const owned = client();
    await withCleanupBrokerClient(owned, async () => {
      expect((await getClient(options)).octokit).toBe(owned.octokit);
    });
    expect(process.env).toEqual(before);
  });
  it.each([
    { repo: 'other' },
    { auth: 'token' },
    { auth: 'auto' },
    { requireLive: false },
    { strictEvidence: false },
    { localStateRoot: '/tmp/not-used' },
  ])('does not fall back for incompatible options %j', async (change) => {
    await withCleanupBrokerClient(client(), async () => {
      await expect(
        getClient({ ...options, ...change } as Parameters<typeof getClient>[0]),
      ).rejects.toThrow('CLEANUP_BROKER_CLIENT_SCOPE_INVALID');
    });
  });
  it('rejects nested scopes and expired credentials', async () => {
    await withCleanupBrokerClient(client(), async () => {
      expect(() => withCleanupBrokerClient(client(), async () => {})).toThrow(
        'CLEANUP_BROKER_CLIENT_SCOPE_INVALID',
      );
    });
    const expired = client();
    expired.tokenExpiresAt = '2000-01-01T00:00:00Z';
    await withCleanupBrokerClient(expired, async () => {
      await expect(getClient(options)).rejects.toThrow('CLEANUP_BROKER_CLIENT_SCOPE_INVALID');
    });
  });
  it('revokes scope access in async descendants after operation completes', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let descendant!: Promise<void>;
    await withCleanupBrokerClient(client(), async () => {
      descendant = (async () => {
        await barrier;
        await expect(getClient(options)).rejects.toThrow('CLEANUP_BROKER_CLIENT_SCOPE_INVALID');
      })();
    });
    release();
    await descendant;
  });
});

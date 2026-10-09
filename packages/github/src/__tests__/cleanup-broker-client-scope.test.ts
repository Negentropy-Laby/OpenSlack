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
  createCleanupBrokerClient('fixture-not-a-credential', 'owner', 'repo', async () => {
    throw new Error('NETWORK_FORBIDDEN');
  });

describe('private cleanup broker GitHub client scope', () => {
  it.each(['root', 'rest'] as const)(
    'rejects deriving from a tampered %s parent hook',
    async (kind) => {
      const fixed = vi.fn(async () => new Response('{}'));
      const alternate = vi.fn(async (_request: string) => ({
        status: 200,
        data: {},
        headers: {},
        url: '',
      }));
      const owned = createCleanupBrokerClient('synthetic-token', 'owner', 'repo', fixed);
      await expect(
        withCleanupBrokerClient(owned, async () => {
          const parent = kind === 'root' ? owned.octokit.request : owned.octokit.repos.get;
          const defaults = parent.endpoint.DEFAULTS.request as Record<string, unknown>;
          defaults.hook = async () => alternate('POST https://other.invalid/write');
          const derived = parent.defaults({ headers: { accept: 'application/vnd.github+json' } });
          return Reflect.apply(
            derived,
            undefined,
            kind === 'root'
              ? ['GET /repos/{owner}/{repo}', { owner: 'owner', repo: 'repo' }]
              : [{ owner: 'owner', repo: 'repo' }],
          );
        }),
      ).rejects.toThrow('CLEANUP_BROKER_CLIENT_SCOPE_INVALID');
      expect(fixed).not.toHaveBeenCalled();
      expect(alternate).not.toHaveBeenCalled();
    },
  );

  it.each(['wrap', 'before'] as const)(
    'rejects public hook %s mutation before a callback can replace the read',
    async (kind) => {
      const fixed = vi.fn(async () => new Response('{}'));
      const alternate = vi.fn(async (_request: string) => ({
        status: 200,
        data: {},
        headers: {},
        url: '',
      }));
      const owned = createCleanupBrokerClient('synthetic-token', 'owner', 'repo', fixed);
      await expect(
        withCleanupBrokerClient(owned, async () => {
          const callback = async () => alternate('POST https://other.invalid/write');
          Reflect.apply(owned.octokit.hook[kind], owned.octokit.hook, ['request', callback]);
          return owned.octokit.repos.get({ owner: 'owner', repo: 'repo' });
        }),
      ).rejects.toThrow('CLEANUP_BROKER_CLIENT_SCOPE_INVALID');
      expect(fixed).not.toHaveBeenCalled();
      expect(alternate).not.toHaveBeenCalled();
    },
  );

  it.each(['root', 'derived', 'rest'] as const)(
    'rejects mutated endpoint defaults on %s requests before either transport',
    async (kind) => {
      const response = () =>
        new Response('{}', { headers: { 'content-type': 'application/json' } });
      const fixed = vi.fn(async () => response());
      const alternate = vi.fn(async () => response());
      const owned = createCleanupBrokerClient('synthetic-token', 'owner', 'repo', fixed);
      await withCleanupBrokerClient(owned, async () => {
        const request =
          kind === 'rest'
            ? owned.octokit.repos.get
            : kind === 'derived'
              ? owned.octokit.request.defaults({
                  headers: { accept: 'application/vnd.github+json' },
                })
              : owned.octokit.request;
        const defaults = request.endpoint.DEFAULTS.request as Record<string, unknown>;
        defaults.fetch = alternate;
        defaults.hook = undefined;
        const args =
          kind === 'rest'
            ? [{ owner: 'other', repo: 'repo' }]
            : ['POST https://other.invalid/write'];
        await expect(Reflect.apply(request, undefined, args)).rejects.toThrow(
          'CLEANUP_BROKER_CLIENT_SCOPE_INVALID',
        );
      });
      expect(fixed).not.toHaveBeenCalled();
      expect(alternate).not.toHaveBeenCalled();
    },
  );

  it('revokes captured Octokit and request defaults after scope, before fetch', async () => {
    const fixed = vi.fn(
      async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    );
    const owned = createCleanupBrokerClient('synthetic-token', 'owner', 'repo', fixed);
    let captured!: typeof owned.octokit.request;
    await withCleanupBrokerClient(owned, async () => {
      captured = owned.octokit.request.defaults({
        headers: { accept: 'application/vnd.github+json' },
      });
      await owned.octokit.repos.get({ owner: 'owner', repo: 'repo' });
    });
    await expect(owned.octokit.repos.get({ owner: 'owner', repo: 'repo' })).rejects.toThrow(
      'CLEANUP_BROKER_CLIENT_SCOPE_INVALID',
    );
    await expect(
      captured('GET /repos/{owner}/{repo}', { owner: 'owner', repo: 'repo' }),
    ).rejects.toThrow('CLEANUP_BROKER_CLIENT_SCOPE_INVALID');
    expect(fixed).toHaveBeenCalledOnce();
  });

  it('rejects parallel installation client construction without using global fetch', async () => {
    const fallback = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    const fixed = vi.fn(async () => new Response('{}'));
    try {
      await withCleanupBrokerClient(
        createCleanupBrokerClient('synthetic-token', 'owner', 'repo', fixed),
        async () => {
          expect(() =>
            createInstallationClient('synthetic-token', { owner: 'other', repo: 'repo' }),
          ).toThrow('CLEANUP_BROKER_CLIENT_SCOPE_INVALID');
        },
      );
      expect(fixed).not.toHaveBeenCalled();
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      fallback.mockRestore();
    }
  });

  it.each(['wrong-repository', 'write', 'fetch-override', 'expired-during-scope'])(
    'rejects captured client %s at actual send',
    async (kind) => {
      const fixed = vi.fn(async () => new Response('{}'));
      const override = vi.fn(async () => new Response('{}'));
      const owned = createCleanupBrokerClient('synthetic-token', 'owner', 'repo', fixed);
      await withCleanupBrokerClient(owned, async () => {
        if (kind === 'expired-during-scope') owned.tokenExpiresAt = '2000-01-01T00:00:00Z';
        const call =
          kind === 'write'
            ? owned.octokit.request('DELETE /repos/{owner}/{repo}/git/refs/{ref}', {
                owner: 'owner',
                repo: 'repo',
                ref: 'heads/topic',
              })
            : owned.octokit.repos.get({
                owner: kind === 'wrong-repository' ? 'other' : 'owner',
                repo: 'repo',
                ...(kind === 'fetch-override' ? { request: { fetch: override } } : {}),
              });
        await expect(call).rejects.toThrow('CLEANUP_BROKER_CLIENT_SCOPE_INVALID');
      });
      expect(fixed).not.toHaveBeenCalled();
      expect(override).not.toHaveBeenCalled();
    },
  );

  it('rechecks token expiry at send without a new client lookup', async () => {
    const fixed = vi.fn(async () => new Response('{}'));
    const client = createCleanupBrokerClient('synthetic-token', 'owner', 'repo', fixed);
    const clock = Date.now();
    client.tokenExpiresAt = new Date(clock + 1000).toISOString();
    await withCleanupBrokerClient(client, async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(clock + 1001);
      try {
        await expect(client.octokit.repos.get({ owner: 'owner', repo: 'repo' })).rejects.toThrow(
          'CLEANUP_BROKER_CLIENT_SCOPE_INVALID',
        );
      } finally {
        now.mockRestore();
      }
    });
    expect(fixed).not.toHaveBeenCalled();
  });
  it('denies a derived request transport/hook override and a wrong API origin', async () => {
    const fixed = vi.fn(async () => new Response('{}'));
    const client = createCleanupBrokerClient('synthetic-token', 'owner', 'repo', fixed);
    await withCleanupBrokerClient(client, async () => {
      expect(() =>
        client.octokit.request.defaults({ request: { fetch: fixed, hook: undefined } }),
      ).toThrow('CLEANUP_BROKER_CLIENT_SCOPE_INVALID');
      await expect(
        client.octokit.request('GET https://wrong.invalid/repos/owner/repo'),
      ).rejects.toThrow('CLEANUP_BROKER_CLIENT_SCOPE_INVALID');
    });
    expect(fixed).not.toHaveBeenCalled();
  });
  it('combines caller cancellation with scope revocation and rejects late uncancellable data', async () => {
    const abort = new AbortController();
    const fixed = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(init?.signal).toBeDefined();
      abort.abort(new Error('REQUEST_CANCELLED'));
      expect(init?.signal?.aborted).toBe(true);
      return new Response('{}');
    });
    const client = createCleanupBrokerClient('synthetic-token', 'owner', 'repo', fixed);
    await withCleanupBrokerClient(client, async () => {
      await expect(
        client.octokit.repos.get({
          owner: 'owner',
          repo: 'repo',
          request: { signal: abort.signal },
        }),
      ).rejects.toThrow('REQUEST_CANCELLED');
    });
    expect(fixed).toHaveBeenCalledOnce();
  });
  it('denies GraphQL and token extraction during scope and after capture', async () => {
    const fixed = vi.fn(async () => new Response('{}'));
    const alternate = vi.fn(
      async () =>
        new Response('{"data":{"fixture":true}}', {
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = createCleanupBrokerClient('synthetic-token', 'owner', 'repo', fixed);
    const graphql = client.octokit.graphql;
    const auth = client.octokit.auth;
    await withCleanupBrokerClient(client, async () => {
      await expect(
        graphql('query { fixture }', { request: { fetch: alternate, hook: undefined } }),
      ).rejects.toThrow('CLEANUP_BROKER_CLIENT_SCOPE_INVALID');
      expect(() => graphql.defaults({ request: { fetch: alternate, hook: undefined } })).toThrow(
        'CLEANUP_BROKER_CLIENT_SCOPE_INVALID',
      );
      await expect(auth()).rejects.toThrow('CLEANUP_BROKER_CLIENT_SCOPE_INVALID');
    });
    await expect(
      graphql('query { fixture }', { request: { fetch: alternate, hook: undefined } }),
    ).rejects.toThrow('CLEANUP_BROKER_CLIENT_SCOPE_INVALID');
    await expect(auth()).rejects.toThrow('CLEANUP_BROKER_CLIENT_SCOPE_INVALID');
    expect(fixed).not.toHaveBeenCalled();
    expect(alternate).not.toHaveBeenCalled();
  });

  it.each(['scope', 'expiry', 'caller-signal', 'derived-signal', 'execution-signal'] as const)(
    'rejects late response-body data after %s',
    async (kind) => {
      let reading!: () => void;
      const bodyReading = new Promise<void>((resolve) => {
        reading = resolve;
      });
      let finish!: () => void;
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"id":'));
            finish = () => {
              controller.enqueue(new TextEncoder().encode('123}'));
              controller.close();
            };
          },
          pull() {
            reading();
          },
        },
        { highWaterMark: 0 },
      );
      // Deliberately ignores fetch cancellation to prove the completion guard.
      let actualSignal: AbortSignal | undefined;
      const fixed = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        actualSignal = init?.signal ?? undefined;
        return new Response(stream, { headers: { 'content-type': 'application/json' } });
      });
      const execution = new AbortController();
      const client = createCleanupBrokerClient(
        'synthetic-token',
        'owner',
        'repo',
        fixed,
        execution.signal,
      );
      const before = Date.now();
      client.tokenExpiresAt = new Date(before + 1000).toISOString();
      const caller = new AbortController();
      let pending!: Promise<unknown>;
      let clock: ReturnType<typeof vi.spyOn> | undefined;
      try {
        await withCleanupBrokerClient(client, async () => {
          if (kind === 'derived-signal') {
            const derived = client.octokit.request.defaults({ request: { signal: caller.signal } });
            pending = derived('GET /repos/{owner}/{repo}', { owner: 'owner', repo: 'repo' });
          } else {
            pending = client.octokit.repos.get({
              owner: 'owner',
              repo: 'repo',
              request: { signal: caller.signal },
            });
          }
          await bodyReading;
          if (kind === 'scope') return;
          if (kind === 'expiry') clock = vi.spyOn(Date, 'now').mockReturnValue(before + 1001);
          else
            (kind === 'execution-signal' ? execution : caller).abort(
              new Error('CALLER_BODY_CANCELLED'),
            );
          finish();
          await expect(pending).rejects.toThrow(
            kind === 'expiry' ? 'CLEANUP_BROKER_CLIENT_SCOPE_INVALID' : 'CALLER_BODY_CANCELLED',
          );
        });
        if (kind === 'scope') {
          expect(actualSignal?.aborted).toBe(true);
          finish();
          await expect(pending).rejects.toThrow('CLEANUP_BROKER_CLIENT_SCOPE_INVALID');
        }
        expect(fixed).toHaveBeenCalledOnce();
      } finally {
        clock?.mockRestore();
      }
    },
  );

  it('aborts already-started reads when scope closes', async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fixed = vi.fn(
      (_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          started();
          init?.signal?.addEventListener('abort', () => reject(new Error('SCOPE_REVOKED')), {
            once: true,
          });
        }),
    );
    const owned = createCleanupBrokerClient('synthetic-token', 'owner', 'repo', fixed);
    let outcome!: Promise<string>;
    await withCleanupBrokerClient(owned, async () => {
      outcome = owned.octokit.repos.get({ owner: 'owner', repo: 'repo' }).then(
        () => 'unexpected',
        (error) => error.message,
      );
      await ready;
    });
    await expect(outcome).resolves.toContain('SCOPE_REVOKED');
  });
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

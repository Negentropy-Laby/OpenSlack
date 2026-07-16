import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient, GitHubClientOptions } from '../client.js';
import { RepositoryAuthorityResolver } from '../repository-authority.js';
import { canonicalizeRepositoryName } from '../repository-event.js';

function repository(owner = 'EventOrg', repo = 'EventRepo') {
  const value = canonicalizeRepositoryName(owner, repo);
  if (!value) throw new Error('Expected valid repository');
  return value;
}

function client(
  input: {
    owner?: string;
    repo?: string;
    authMode?: GitHubClient['authMode'];
    reposGet?: ReturnType<typeof vi.fn>;
  } = {},
): GitHubClient {
  return {
    owner: input.owner ?? 'EventOrg',
    repo: input.repo ?? 'EventRepo',
    authMode: input.authMode ?? 'github_app_installation',
    isDryRun: input.authMode === 'dry_run',
    octokit: {
      repos: {
        get: input.reposGet ?? vi.fn().mockResolvedValue({ data: { id: 1 } }),
      },
    } as unknown as GitHubClient['octokit'],
  };
}

describe('RepositoryAuthorityResolver', () => {
  it('always passes the event repository explicitly and never asks for workspace fallback', async () => {
    const getClientFn = vi.fn(async (_options: GitHubClientOptions) => client());
    const resolver = new RepositoryAuthorityResolver({ getClientFn });

    const result = await resolver.resolve(repository());

    expect(result.ok).toBe(true);
    expect(getClientFn).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: 'EventOrg/EventRepo',
        requireLive: true,
      }),
    );
    expect(getClientFn.mock.calls[0]![0]).not.toHaveProperty('owner');
    expect(getClientFn.mock.calls[0]![0]).not.toHaveProperty('repo');
  });

  it('proves target repository access with the same bound client', async () => {
    const reposGet = vi.fn().mockResolvedValue({ data: { id: 1 } });
    const resolver = new RepositoryAuthorityResolver({
      getClientFn: async () => client({ reposGet }),
    });

    await expect(resolver.resolve(repository())).resolves.toMatchObject({
      ok: true,
      authMode: 'github_app_installation',
    });
    expect(reposGet).toHaveBeenCalledWith({
      owner: 'EventOrg',
      repo: 'EventRepo',
    });
  });

  it.each([403, 404])(
    'fails safely when the credential cannot access the event repository (%s)',
    async (status) => {
      const reposGet = vi.fn().mockRejectedValue({ status, token: 'must-not-leak' });
      const resolver = new RepositoryAuthorityResolver({
        getClientFn: async () => client({ reposGet }),
      });

      const result = await resolver.resolve(repository());

      expect(result).toMatchObject({
        ok: false,
        diagnostic: {
          code: 'REPOSITORY_OUT_OF_SCOPE',
          repository: 'EventOrg/EventRepo',
          retryable: false,
        },
      });
      expect(JSON.stringify(result)).not.toContain('must-not-leak');
    },
  );

  it('marks transient scope verification failures retryable without exposing raw errors', async () => {
    const reposGet = vi.fn().mockRejectedValue(new Error('socket failed with bearer secret-token'));
    const resolver = new RepositoryAuthorityResolver({
      getClientFn: async () => client({ reposGet }),
    });

    const result = await resolver.resolve(repository());

    expect(result).toMatchObject({
      ok: false,
      diagnostic: {
        code: 'SCOPE_UNVERIFIED',
        retryable: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('rejects a client bound to another repository before any API query', async () => {
    const reposGet = vi.fn();
    const resolver = new RepositoryAuthorityResolver({
      getClientFn: async () => client({ owner: 'WorkspaceOrg', repo: 'WorkspaceRepo', reposGet }),
    });

    await expect(resolver.resolve(repository())).resolves.toMatchObject({
      ok: false,
      diagnostic: {
        code: 'REPOSITORY_IDENTITY_MISMATCH',
        retryable: false,
      },
    });
    expect(reposGet).not.toHaveBeenCalled();
  });

  it('locks one daemon credential mode and refuses runtime identity drift', async () => {
    const options: GitHubClientOptions[] = [];
    const getClientFn = vi.fn(async (input: GitHubClientOptions) => {
      options.push(input);
      if (options.length === 1) {
        return client({ owner: 'EventOrg', repo: 'EventRepo' });
      }
      return client({
        owner: 'OtherOrg',
        repo: 'OtherRepo',
        authMode: 'token',
      });
    });
    const resolver = new RepositoryAuthorityResolver({
      auth: 'auto',
      cacheTtlMs: 0,
      getClientFn,
    });

    expect((await resolver.resolve(repository())).ok).toBe(true);
    await expect(resolver.resolve(repository('OtherOrg', 'OtherRepo'))).resolves.toMatchObject({
      ok: false,
      diagnostic: { code: 'AUTH_CONTEXT_CHANGED', retryable: false },
    });
    expect(options[1]?.auth).toBe('app');
  });

  it('does not lock a credential mode until repository access is proven', async () => {
    const options: GitHubClientOptions[] = [];
    const getClientFn = vi.fn(async (input: GitHubClientOptions) => {
      options.push(input);
      if (options.length === 1) {
        return client({
          owner: 'DeniedOrg',
          repo: 'DeniedRepo',
          authMode: 'token',
          reposGet: vi.fn().mockRejectedValue({ status: 404 }),
        });
      }
      return client({
        owner: 'EventOrg',
        repo: 'EventRepo',
        authMode: 'github_app_installation',
      });
    });
    const resolver = new RepositoryAuthorityResolver({
      auth: 'auto',
      cacheTtlMs: 0,
      getClientFn,
    });

    await expect(resolver.resolve(repository('DeniedOrg', 'DeniedRepo'))).resolves.toMatchObject({
      ok: false,
      diagnostic: { code: 'REPOSITORY_OUT_OF_SCOPE' },
    });
    await expect(resolver.resolve(repository())).resolves.toMatchObject({
      ok: true,
      authMode: 'github_app_installation',
    });
    expect(options[1]?.auth).toBe('auto');
  });

  it('caches only by canonical event repository identity', async () => {
    const getClientFn = vi.fn(async () => client());
    const resolver = new RepositoryAuthorityResolver({
      getClientFn,
      cacheTtlMs: 60_000,
    });

    expect((await resolver.resolve(repository())).ok).toBe(true);
    expect((await resolver.resolve(repository('eventorg', 'eventrepo'))).ok).toBe(true);
    expect(getClientFn).toHaveBeenCalledTimes(1);
  });
});

import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitHubClient, RepositoryIdentity } from '@openslack/github';
import {
  buildRepositoryPRProjection,
  renderRepositoryPRProjection,
} from '../repository-projection.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openslack-pr-projection-'));
  temporaryRoots.push(root);
  return root;
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: 'Projection title',
    state: 'open',
    draft: false,
    updated_at: '2026-07-17T01:00:00.000Z',
    user: { login: 'alice' },
    head: { sha: 'head-1' },
    body: 'untrusted PR body must never be cached',
    ...overrides,
  };
}

function mockClient(input: {
  repository: RepositoryIdentity;
  pulls?: unknown[];
  list?: ReturnType<typeof vi.fn>;
  get?: ReturnType<typeof vi.fn>;
  checks?: ReturnType<typeof vi.fn>;
}): GitHubClient {
  return {
    owner: input.repository.owner,
    repo: input.repository.repo,
    authMode: 'github_app_installation',
    isDryRun: false,
    octokit: {
      pulls: {
        list: input.list ?? vi.fn().mockResolvedValue({ data: input.pulls ?? [pullRequest()] }),
        get:
          input.get ??
          vi.fn().mockResolvedValue({
            data: { state: 'closed', head: { sha: 'head-1' } },
          }),
      },
      checks: {
        listForRef:
          input.checks ??
          vi.fn().mockResolvedValue({
            data: {
              check_runs: [
                { status: 'completed', conclusion: 'success', name: 'test' },
                { status: 'in_progress', conclusion: null, name: 'lint' },
              ],
            },
          }),
      },
    } as unknown as GitHubClient['octokit'],
  };
}

function repository(owner: string, repo: string): RepositoryIdentity {
  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    canonicalFullName: `${owner}/${repo}`.toLocaleLowerCase('en-US'),
  };
}

describe('buildRepositoryPRProjection', () => {
  it('projects multiple repositories without evaluating PRMS authority', async () => {
    const root = await temporaryRoot();
    const clients = new Map([
      ['acme/one', mockClient({ repository: repository('Acme', 'One') })],
      [
        'acme/two',
        mockClient({
          repository: repository('Acme', 'Two'),
          pulls: [pullRequest({ number: 7, head: { sha: 'head-2' }, user: { login: 'bob' } })],
        }),
      ],
    ]);

    const result = await buildRepositoryPRProjection({
      repositories: [
        { owner: 'Acme', repo: 'One' },
        { owner: 'acme', repo: 'two' },
      ],
      localStateRoot: join(root, 'projection'),
      now: () => new Date('2026-07-17T02:00:00.000Z'),
      clientFactory: async (target) => clients.get(target.canonicalFullName)!,
    });

    expect(result).toMatchObject({
      schema: 'openslack.repository_pr_projection.v1',
      partial: false,
      authority: {
        humanApproval: 'not_evaluated',
        mergeReadiness: 'not_evaluated',
      },
      informational: true,
      budget: { used: 4, limit: 100, exhausted: false },
    });
    expect(result.items.map((item) => `${item.repository.fullName}#${item.prNumber}`)).toEqual([
      'Acme/One#42',
      'acme/two#7',
    ]);
    expect(result.items[0]).toMatchObject({
      fetchedAt: '2026-07-17T02:00:00.000Z',
      ageSeconds: 0,
      stale: false,
      partial: false,
      source: 'github-live',
      checks: {
        total: 2,
        successful: 1,
        pending: 1,
        complete: true,
      },
    });
    expect(result.changes).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('untrusted PR body');
    expect(JSON.stringify(result)).not.toMatch(
      /"humanApproval":"approved"|"mergeReadiness":"ready"/i,
    );
  });

  it('deduplicates repository identity case-insensitively', async () => {
    const root = await temporaryRoot();
    const factory = vi.fn(async (target: RepositoryIdentity) =>
      mockClient({ repository: target, pulls: [] }),
    );

    const result = await buildRepositoryPRProjection({
      repositories: [
        { owner: 'Acme', repo: 'Project' },
        { owner: 'acme', repo: 'project' },
      ],
      localStateRoot: root,
      clientFactory: factory,
    });

    expect(result.repositories).toHaveLength(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('returns bounded partial output when the API budget is exhausted', async () => {
    const root = await temporaryRoot();
    const target = repository('Acme', 'Project');
    const checks = vi.fn().mockResolvedValue({ data: { check_runs: [] } });
    const client = mockClient({
      repository: target,
      pulls: [
        pullRequest({ number: 1, head: { sha: 'one' } }),
        pullRequest({ number: 2, head: { sha: 'two' } }),
        pullRequest({ number: 3, head: { sha: 'three' } }),
      ],
      checks,
    });

    const result = await buildRepositoryPRProjection({
      repositories: [target],
      localStateRoot: root,
      apiBudget: 2,
      clientFactory: async () => client,
    });

    expect(result.budget).toEqual({
      limit: 2,
      used: 2,
      remaining: 0,
      exhausted: true,
    });
    expect(result.partial).toBe(true);
    expect(checks).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(3);
    expect(result.items.filter((item) => item.checks.complete)).toHaveLength(1);
    expect(result.repositories[0]?.errorCode).toBe('API_BUDGET_EXHAUSTED');
  });

  it('enforces one global concurrency limit across repositories and check requests', async () => {
    const root = await temporaryRoot();
    let active = 0;
    let maximumActive = 0;
    const delayed = async <T>(value: T): Promise<T> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value;
    };
    const targets = [repository('Acme', 'One'), repository('Acme', 'Two')];
    const clients = new Map(
      targets.map((target) => [
        target.canonicalFullName,
        mockClient({
          repository: target,
          list: vi.fn(() => delayed({ data: [pullRequest()] })),
          checks: vi.fn(() => delayed({ data: { check_runs: [] } })),
        }),
      ]),
    );

    await buildRepositoryPRProjection({
      repositories: targets,
      localStateRoot: root,
      concurrency: 1,
      clientFactory: async (target) => clients.get(target.canonicalFullName)!,
    });

    expect(maximumActive).toBe(1);
  });

  it('serves a fresh cache without making GitHub calls and stamps cache metadata', async () => {
    const root = await temporaryRoot();
    const target = repository('Acme', 'Project');
    const factory = vi.fn(async () => mockClient({ repository: target }));
    let current = new Date('2026-07-17T02:00:00.000Z');

    await buildRepositoryPRProjection({
      repositories: [target],
      localStateRoot: root,
      cacheTtlSeconds: 60,
      now: () => current,
      clientFactory: factory,
    });
    current = new Date('2026-07-17T02:00:30.000Z');
    const cached = await buildRepositoryPRProjection({
      repositories: [target],
      localStateRoot: root,
      cacheTtlSeconds: 60,
      now: () => current,
      clientFactory: factory,
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(cached.budget.used).toBe(0);
    expect(cached.items[0]).toMatchObject({
      source: 'local-cache',
      ageSeconds: 30,
      stale: false,
      partial: false,
    });
  });

  it('falls back to stale cache without mutating the projection cursor on GitHub failure', async () => {
    const root = await temporaryRoot();
    const target = repository('Acme', 'Project');
    let current = new Date('2026-07-17T02:00:00.000Z');
    await buildRepositoryPRProjection({
      repositories: [target],
      localStateRoot: root,
      cacheTtlSeconds: 60,
      now: () => current,
      clientFactory: async () => mockClient({ repository: target }),
    });
    const cursorPath = join(root, 'cursors', 'acme--project.json');
    const cursorBefore = await readFile(cursorPath, 'utf8');
    current = new Date('2026-07-17T02:02:00.000Z');
    const fallback = await buildRepositoryPRProjection({
      repositories: [target],
      localStateRoot: root,
      cacheTtlSeconds: 60,
      now: () => current,
      clientFactory: async () => {
        throw new Error('network detail must not be surfaced');
      },
    });

    expect(fallback.repositories[0]).toMatchObject({
      source: 'local-cache',
      stale: true,
      partial: true,
      ageSeconds: 120,
      errorCode: 'GITHUB_UNAVAILABLE',
    });
    expect(await readFile(cursorPath, 'utf8')).toBe(cursorBefore);
    expect(JSON.stringify(fallback)).not.toContain('network detail');
  });

  it('fails closed on malformed or over-broad local cache and cursor records', async () => {
    const root = await temporaryRoot();
    const target = repository('Acme', 'Project');
    const cacheDirectory = join(root, 'cache');
    const cursorDirectory = join(root, 'cursors');
    await mkdir(cacheDirectory, { recursive: true });
    await mkdir(cursorDirectory, { recursive: true });
    await writeFile(
      join(cacheDirectory, 'acme--project.json'),
      JSON.stringify({
        schema: 'openslack.repository_pr_projection_cache.v1',
        repository: target,
        fetchedAt: '2026-07-17T02:00:00.000Z',
        items: [
          {
            prNumber: 42,
            title: 'poisoned',
            author: 'mallory',
            state: 'open',
            draft: false,
            headSha: 'poisoned',
            updatedAt: '2026-07-17T01:00:00.000Z',
            checks: {
              total: 0,
              pending: 0,
              successful: 0,
              failed: 0,
              neutral: 0,
              complete: true,
            },
            body: 'must never survive the display-field allowlist',
          },
        ],
      }),
      'utf8',
    );
    await writeFile(
      join(cursorDirectory, 'acme--project.json'),
      JSON.stringify({
        schema: 'openslack.repository_pr_projection_cursor.v1',
        repository: target,
        updatedAt: '2026-07-17T02:00:00.000Z',
        pullRequests: {
          42: {
            state: 'closed',
            headSha: 'poisoned',
            checks: {
              total: 1,
              pending: 0,
              successful: 0,
              failed: 0,
              neutral: 0,
              complete: true,
            },
          },
        },
      }),
      'utf8',
    );
    const factory = vi.fn(async () => mockClient({ repository: target }));

    const result = await buildRepositoryPRProjection({
      repositories: [target],
      localStateRoot: root,
      cacheTtlSeconds: 60,
      now: () => new Date('2026-07-17T02:00:30.000Z'),
      clientFactory: factory,
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(result.items[0]).toMatchObject({
      title: 'Projection title',
      source: 'github-live',
    });
    expect(result.changes).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('poisoned');
    expect(JSON.stringify(result)).not.toContain('display-field allowlist');
  });

  it('emits only synthetic PR-state and check-summary projection changes', async () => {
    const root = await temporaryRoot();
    const target = repository('Acme', 'Project');
    let current = new Date('2026-07-17T02:00:00.000Z');
    await buildRepositoryPRProjection({
      repositories: [target],
      localStateRoot: root,
      cacheTtlSeconds: 0,
      now: () => current,
      clientFactory: async () => mockClient({ repository: target }),
    });

    current = new Date('2026-07-17T02:01:00.000Z');
    const changed = await buildRepositoryPRProjection({
      repositories: [target],
      localStateRoot: root,
      cacheTtlSeconds: 0,
      now: () => current,
      clientFactory: async () =>
        mockClient({
          repository: target,
          pulls: [pullRequest({ state: 'open', head: { sha: 'head-2' } })],
          checks: vi.fn().mockResolvedValue({
            data: {
              check_runs: [{ status: 'completed', conclusion: 'failure', name: 'test' }],
            },
          }),
        }),
    });

    expect(changed.changes.map((change) => change.kind)).toEqual([
      'checks.summary_changed',
      'pull_request.state_changed',
    ]);
    expect(changed.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'pull_request.state_changed',
          synthetic: true,
          source: 'poll',
          changedFields: ['headSha'],
        }),
        expect.objectContaining({
          kind: 'checks.summary_changed',
          synthetic: true,
          source: 'poll',
        }),
      ]),
    );
    expect(JSON.stringify(changed.changes)).not.toMatch(/review_submitted|approval|authoritative/i);
  });

  it('detects a formerly open pull request becoming closed without displaying it', async () => {
    const root = await temporaryRoot();
    const target = repository('Acme', 'Project');
    let current = new Date('2026-07-17T02:00:00.000Z');
    await buildRepositoryPRProjection({
      repositories: [target],
      localStateRoot: root,
      cacheTtlSeconds: 0,
      now: () => current,
      clientFactory: async () => mockClient({ repository: target }),
    });

    current = new Date('2026-07-17T02:01:00.000Z');
    const get = vi.fn().mockResolvedValue({
      data: { state: 'closed', head: { sha: 'head-1' } },
    });
    const result = await buildRepositoryPRProjection({
      repositories: [target],
      localStateRoot: root,
      cacheTtlSeconds: 0,
      now: () => current,
      clientFactory: async () => mockClient({ repository: target, pulls: [], get }),
    });

    expect(result.items).toEqual([]);
    expect(get).toHaveBeenCalledWith({
      owner: 'Acme',
      repo: 'Project',
      pull_number: 42,
    });
    expect(result.changes).toEqual([
      expect.objectContaining({
        kind: 'pull_request.state_changed',
        prNumber: 42,
        changedFields: ['state'],
        previous: { state: 'open', headSha: 'head-1' },
        current: { state: 'closed', headSha: 'head-1' },
      }),
    ]);
  });

  it('keeps projection cache/cursors separate from the legacy Issue cursor path', async () => {
    const workspace = await temporaryRoot();
    const localStateRoot = join(workspace, '.openslack.local', 'pr-projection');
    const legacyPath = join(workspace, '.openslack.local', 'daemon', 'state.json');
    await mkdir(join(workspace, '.openslack.local', 'daemon'), { recursive: true });
    const legacy =
      '{"schema":"openslack.watch_cursor.v1","repos":{"acme/project":{"lastSeenAt":"x","lastIssueNumber":1}}}\n';
    await writeFile(legacyPath, legacy, 'utf8');
    const target = repository('Acme', 'Project');

    await buildRepositoryPRProjection({
      repositories: [target],
      workspaceRoot: workspace,
      localStateRoot,
      clientFactory: async () => mockClient({ repository: target }),
    });

    expect(await readFile(legacyPath, 'utf8')).toBe(legacy);
    expect(await readdir(join(localStateRoot, 'cache'))).toEqual(['acme--project.json']);
    expect(await readdir(join(localStateRoot, 'cursors'))).toEqual(['acme--project.json']);
    expect(
      (await readdir(join(localStateRoot, 'cache'))).some((path) => path.endsWith('.tmp')),
    ).toBe(false);
  });

  it('validates bounded options and repository names before any state write', async () => {
    const root = await temporaryRoot();
    await expect(
      buildRepositoryPRProjection({
        repositories: [{ owner: 'bad/name', repo: 'repo' }],
        localStateRoot: root,
      }),
    ).rejects.toThrow(/Invalid GitHub repository/);
    await expect(
      buildRepositoryPRProjection({
        repositories: [{ owner: 'Acme', repo: 'Project' }],
        concurrency: 0,
        localStateRoot: root,
      }),
    ).rejects.toThrow(/concurrency/);
    await expect(
      buildRepositoryPRProjection({
        repositories: [{ owner: 'Acme', repo: 'Project' }],
        apiBudget: 10_001,
        localStateRoot: root,
      }),
    ).rejects.toThrow(/apiBudget/);
  });
});

describe('renderRepositoryPRProjection', () => {
  it('renders repository/source/freshness/partial fields without merge claims', async () => {
    const root = await temporaryRoot();
    const target = repository('Acme', 'Project');
    const result = await buildRepositoryPRProjection({
      repositories: [target],
      localStateRoot: root,
      clientFactory: async () => mockClient({ repository: target }),
    });
    const rendered = renderRepositoryPRProjection(result);

    expect(rendered).toContain('[Acme/Project] source=github-live');
    expect(rendered).toContain('fetchedAt=');
    expect(rendered).toContain('stale=no');
    expect(rendered).toContain('partial=no');
    expect(rendered).toContain('human approval and merge readiness are not evaluated');
    expect(rendered).not.toContain('READY_TO_MERGE');
  });
});

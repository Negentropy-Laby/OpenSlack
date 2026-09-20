import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimRefPresent,
  getDefaultBranch,
  isBranchProtected,
  listOpenPRsForBranch,
} from '../branch-evidence.js';
import { getPR } from '../pr.js';

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  repo: vi.fn(),
  branch: vi.fn(),
  rules: vi.fn(),
  pulls: vi.fn(),
  ref: vi.fn(),
  pr: vi.fn(),
  graphql: vi.fn(),
}));
vi.mock('../client.js', () => ({ getClient: mocks.getClient }));
const sha = 'a'.repeat(40);
const missing = () => Object.assign(new Error('not found'), { status: 404 });
const response = (data: unknown) => ({ data, headers: {} });
const pull = (number = 1, head = 'feature', base = 'main') => ({
  number,
  state: 'open',
  head: { ref: head, sha, repo: { full_name: 'owner/repo' } },
  base: { ref: base, sha, repo: { full_name: 'owner/repo' } },
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getClient.mockResolvedValue({
    owner: 'owner',
    repo: 'repo',
    isDryRun: false,
    octokit: {
      repos: { get: mocks.repo, getBranch: mocks.branch },
      request: mocks.rules,
      pulls: { list: mocks.pulls, get: mocks.pr },
      git: { getRef: mocks.ref },
      graphql: mocks.graphql,
    },
  });
  mocks.repo.mockResolvedValue(response({ full_name: 'owner/repo', default_branch: 'main' }));
  mocks.branch.mockResolvedValue(response({ name: 'feature', protected: false }));
  mocks.rules.mockResolvedValue(response([]));
  mocks.pulls.mockResolvedValue(response([]));
  mocks.ref.mockImplementation(async ({ ref }) =>
    response({ ref: `refs/${ref}`, object: { sha } }),
  );
});

describe('branch evidence', () => {
  it('requires live evidence', async () => {
    mocks.getClient.mockResolvedValue({ isDryRun: true });
    await expect(getDefaultBranch()).rejects.toThrow('REQUIRES_LIVE');
  });
  it('reads default branch and rejects missing or wrong repository identity', async () => {
    expect(await getDefaultBranch()).toBe('main');
    mocks.repo.mockResolvedValue(response({ default_branch: 'main' }));
    await expect(getDefaultBranch()).rejects.toThrow('INVALID');
  });
  it('reads classic protection and effective rules', async () => {
    expect(await isBranchProtected('feature')).toBe(false);
    mocks.rules.mockResolvedValue(response([{ type: 'deletion' }]));
    expect(await isBranchProtected('feature')).toBe(true);
    mocks.branch.mockResolvedValue(response({ name: 'feature', protected: true }));
    mocks.rules.mockRejectedValue(missing());
    expect(await isBranchProtected('feature')).toBe(true);
  });
  it('does not treat branch or rules 404 as unprotected', async () => {
    mocks.rules.mockRejectedValue(missing());
    await expect(isBranchProtected('feature')).rejects.toMatchObject({ status: 404 });
    mocks.branch.mockRejectedValue(missing());
    await expect(isBranchProtected('feature')).rejects.toMatchObject({ status: 404 });
  });
  it('rejects incomplete protection responses', async () => {
    mocks.branch.mockResolvedValue(response({ name: 'feature' }));
    await expect(isBranchProtected('feature')).rejects.toThrow('INVALID');
  });
  it('fully paginates both head and base dependencies with shared cancellation', async () => {
    const signal = new AbortController().signal;
    mocks.pulls
      .mockResolvedValueOnce(response(Array.from({ length: 100 }, (_, n) => pull(n + 1, 'other'))))
      .mockResolvedValueOnce(
        response([pull(101), pull(102, 'other', 'feature'), pull(103, 'other')]),
      );
    expect((await listOpenPRsForBranch('feature', { signal })).map((pr) => pr.number)).toEqual([
      101, 102,
    ]);
    expect(mocks.pulls).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ page: 2, request: { signal } }),
    );
  });
  it('follows explicit next link even for a short page', async () => {
    mocks.pulls
      .mockResolvedValueOnce({ data: [pull()], headers: { link: '<url>; rel="next"' } })
      .mockResolvedValueOnce(response([pull(2, 'other', 'feature')]));
    expect(await listOpenPRsForBranch('feature')).toHaveLength(2);
  });
  it('rejects failed or truncated pagination', async () => {
    mocks.pulls.mockResolvedValue(response(Array.from({ length: 100 }, (_, n) => pull(n + 1))));
    await expect(
      listOpenPRsForBranch('feature', { evidenceLimits: { maxPages: 1 } }),
    ).rejects.toThrow('PAGES_LIMIT');
    mocks.pulls.mockRejectedValue(missing());
    await expect(listOpenPRsForBranch('feature')).rejects.toMatchObject({ status: 404 });
  });
  it('does not return partial dependencies when a later page fails', async () => {
    mocks.pulls
      .mockResolvedValueOnce({ data: [pull()], headers: { link: '<url>; rel="next"' } })
      .mockRejectedValueOnce(new Error('second page unavailable'));
    await expect(listOpenPRsForBranch('feature')).rejects.toThrow('second page unavailable');
  });
  it('stops paginated reads when the shared deadline is cancelled', async () => {
    const controller = new AbortController();
    mocks.pulls.mockImplementationOnce(async () => {
      controller.abort();
      return { data: [pull()], headers: { link: '<url>; rel="next"' } };
    });
    await expect(listOpenPRsForBranch('feature', { signal: controller.signal })).rejects.toThrow();
    expect(mocks.pulls).toHaveBeenCalledTimes(1);
  });
  it('does not mistake an unrelated fork head for this branch', async () => {
    const fork = pull();
    fork.head.repo.full_name = 'fork/repo';
    mocks.pulls.mockResolvedValue(response([fork]));
    expect(await listOpenPRsForBranch('feature')).toEqual([]);
  });
  it('fails closed on missing relevant repository identity', async () => {
    mocks.pulls.mockResolvedValue(response([{ ...pull(), head: { ref: 'feature', repo: null } }]));
    await expect(listOpenPRsForBranch('feature')).rejects.toThrow('INVALID');
  });
  it('reports present claim and proves same-client ref readability around absent claim', async () => {
    expect(await claimRefPresent(12)).toBe(true);
    mocks.ref.mockClear();
    mocks.ref.mockImplementation(async ({ ref }) => {
      if (ref.includes('claims')) throw missing();
      return response({ ref: `refs/${ref}`, object: { sha } });
    });
    expect(await claimRefPresent(12)).toBe(false);
    expect(mocks.ref.mock.calls.map(([arg]) => arg.ref)).toEqual([
      'heads/main',
      'heads/openslack/claims/issue-12',
      'heads/main',
    ]);
  });
  it('does not infer absent when repository or ref proof cannot be read', async () => {
    mocks.repo.mockRejectedValue(missing());
    await expect(claimRefPresent(12)).rejects.toMatchObject({ status: 404 });
    expect(mocks.ref).not.toHaveBeenCalled();
  });
  it('fails when access is lost after claim 404', async () => {
    mocks.ref
      .mockResolvedValueOnce(response({ ref: 'refs/heads/main', object: { sha } }))
      .mockRejectedValueOnce(missing())
      .mockRejectedValueOnce(missing());
    await expect(claimRefPresent(12)).rejects.toMatchObject({ status: 404 });
  });
  it('propagates non-404 claim failures', async () => {
    mocks.ref
      .mockResolvedValueOnce(response({ ref: 'refs/heads/main', object: { sha } }))
      .mockRejectedValueOnce(new Error('offline'));
    await expect(claimRefPresent(12)).rejects.toThrow('offline');
  });
  it.each([
    { ref: 'refs/heads/wrong', object: { sha } },
    { ref: 'refs/heads/main', object: { sha: 'abc123' } },
  ])('rejects invalid ref readability proof %#', async (proof) => {
    mocks.ref.mockResolvedValueOnce(response(proof));
    await expect(claimRefPresent(12)).rejects.toThrow('INVALID');
    expect(mocks.ref).toHaveBeenCalledTimes(1);
  });
  it('rejects aborted requests without API reads', async () => {
    const signal = AbortSignal.abort();
    await expect(listOpenPRsForBranch('feature', { signal })).rejects.toThrow();
    expect(mocks.getClient).not.toHaveBeenCalled();
  });
});

describe('PR repository identity', () => {
  it('maps REST repository identities without inventing missing evidence', async () => {
    mocks.pr.mockResolvedValue(response(pull()));
    expect((await getPR(1))?.head.repoFullName).toBe('owner/repo');
    mocks.pr.mockResolvedValue(response({ ...pull(), head: { ref: 'feature', sha, repo: null } }));
    expect((await getPR(1))?.head.repoFullName).toBeUndefined();
  });
  it('uses actual GraphQL repository and headRepository schema', async () => {
    mocks.pr.mockRejectedValue(missing());
    mocks.graphql.mockResolvedValue({
      repository: {
        nameWithOwner: 'owner/repo',
        pullRequest: {
          number: 1,
          headRefName: 'feature',
          headRefOid: sha,
          baseRefName: 'main',
          baseRefOid: sha,
          headRepository: { nameWithOwner: 'fork/repo' },
        },
      },
    });
    const pr = await getPR(1, { strictEvidence: true });
    expect(pr?.head.repoFullName).toBe('fork/repo');
    expect(pr?.base.repoFullName).toBe('owner/repo');
    const query = mocks.graphql.mock.calls[0][0];
    expect(query).toContain('headRepository { nameWithOwner }');
    expect(query).not.toContain('baseRepository');
    mocks.graphql.mockResolvedValue({ repository: { pullRequest: { number: 1 } } });
    const missingIdentity = await getPR(1);
    expect(missingIdentity?.base.repoFullName).toBeUndefined();
    expect(missingIdentity?.head.repoFullName).toBeUndefined();
  });
});

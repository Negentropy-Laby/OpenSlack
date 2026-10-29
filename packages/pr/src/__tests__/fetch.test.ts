import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  mockGetPR: vi.fn(),
  mockListPRFiles: vi.fn(),
  mockGetPRChecks: vi.fn(),
  mockGetPRReviews: vi.fn(),
  mockGetPRFilePatches: vi.fn(),
  mockGetRepositoryTree: vi.fn(),
  mockFindWorkflowGovernanceIssue: vi.fn(),
}));

vi.mock('@openslack/github', () => ({
  getPR: (...args: unknown[]) => hoisted.mockGetPR(...args),
  listPRFiles: (...args: unknown[]) => hoisted.mockListPRFiles(...args),
  getPRChecks: (...args: unknown[]) => hoisted.mockGetPRChecks(...args),
  getPRReviews: (...args: unknown[]) => hoisted.mockGetPRReviews(...args),
  getPRFilePatches: (...args: unknown[]) => hoisted.mockGetPRFilePatches(...args),
  getRepositoryTree: (...args: unknown[]) => hoisted.mockGetRepositoryTree(...args),
  findWorkflowGovernanceIssue: (...args: unknown[]) =>
    hoisted.mockFindWorkflowGovernanceIssue(...args),
}));

import { fetchPRDetails } from '../fetch.js';

function mockPR(overrides: Record<string, unknown> = {}) {
  return {
    number: 138,
    title: 'tui: complete productization closure repairs',
    body: '',
    state: 'open',
    draft: false,
    head: { ref: 'prms/live-evidence-hardening', sha: 'head-sha' },
    base: { ref: 'main', sha: 'base-sha' },
    user: { login: 'openslack-agent-operator[bot]' },
    mergeable: true,
    mergeable_state: 'clean',
    merged: false,
    url: 'https://github.com/Negentropy-Laby/OpenSlack/pull/138',
    created_at: '2026-06-01T14:00:00Z',
    updated_at: '2026-06-01T14:32:04Z',
    ...overrides,
  };
}

describe('fetchPRDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.mockGetPR.mockResolvedValue(mockPR());
    hoisted.mockListPRFiles.mockResolvedValue(['packages/pr/src/fetch.ts']);
    hoisted.mockGetPRChecks.mockResolvedValue([
      { name: 'validate', status: 'completed', conclusion: 'success' },
    ]);
    hoisted.mockGetPRReviews.mockResolvedValue([
      {
        user: { login: 'wsman' },
        state: 'APPROVED',
        body: 'approved',
        submittedAt: '2026-06-01T14:32:04Z',
        commitOid: 'head-sha',
      },
    ]);
    hoisted.mockGetPRFilePatches.mockResolvedValue([]);
    hoisted.mockFindWorkflowGovernanceIssue.mockResolvedValue(undefined);
  });

  it('builds ready evidence from complete live data', async () => {
    const report = await fetchPRDetails(138, { strictEvidence: true });

    expect(report.state).toBe('open');
    expect(report.checks).toEqual([
      { name: 'validate', status: 'completed', conclusion: 'success' },
    ]);
    expect(report.reviews).toEqual([
      {
        user: 'wsman',
        state: 'APPROVED',
        body: 'approved',
        submittedAt: '2026-06-01T14:32:04Z',
        commitOid: 'head-sha',
      },
    ]);
    expect(report.humanApprovals).toEqual([{ user: 'wsman' }]);
    expect(hoisted.mockGetPRFilePatches).not.toHaveBeenCalled();
    expect(hoisted.mockGetPR).toHaveBeenCalledTimes(2);
    expect(hoisted.mockGetPR.mock.invocationCallOrder[0]).toBeLessThan(
      hoisted.mockListPRFiles.mock.invocationCallOrder[0]!,
    );
    expect(hoisted.mockGetPR.mock.invocationCallOrder[1]).toBeGreaterThan(
      hoisted.mockGetPRReviews.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    ['head SHA', { head: { ref: 'prms/live-evidence-hardening', sha: 'new-head' } }],
    ['base SHA', { base: { ref: 'main', sha: 'new-base' } }],
    ['head ref', { head: { ref: 'another-branch', sha: 'head-sha' } }],
    ['base ref', { base: { ref: 'another-base', sha: 'base-sha' } }],
    [
      'head repository',
      {
        head: {
          ref: 'prms/live-evidence-hardening',
          sha: 'head-sha',
          repoFullName: 'another/repo',
        },
      },
    ],
    ['base repository', { base: { ref: 'main', sha: 'base-sha', repoFullName: 'another/repo' } }],
    ['Draft state', { draft: true }],
    ['open state', { state: 'closed' }],
    ['merged state', { merged: true }],
    ['classification body', { body: 'updated governance or profile metadata' }],
    ['classification title', { title: 'updated title' }],
    ['author', { user: { login: 'another-author' } }],
  ])('refuses a report when %s changes during evidence collection', async (_field, overrides) => {
    hoisted.mockGetPR.mockResolvedValueOnce(mockPR()).mockResolvedValueOnce(mockPR(overrides));
    await expect(fetchPRDetails(138, { strictEvidence: true })).rejects.toMatchObject({
      code: 'PR_EVIDENCE_SNAPSHOT_CHANGED',
    });
  });

  it('refuses missing initial PR evidence before collecting dependent data', async () => {
    hoisted.mockGetPR.mockResolvedValueOnce(null);
    await expect(fetchPRDetails(138, { strictEvidence: true })).rejects.toMatchObject({
      code: 'PR_EVIDENCE_SNAPSHOT_UNAVAILABLE',
    });
    expect(hoisted.mockListPRFiles).not.toHaveBeenCalled();
  });

  it('refuses a report if the final PR read is unavailable', async () => {
    hoisted.mockGetPR.mockResolvedValueOnce(mockPR()).mockResolvedValueOnce(null);
    await expect(fetchPRDetails(138, { strictEvidence: true })).rejects.toMatchObject({
      code: 'PR_EVIDENCE_SNAPSHOT_UNAVAILABLE',
    });
  });

  it('retains the cause when the final PR request fails', async () => {
    const cause = new Error('final PR request failed');
    hoisted.mockGetPR.mockResolvedValueOnce(mockPR()).mockRejectedValueOnce(cause);
    await expect(fetchPRDetails(138, { strictEvidence: true })).rejects.toMatchObject({
      code: 'PR_EVIDENCE_SNAPSHOT_UNAVAILABLE',
      cause,
    });
  });

  it('does not treat settled mergeability as an input identity change', async () => {
    hoisted.mockGetPR
      .mockResolvedValueOnce(mockPR({ mergeable: null }))
      .mockResolvedValueOnce(mockPR({ mergeable: true, updated_at: '2026-06-01T14:33:00Z' }));
    await expect(fetchPRDetails(138, { strictEvidence: true })).resolves.toMatchObject({
      headSha: 'head-sha',
      mergeable: true,
    });
  });

  it.each(['initial', 'final'])(
    'rejects a foreign PR returned at the %s evidence boundary',
    async (boundary) => {
      if (boundary === 'initial') hoisted.mockGetPR.mockResolvedValueOnce(mockPR({ number: 999 }));
      else
        hoisted.mockGetPR
          .mockResolvedValueOnce(mockPR())
          .mockResolvedValueOnce(mockPR({ number: 999 }));
      await expect(fetchPRDetails(138, { strictEvidence: true })).rejects.toMatchObject({
        code: 'PR_EVIDENCE_SNAPSHOT_CHANGED',
      });
      if (boundary === 'initial') expect(hoisted.mockListPRFiles).not.toHaveBeenCalled();
    },
  );

  it('keeps the initial PR inputs isolated from mutation across an evidence await', async () => {
    const original = mockPR();
    hoisted.mockGetPR.mockResolvedValueOnce(original).mockResolvedValueOnce(mockPR());
    hoisted.mockListPRFiles.mockImplementationOnce(async () => {
      original.body = '```openslack-profile-sync-metadata\nchanged after collection began';
      original.head.sha = 'mutated-head';
      return ['packages/pr/src/fetch.ts'];
    });
    const report = await fetchPRDetails(138, { strictEvidence: true });
    expect(report.body).toBe('');
    expect(report.headSha).toBe('head-sha');
    expect(hoisted.mockGetPRFilePatches).not.toHaveBeenCalled();
  });

  it('uses only the latest review state per reviewer', async () => {
    hoisted.mockGetPRReviews.mockResolvedValue([
      {
        user: { login: 'wsman' },
        state: 'APPROVED',
        body: 'approved',
        submittedAt: '2026-06-01T14:00:00Z',
        commitOid: 'head-sha',
      },
      {
        user: { login: 'wsman' },
        state: 'CHANGES_REQUESTED',
        body: 'needs work',
        submittedAt: '2026-06-01T14:05:00Z',
        commitOid: 'head-sha',
      },
      {
        user: { login: 'alice' },
        state: 'APPROVED',
        body: 'approved',
        submittedAt: '2026-06-01T14:06:00Z',
        commitOid: 'head-sha',
      },
    ]);

    const report = await fetchPRDetails(138, { strictEvidence: true });

    expect(report.reviews).toEqual([
      {
        user: 'wsman',
        state: 'CHANGES_REQUESTED',
        body: 'needs work',
        submittedAt: '2026-06-01T14:05:00Z',
        commitOid: 'head-sha',
      },
      {
        user: 'alice',
        state: 'APPROVED',
        body: 'approved',
        submittedAt: '2026-06-01T14:06:00Z',
        commitOid: 'head-sha',
      },
    ]);
    expect(report.humanApprovals).toEqual([{ user: 'alice' }]);
  });

  it('excludes author and bot approvals from humanApprovals', async () => {
    hoisted.mockGetPR.mockResolvedValue(mockPR({ user: { login: 'wsman' } }));
    hoisted.mockGetPRReviews.mockResolvedValue([
      {
        user: { login: 'wsman' },
        state: 'APPROVED',
        body: 'self approval',
        submittedAt: '2026-06-01T14:00:00Z',
        commitOid: 'head-sha',
      },
      {
        user: { login: 'github-actions[bot]' },
        state: 'APPROVED',
        body: 'bot approval',
        submittedAt: '2026-06-01T14:01:00Z',
        commitOid: 'head-sha',
      },
      {
        user: { login: 'alice' },
        state: 'APPROVED',
        body: 'human approval',
        submittedAt: '2026-06-01T14:02:00Z',
        commitOid: 'head-sha',
      },
    ]);

    const report = await fetchPRDetails(138, { strictEvidence: true });

    expect(report.humanApprovals).toEqual([{ user: 'alice' }]);
  });

  it('propagates strict evidence failures instead of fabricating missing approval', async () => {
    const error = new Error('GITHUB_EVIDENCE_UNAVAILABLE: reviews failed');
    hoisted.mockGetPRReviews.mockRejectedValue(error);

    await expect(fetchPRDetails(138, { strictEvidence: true })).rejects.toBe(error);
  });

  it('fetches patches only for profile-sync candidates', async () => {
    hoisted.mockGetPR.mockResolvedValue(
      mockPR({ head: { ref: 'openslack/profile-sync/latest', sha: 'head-sha' } }),
    );
    hoisted.mockListPRFiles.mockResolvedValue(['profile/README.md']);
    hoisted.mockGetPRFilePatches.mockResolvedValue([
      { filename: 'profile/README.md', patch: '@@ marker patch' },
    ]);

    const report = await fetchPRDetails(138, { strictEvidence: true });

    expect(hoisted.mockGetPRFilePatches).toHaveBeenCalledWith(138, { strictEvidence: true });
    expect(report.filePatches).toEqual([
      { filename: 'profile/README.md', patch: '@@ marker patch' },
    ]);
  });

  it('binds a new workflow artifact to its governance issue evidence', async () => {
    const path = 'templates/workflows/new.yaml';
    hoisted.mockListPRFiles.mockResolvedValue([path]);
    hoisted.mockGetRepositoryTree
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ path, mode: '100644', type: 'blob', sha: 'new' }]);
    hoisted.mockFindWorkflowGovernanceIssue.mockResolvedValue({
      issueNumber: 177,
      url: 'issue-url',
      body: 'governance evidence',
      author: 'openslack-agent-operator[bot]',
    });

    const report = await fetchPRDetails(138, { strictEvidence: true });

    expect(report.workflowEvidence?.addedFiles).toEqual([path]);
    expect(report.workflowGovernanceIssue).toEqual({
      issueNumber: 177,
      prNumber: 138,
      author: 'openslack-agent-operator[bot]',
      body: 'governance evidence',
    });
    expect(hoisted.mockFindWorkflowGovernanceIssue).toHaveBeenCalledWith(138, {
      strictEvidence: true,
    });
  });
});

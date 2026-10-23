import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getClient: vi.fn() }));
vi.mock('../client.js', () => ({ getClient: hoisted.getClient }));

import { finalizeWorkflowPR } from '../workflow-lifecycle.js';

describe('finalizeWorkflowPR governance evidence', () => {
  const createComment = vi.fn();
  const addLabels = vi.fn();
  const update = vi.fn();
  const getPull = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.getClient.mockResolvedValue({
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      isDryRun: false,
      octokit: { issues: { createComment, addLabels, update }, pulls: { get: getPull } },
    });
    createComment.mockResolvedValue({ data: {} });
    addLabels.mockResolvedValue({ data: {} });
    update.mockResolvedValue({ data: {} });
    getPull.mockResolvedValue({
      data: { merged: true, head: { sha: 'head-sha' }, base: { sha: 'base-sha' } },
    });
  });

  it('closes the single governance issue with reviewer, commit, trust, and hash evidence', async () => {
    const result = await finalizeWorkflowPR(176, {
      governanceIssue: 177,
      workflowHash: 'sha256:evidence',
      trustDecision: 'trusted',
      trustReviewer: 'wsman',
      trustReviewCommitOid: 'head-sha',
      expectedHeadSha: 'head-sha',
      expectedBaseSha: 'base-sha',
    });

    expect(result.errors).toEqual([]);
    expect(result.closedIssues).toEqual([177]);
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 177,
        body: expect.stringContaining('**Reviewed Commit**: head-sha'),
      }),
    );
    expect(addLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 177,
        labels: ['lifecycle:accepted', 'workflow:trusted'],
      }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 177,
        state: 'closed',
      }),
    );
  });

  it.each([
    ['comment', createComment],
    ['label', addLabels],
    ['close', update],
  ])('keeps the governance issue open and reports a %s write failure', async (_step, operation) => {
    operation.mockRejectedValueOnce(new Error('write failed'));

    const result = await finalizeWorkflowPR(185, {
      governanceIssue: 186,
      workflowHash: 'sha256:evidence',
      trustDecision: 'core',
      trustReviewer: 'wsman',
      trustReviewCommitOid: 'head-sha',
      expectedHeadSha: 'head-sha',
      expectedBaseSha: 'base-sha',
    });

    expect(result.closedIssues).toEqual([]);
    expect(result.errors).toEqual(['Failed to finalize governance issue #186: write failed']);
    if (operation !== update) expect(update).not.toHaveBeenCalled();
  });

  it.each(['open', 'closed'])('does not write for an unmerged %s PR', async (state) => {
    getPull.mockResolvedValueOnce({ data: { merged: false, state } });
    const result = await finalizeWorkflowPR(176, {
      proposalIssue: 177,
      reviewIssue: 178,
      phaseIssues: [179],
    });
    expect(result.errors).not.toEqual([]);
    expect(createComment).not.toHaveBeenCalled();
    expect(addLabels).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('returns an explicit preview result without claiming live verification', async () => {
    hoisted.getClient.mockResolvedValueOnce({ isDryRun: true });
    expect(await finalizeWorkflowPR(176, { proposalIssue: 177 })).toMatchObject({
      dryRun: true,
      closedIssues: [],
    });
    expect(getPull).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('writes only explicitly selected lifecycle targets for a merged PR', async () => {
    const result = await finalizeWorkflowPR(176, {
      proposalIssue: 177,
      reviewIssue: 178,
      phaseIssues: [179],
    });
    expect(result.errors).toEqual([]);
    expect(result.closedIssues).toEqual([177, 179]);
    for (const operation of [createComment, addLabels, update]) {
      for (const [request] of operation.mock.calls)
        expect([177, 178, 179]).toContain(request.issue_number);
    }
    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 178 }));
  });

  it('fails closed when live PR lookup fails', async () => {
    getPull.mockRejectedValueOnce(new Error('offline'));
    const result = await finalizeWorkflowPR(176, { proposalIssue: 177 });
    expect(result.errors).not.toEqual([]);
    expect(update).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(addLabels).not.toHaveBeenCalled();
  });

  it.each(['head', 'base', 'missing-evidence', 'review-head'])(
    'rejects governance %s drift before any lifecycle write',
    async (kind) => {
      const opts = {
        governanceIssue: 177,
        proposalIssue: 178,
        workflowHash: 'sha256:evidence',
        trustDecision: 'trusted' as const,
        trustReviewer: 'wsman',
        trustReviewCommitOid: 'head-sha',
        expectedHeadSha: 'head-sha',
        expectedBaseSha: 'base-sha',
      };
      if (kind === 'head') opts.expectedHeadSha = 'other';
      if (kind === 'base') opts.expectedBaseSha = 'other';
      if (kind === 'missing-evidence') opts.workflowHash = '';
      if (kind === 'review-head') opts.trustReviewCommitOid = 'other';
      const result = await finalizeWorkflowPR(176, opts);
      expect(result.errors).not.toEqual([]);
      expect(update).not.toHaveBeenCalled();
      expect(createComment).not.toHaveBeenCalled();
      expect(addLabels).not.toHaveBeenCalled();
    },
  );
});

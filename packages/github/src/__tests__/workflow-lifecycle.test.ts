import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getClient: vi.fn() }));
vi.mock('../client.js', () => ({ getClient: hoisted.getClient }));

import { finalizeWorkflowPR, previewWorkflowFinalization } from '../workflow-lifecycle.js';

describe('finalizeWorkflowPR governance evidence', () => {
  const createComment = vi.fn();
  const addLabels = vi.fn();
  const update = vi.fn();
  const getPull = vi.fn();
  const listComments = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.getClient.mockResolvedValue({
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      isDryRun: false,
      octokit: {
        issues: { createComment, addLabels, update, listComments },
        pulls: { get: getPull },
      },
    });
    createComment.mockResolvedValue({ data: {} });
    addLabels.mockResolvedValue({ data: {} });
    update.mockResolvedValue({ data: {} });
    listComments.mockResolvedValue({ data: [] });
    getPull.mockResolvedValue({
      data: {
        merged: true,
        merged_at: '2026-11-02T10:00:00Z',
        head: { sha: 'head-sha' },
        base: { sha: 'base-sha' },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const governanceOptions = {
    governanceIssue: 177,
    workflowHash: 'sha256:evidence',
    trustDecision: 'trusted' as const,
    trustReviewer: 'wsman',
    trustReviewCommitOid: 'head-sha',
    expectedHeadSha: 'head-sha',
    expectedBaseSha: 'base-sha',
  };

  function expectNoEffects(result: Awaited<ReturnType<typeof finalizeWorkflowPR>>): void {
    expect(createComment).not.toHaveBeenCalled();
    expect(addLabels).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(result.commentedIssues).toEqual([]);
    expect(result.updatedLabels).toEqual([]);
    expect(result.closedIssues).toEqual([]);
  }

  it('retains confirmed comment receipts when a later label write fails', async () => {
    addLabels.mockRejectedValueOnce(new Error('write failed'));
    const result = await finalizeWorkflowPR(176, governanceOptions);
    expect(result.commentedIssues).toEqual([177]);
    expect(result.updatedLabels).toEqual([]);
    expect(result.closedIssues).toEqual([]);
    expect(result).toMatchObject({
      failures: [{ code: 'LIFECYCLE_WRITE_FAILED', stage: 'labels', issueNumber: 177 }],
    });
  });

  it('reuses the persisted governance comment after a partial failure', async () => {
    addLabels.mockRejectedValueOnce(new Error('write failed'));
    await finalizeWorkflowPR(176, governanceOptions);
    const body = createComment.mock.calls[0]![0].body;
    listComments.mockResolvedValue({ data: [{ body }] });
    const result = await finalizeWorkflowPR(176, governanceOptions);
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(result.errors).toEqual([]);
    expect(result.closedIssues).toEqual([177]);
  });

  it('does not repeat a confirmed governance comment when the chosen reviewer changes', async () => {
    addLabels.mockRejectedValueOnce(new Error('write failed'));
    await finalizeWorkflowPR(176, governanceOptions);
    const body = createComment.mock.calls[0]![0].body;
    listComments.mockResolvedValue({ data: [{ body }] });
    const result = await finalizeWorkflowPR(176, { ...governanceOptions, trustReviewer: 'Bob' });
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(result.errors).toEqual([]);
    expect(result.closedIssues).toEqual([177]);
  });

  function legacyGovernanceComment(reviewer = 'alice'): string {
    return [
      '## Workflow Governance Completed',
      '',
      'Merged via PR #176.',
      '- **Evidence Hash**: sha256:evidence',
      '- **Trust Decision**: trusted',
      `- **Reviewer**: @${reviewer}`,
      '- **Reviewed Commit**: head-sha',
    ].join('\n');
  }

  it('verifies the original SHA marker without making the old reviewer part of retry identity', async () => {
    const plain = legacyGovernanceComment();
    const key = createHash('sha256')
      .update(JSON.stringify([176, 177, 'head-sha', 'base-sha', plain]))
      .digest('hex');
    listComments.mockResolvedValue({
      data: [{ body: `${plain}\n\n<!-- openslack-workflow-finalize:${key} -->` }],
    });
    const result = await finalizeWorkflowPR(176, governanceOptions);
    expect(result.errors).toEqual([]);
    expect(result.commentedIssues).toEqual([177]);
    expect(createComment).not.toHaveBeenCalled();
  });

  it('retains compatible complete unmarked comments instead of posting a new marker', async () => {
    listComments.mockResolvedValue({ data: [{ body: legacyGovernanceComment() }] });
    const result = await finalizeWorkflowPR(176, governanceOptions);
    expect(result.errors).toEqual([]);
    expect(createComment).not.toHaveBeenCalled();
  });

  it('requires reconciliation for a corrupt legacy binding rather than posting over it', async () => {
    listComments.mockResolvedValue({
      data: [
        {
          body: `${legacyGovernanceComment()}\n\n<!-- openslack-workflow-finalize:${'0'.repeat(64)} -->`,
        },
      ],
    });
    const result = await finalizeWorkflowPR(176, governanceOptions);
    expect(result.failures).toEqual([
      { code: 'COMMENT_BINDING_UNCONFIRMED', stage: 'comment', issueNumber: 177 },
    ]);
    expect(createComment).not.toHaveBeenCalled();
    expect(addLabels).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('binds the readable marker to repository, target, kind, and live PR evidence', async () => {
    await finalizeWorkflowPR(176, governanceOptions);
    const body: string = createComment.mock.calls[0]![0].body;
    const match = body.match(/<!-- openslack-workflow-finalize:v2\n([^]*?)\n-->/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1]!)).toEqual({
      repository: 'Negentropy-Laby/OpenSlack',
      pr: 176,
      issue: 177,
      kind: 'governance',
      head: 'head-sha',
      base: 'base-sha',
      evidenceHash: 'sha256:evidence',
    });
  });

  it.each([
    ['repository', 'other/repository'],
    ['pr', 999],
    ['issue', 178],
    ['kind', 'review'],
    ['head', 'other-head'],
    ['base', 'other-base'],
    ['evidenceHash', 'other-hash'],
    ['extraField', true],
    ['head', undefined],
  ])('refuses a copied or malformed v2 %s binding before any new effect', async (key, value) => {
    await finalizeWorkflowPR(176, governanceOptions);
    const original: string = createComment.mock.calls[0]![0].body;
    const altered = original.replace(
      /(<!-- openslack-workflow-finalize:v2\n)([^\n]*)/u,
      (_match, prefix: string, encoded: string) =>
        prefix + JSON.stringify({ ...JSON.parse(encoded), [key]: value }),
    );
    createComment.mockClear();
    addLabels.mockClear();
    update.mockClear();
    listComments.mockResolvedValue({ data: [{ body: altered }] });
    const result = await finalizeWorkflowPR(176, governanceOptions);
    expect(result.failures?.[0]?.code).toBe('COMMENT_BINDING_UNCONFIRMED');
    expectNoEffects(result);
  });

  it.each(['malformed-json', 'trust', 'body'])(
    'does not accept a v2 marker without its complete matching %s evidence',
    async (kind) => {
      await finalizeWorkflowPR(176, governanceOptions);
      const original: string = createComment.mock.calls[0]![0].body;
      const altered =
        kind === 'malformed-json'
          ? original.replace(/(<!-- openslack-workflow-finalize:v2\n)[^\n]*/u, '$1{')
          : kind === 'trust'
            ? original.replace('**Trust Decision**: trusted', '**Trust Decision**: untrusted')
            : original.replace('**Evidence Hash**: sha256:evidence', '**Evidence Hash**: wrong');
      createComment.mockClear();
      addLabels.mockClear();
      update.mockClear();
      listComments.mockResolvedValue({ data: [{ body: altered }] });
      const result = await finalizeWorkflowPR(176, governanceOptions);
      expect(result.failures?.[0]?.code).toBe('COMMENT_BINDING_UNCONFIRMED');
      expectNoEffects(result);
    },
  );

  it('ignores a complete marker and body for another PR without treating it as this receipt', async () => {
    await finalizeWorkflowPR(176, governanceOptions);
    const original: string = createComment.mock.calls[0]![0].body;
    const other = original.replace('#176.', '#999.').replace('"pr":176', '"pr":999');
    createComment.mockClear();
    addLabels.mockClear();
    update.mockClear();
    listComments.mockResolvedValue({ data: [{ body: other }] });
    const result = await finalizeWorkflowPR(176, governanceOptions);
    expect(result.errors).toEqual([]);
    expect(createComment).toHaveBeenCalledTimes(1);
  });

  it.each([2, 100])(
    'finds a matching receipt on a full page %s without publishing again',
    async (lastPage) => {
      await finalizeWorkflowPR(176, governanceOptions);
      const body: string = createComment.mock.calls[0]![0].body;
      createComment.mockClear();
      addLabels.mockClear();
      update.mockClear();
      listComments.mockClear();
      listComments.mockImplementation(async ({ page }) => ({
        data: [
          ...Array.from({ length: 99 }, () => ({ body: 'unrelated' })),
          { body: page === lastPage ? body : 'unrelated' },
        ],
      }));
      const result = await finalizeWorkflowPR(176, governanceOptions);
      expect(result.errors).toEqual([]);
      expect(result.commentedIssues).toEqual([177]);
      expect(listComments).toHaveBeenCalledTimes(lastPage);
      expect(createComment).not.toHaveBeenCalled();
    },
  );

  it('retains a same-second comment under the actual strict updated-after filter', async () => {
    await finalizeWorkflowPR(176, governanceOptions);
    const body: string = createComment.mock.calls[0]![0].body;
    createComment.mockClear();
    addLabels.mockClear();
    update.mockClear();
    listComments.mockImplementation(async ({ since }) => ({
      data: Date.parse('2026-11-02T10:00:00Z') > Date.parse(since) ? [{ body }] : [],
    }));
    const result = await finalizeWorkflowPR(176, governanceOptions);
    expect(result.errors).toEqual([]);
    expect(createComment).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'retains a canonical legacy review comment (SHA marker: %s)',
    async (marked) => {
      const plain =
        '## Workflow Merged\n\nThis workflow was merged via PR #176.\n- **Hash**: sha256:evidence\n- **Trust Decision**: trusted';
      const marker = createHash('sha256')
        .update(JSON.stringify([176, 178, null, null, plain]))
        .digest('hex');
      listComments.mockResolvedValue({
        data: [
          { body: plain + (marked ? `\n\n<!-- openslack-workflow-finalize:${marker} -->` : '') },
        ],
      });
      const result = await finalizeWorkflowPR(176, {
        reviewIssue: 178,
        workflowHash: 'sha256:evidence',
        trustDecision: 'trusted',
        expectedHeadSha: 'head-sha',
        expectedBaseSha: 'base-sha',
      });
      expect(result.errors).toEqual([]);
      expect(result.commentedIssues).toEqual([178]);
      expect(createComment).not.toHaveBeenCalled();
    },
  );

  it('does not accept a legacy review marker copied from another Issue', async () => {
    const plain = '## Workflow Merged\n\nThis workflow was merged via PR #176.';
    const marker = createHash('sha256')
      .update(JSON.stringify([176, 999, null, null, plain]))
      .digest('hex');
    listComments.mockResolvedValue({
      data: [{ body: `${plain}\n\n<!-- openslack-workflow-finalize:${marker} -->` }],
    });
    const result = await finalizeWorkflowPR(176, { reviewIssue: 178 });
    expect(result.failures?.[0]?.code).toBe('COMMENT_BINDING_UNCONFIRMED');
    expectNoEffects(result);
  });

  it('does not scan unrelated pre-merge history in a long-lived issue', async () => {
    listComments.mockImplementation(async (request) => ({
      data: request.since
        ? []
        : Array.from({ length: 100 }, () => ({ body: 'old unrelated comment' })),
    }));
    const result = await finalizeWorkflowPR(176, governanceOptions);
    expect(result.errors).toEqual([]);
    expect(listComments).toHaveBeenCalledTimes(1);
    expect(listComments).toHaveBeenCalledWith(
      expect.objectContaining({
        since: '2026-11-02T09:59:59.000Z',
        per_page: 100,
        page: 1,
        request: { signal: expect.any(AbortSignal) },
      }),
    );
  });

  it.each([null, 'invalid'])(
    'uses conservative pagination when merge time is %s',
    async (mergedAt) => {
      getPull.mockResolvedValueOnce({
        data: {
          merged: true,
          merged_at: mergedAt,
          head: { sha: 'head-sha' },
          base: { sha: 'base-sha' },
        },
      });
      const result = await finalizeWorkflowPR(176, governanceOptions);
      expect(result.errors).toEqual([]);
      expect(listComments.mock.calls[0]![0]).not.toHaveProperty('since');
    },
  );

  it('does not misclassify a full pagination capacity as a network error', async () => {
    listComments.mockResolvedValue({
      data: Array.from({ length: 100 }, () => ({ body: 'unrelated' })),
    });
    const result = await finalizeWorkflowPR(176, governanceOptions);
    expect(listComments).toHaveBeenCalledTimes(100);
    expect(result.failures).toEqual([
      { code: 'COMMENT_LOOKUP_LIMIT_EXCEEDED', stage: 'comment', issueNumber: 177 },
    ]);
    expectNoEffects(result);
  });

  it('does not publish when the single monotonic lookup budget expires after a response', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    listComments.mockImplementation(async () => {
      now = 30_001;
      return { data: [] };
    });
    const result = await finalizeWorkflowPR(176, governanceOptions);
    expect(result.failures).toEqual([
      { code: 'COMMENT_LOOKUP_DEADLINE_EXCEEDED', stage: 'comment', issueNumber: 177 },
    ]);
    expectNoEffects(result);
  });

  it('shares the same lookup deadline across pages without renewing it', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    listComments.mockImplementation(async () => {
      now += 16_000;
      return {
        data:
          listComments.mock.calls.length === 1
            ? Array.from({ length: 100 }, () => ({ body: 'unrelated' }))
            : [],
      };
    });
    const result = await finalizeWorkflowPR(176, governanceOptions);
    expect(result.failures?.[0]?.code).toBe('COMMENT_LOOKUP_DEADLINE_EXCEEDED');
    expect(listComments).toHaveBeenCalledTimes(2);
    expectNoEffects(result);
  });

  it.each([false, true])(
    'rejects a page whose classification exhausts the lookup budget (match=%s)',
    async (matching) => {
      let now = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      listComments.mockResolvedValue({
        data: [
          {
            get body() {
              now = 30_001;
              return matching ? legacyGovernanceComment() : 'unrelated';
            },
          },
        ],
      });
      const result = await finalizeWorkflowPR(176, governanceOptions);
      expect(result.failures).toEqual([
        { code: 'COMMENT_LOOKUP_DEADLINE_EXCEEDED', stage: 'comment', issueNumber: 177 },
      ]);
      expectNoEffects(result);
    },
  );

  it('rechecks parent cancellation between a completed lookup and the POST continuation', async () => {
    const controller = new AbortController();
    listComments.mockResolvedValue({
      data: [
        {
          get body() {
            queueMicrotask(() => controller.abort());
            return 'unrelated';
          },
        },
      ],
    });
    const result = await finalizeWorkflowPR(176, governanceOptions, { signal: controller.signal });
    expect(result.failures).toEqual([
      { code: 'COMMENT_LOOKUP_DEADLINE_EXCEEDED', stage: 'comment', issueNumber: 177 },
    ]);
    expectNoEffects(result);
  });

  it('honors parent cancellation after a page even when the transport resolves successfully', async () => {
    const controller = new AbortController();
    const options = { requireLive: true, strictEvidence: true, signal: controller.signal };
    listComments.mockImplementation(async () => {
      controller.abort();
      return { data: [] };
    });
    const result = await finalizeWorkflowPR(176, governanceOptions, options);
    expect(hoisted.getClient).toHaveBeenCalledWith(options);
    expect(result.failures?.[0]?.code).toBe('COMMENT_LOOKUP_DEADLINE_EXCEEDED');
    expectNoEffects(result);
  });

  it('settles a genuinely stalled lookup at its single deadline and aborts its signal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    listComments.mockImplementation(() => new Promise(() => undefined));
    const pending = finalizeWorkflowPR(176, governanceOptions);
    await vi.advanceTimersByTimeAsync(0);
    expect(listComments).toHaveBeenCalledTimes(1);
    const signal: AbortSignal = listComments.mock.calls[0]![0].request.signal;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    expect(signal.aborted).toBe(true);
    expect(result.failures?.[0]?.code).toBe('COMMENT_LOOKUP_DEADLINE_EXCEEDED');
    expectNoEffects(result);
  });

  it('does not query or mutate when its parent was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await finalizeWorkflowPR(176, governanceOptions, { signal: controller.signal });
    expect(result.failures?.[0]?.code).toBe('LIFECYCLE_CANCELLED');
    expect(getPull).not.toHaveBeenCalled();
    expect(listComments).not.toHaveBeenCalled();
    expectNoEffects(result);
  });

  it('does not close a proposal when cancelled while reading the live PR', async () => {
    const controller = new AbortController();
    getPull.mockImplementation(async () => {
      controller.abort();
      return {
        data: {
          merged: true,
          head: { sha: 'head-sha' },
          base: { sha: 'base-sha' },
        },
      };
    });
    const result = await finalizeWorkflowPR(
      176,
      { proposalIssue: 178 },
      { signal: controller.signal },
    );
    expect(result.failures?.[0]?.code).toBe('LIFECYCLE_CANCELLED');
    expectNoEffects(result);
  });

  it('retains a confirmed POST and stops labels when cancellation follows that effect', async () => {
    const controller = new AbortController();
    createComment.mockImplementation(async () => {
      controller.abort();
      return { data: {} };
    });
    const result = await finalizeWorkflowPR(176, governanceOptions, { signal: controller.signal });
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(addLabels).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(result.commentedIssues).toEqual([177]);
    expect(result.updatedLabels).toEqual([]);
    expect(result.closedIssues).toEqual([]);
    expect(result.failures).toEqual([
      { code: 'LIFECYCLE_CANCELLED', stage: 'labels', issueNumber: 177 },
    ]);
  });

  it('does not mutate after cancellation during an existing-comment match', async () => {
    const controller = new AbortController();
    const comment = {
      get body() {
        controller.abort();
        return legacyGovernanceComment();
      },
    };
    listComments.mockResolvedValue({ data: [comment] });
    const result = await finalizeWorkflowPR(176, governanceOptions, { signal: controller.signal });
    expect(result.failures).toEqual([
      { code: 'COMMENT_LOOKUP_DEADLINE_EXCEEDED', stage: 'comment', issueNumber: 177 },
    ]);
    expectNoEffects(result);
  });

  it('preserves the reviewed per-kind effect order', async () => {
    const effects: string[] = [];
    createComment.mockImplementation(async ({ issue_number }) => {
      effects.push(`${issue_number}:comment`);
      return { data: {} };
    });
    addLabels.mockImplementation(async ({ issue_number }) => {
      effects.push(`${issue_number}:labels`);
      return { data: {} };
    });
    update.mockImplementation(async ({ issue_number }) => {
      effects.push(`${issue_number}:close`);
      return { data: {} };
    });
    const result = await finalizeWorkflowPR(176, {
      ...governanceOptions,
      proposalIssue: 178,
      reviewIssue: 179,
      phaseIssues: [180],
    });
    expect(result.errors).toEqual([]);
    expect(effects).toEqual([
      '177:comment',
      '177:labels',
      '177:close',
      '178:close',
      '178:labels',
      '179:comment',
      '179:labels',
      '180:close',
      '180:labels',
    ]);
  });

  it('distinguishes an unmerged PR from an unavailable GitHub query', async () => {
    getPull.mockResolvedValueOnce({ data: { merged: false } });
    expect(await finalizeWorkflowPR(176, governanceOptions)).toMatchObject({
      failures: [{ code: 'PR_NOT_MERGED', stage: 'preflight' }],
    });
    getPull.mockRejectedValueOnce(new Error('PRIVATE_RESPONSE_SENTINEL'));
    const result = await finalizeWorkflowPR(176, governanceOptions);
    expect(result).toMatchObject({ failures: [{ code: 'PR_QUERY_FAILED', stage: 'preflight' }] });
    expect(result.errors.join('\n')).not.toContain('PRIVATE_RESPONSE_SENTINEL');
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses further writes when a comment result is unknown', async () => {
    createComment.mockRejectedValueOnce(new Error('connection lost'));
    const result = await finalizeWorkflowPR(176, { ...governanceOptions, proposalIssue: 178 });
    expect(result).toMatchObject({
      failures: [{ code: 'COMMENT_RESULT_UNKNOWN', stage: 'comment', issueNumber: 177 }],
    });
    expect(addLabels).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledTimes(1);
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
    expect(result.errors).toEqual([
      expect.stringContaining('Failed to finalize governance issue #186:'),
    ]);
    expect(result.failures).toEqual([
      expect.objectContaining({
        issueNumber: 186,
        stage: _step === 'label' ? 'labels' : _step === 'close' ? 'close' : 'comment',
      }),
    ]);
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

  it('prepares a no-credential preview before any live PR lookup or lifecycle mutation', async () => {
    hoisted.getClient.mockResolvedValueOnce({ isDryRun: true });
    expect(await previewWorkflowFinalization(176)).toMatchObject({
      dryRun: true,
      failures: [],
      closedIssues: [],
    });
    expect(getPull).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(addLabels).not.toHaveBeenCalled();
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

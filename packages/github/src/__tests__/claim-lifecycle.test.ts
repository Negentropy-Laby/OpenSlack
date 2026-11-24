import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient } from '../client.js';
import {
  checkTaskClaimReview,
  completeClaim,
  heartbeatClaim,
  parseClaimReviewMetadata,
  parseHeartbeatMetadata,
  reviewClaim,
  type ClaimLifecycleDependencies,
} from '../claim-lifecycle.js';
import { renderClaimComment, type ClaimMetadata } from '../claims.js';
import { repairExpiredClaims } from '../repair.js';

interface HarnessOptions {
  owner?: string;
  refExists?: boolean;
  labels?: string[];
  fail?: Set<string>;
  prMerged?: boolean;
  prMergedAt?: string;
}

function statusError(
  status: number,
  message = 'provider-secret-canary',
): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function claimComment(agentId = 'agent-one', overrides: Partial<ClaimMetadata> = {}): string {
  const metadata: ClaimMetadata = {
    schema: 'openslack.claim.v1',
    issue_number: 42,
    agent_id: agentId,
    claim_ref: 'refs/heads/openslack/claims/issue-42',
    claimed_at: '2026-07-14T00:00:00.000Z',
    expires_at: '2026-07-14T01:00:00.000Z',
    principal: {
      registry_id: agentId,
      run_id: 'RUN-42',
      provider: 'cli',
    },
    ...overrides,
  };
  return renderClaimComment(metadata, 60);
}

function createHarness(options: HarnessOptions = {}) {
  let refExists = options.refExists ?? true;
  const labels = new Set(options.labels ?? ['openslack:claimed', 'openslack:running']);
  const comments: Array<{ id: number; body: string }> = [
    { id: 1, body: claimComment(options.owner ?? 'agent-one') },
  ];
  const fail = options.fail ?? new Set<string>();
  let nextCommentId = 2;

  const octokit = {
    git: {
      listMatchingRefs: vi.fn(async () => ({
        data: refExists ? [{ ref: 'refs/heads/openslack/claims/issue-42' }] : [],
      })),
      getRef: vi.fn(async () => {
        if (fail.has('getRef')) throw statusError(503);
        if (!refExists) throw statusError(404);
        return { data: { object: { sha: 'a'.repeat(40) } } };
      }),
      deleteRef: vi.fn(async () => {
        if (fail.has('deleteRef')) throw statusError(503);
        if (!refExists) throw statusError(404);
        refExists = false;
        return { data: {} };
      }),
    },
    issues: {
      listComments: vi.fn(
        async ({ page = 1, per_page = 100 }: { page?: number; per_page?: number }) => {
          if (fail.has('listComments')) throw statusError(503);
          const newestFirst = [...comments].reverse();
          const start = (page - 1) * per_page;
          return { data: newestFirst.slice(start, start + per_page) };
        },
      ),
      createComment: vi.fn(async ({ body }: { body: string }) => {
        if (fail.has('createComment')) throw statusError(503);
        const comment = { id: nextCommentId++, body };
        comments.push(comment);
        return { data: comment };
      }),
      getComment: vi.fn(async ({ comment_id }: { comment_id: number }) => {
        if (fail.has('getComment')) throw statusError(503);
        const comment = comments.find((candidate) => candidate.id === comment_id);
        if (!comment) throw statusError(404);
        return { data: comment };
      }),
      removeLabel: vi.fn(async ({ name }: { name: string }) => {
        if (fail.has(`removeLabel:${name}`)) throw statusError(503);
        if (!labels.has(name)) throw statusError(404);
        labels.delete(name);
        return { data: {} };
      }),
      addLabels: vi.fn(async ({ labels: added }: { labels: string[] }) => {
        if (fail.has('addLabels')) throw statusError(503);
        for (const label of added) labels.add(label);
        return { data: {} };
      }),
      get: vi.fn(async () => {
        if (fail.has('getIssue')) throw statusError(503);
        return { data: { labels: [...labels].map((name) => ({ name })) } };
      }),
    },
    pulls: {
      get: vi.fn(async () => {
        if (fail.has('getPull')) throw statusError(503);
        return {
          data: {
            merged: options.prMerged ?? true,
            merged_at: options.prMergedAt ?? '2026-07-14T00:45:00Z',
          },
        };
      }),
    },
  };
  const client = {
    owner: 'acme',
    repo: 'project',
    octokit,
    authMode: 'github_app_installation',
    isDryRun: false,
  } as unknown as GitHubClient;
  const dependencies: ClaimLifecycleDependencies = {
    getClient: vi.fn(async () => client),
    now: () => new Date('2026-07-14T00:30:00.000Z'),
  };
  return { client, comments, dependencies, fail, labels, octokit, refExists: () => refExists };
}

const reviewInput = {
  issueNumber: 42,
  agentId: 'agent-one',
  prUrl: 'https://github.com/acme/project/pull/7',
};

const renewedClaim = {
  claim_id: '12345678-1234-4000-8000-123456789abc',
  claimed_at: '2026-07-14T00:40:00.000Z',
  expires_at: '2026-07-14T01:40:00.000Z',
  task_snapshot_sha256: 'a'.repeat(64),
  task_id: 'TASK-42',
  task_updated_at: '2026-07-14T00:39:00.000Z',
  risk_zone: 'yellow',
  ttl_minutes: 60,
  heartbeat_minutes: 15,
  next_heartbeat_at: '2026-07-14T00:55:00.000Z',
} as const;

const taskLink = `<!-- openslack-task-link
${JSON.stringify({
  schema: 'openslack.task_link.v1',
  issue_number: 42,
  agent_id: 'agent-one',
  task_id: 'TASK-42',
  run_id: 'RUN-42',
  claim_ref: 'refs/heads/openslack/claims/issue-42',
})}
-->`;

describe('checkTaskClaimReview', () => {
  it('leaves ordinary PRs alone and blocks malformed task links without API reads', async () => {
    const { dependencies } = createHarness();
    await expect(
      checkTaskClaimReview(7, 'Document the `openslack-task-link` marker.', {}, dependencies),
    ).resolves.toBeUndefined();
    await expect(
      checkTaskClaimReview(7, `${taskLink}\n${taskLink}`, {}, dependencies),
    ).resolves.toMatchObject({ reason: expect.stringContaining('CLAIM_TASK_LINK_INVALID') });
    await expect(
      checkTaskClaimReview(7, taskLink.slice(0, -3), {}, dependencies),
    ).resolves.toMatchObject({ reason: expect.stringContaining('CLAIM_TASK_LINK_INVALID') });
    expect(dependencies.getClient).not.toHaveBeenCalled();
  });

  it('accepts exact review evidence and refuses a record for another PR', async () => {
    const { dependencies, octokit, labels } = createHarness();
    await expect(reviewClaim(reviewInput, dependencies)).resolves.toMatchObject({
      outcome: 'completed',
    });
    octokit.issues.createComment.mockClear();
    await expect(
      checkTaskClaimReview(7, `Uses openslack-task-link.\n\n${taskLink}`, {}, dependencies),
    ).resolves.toBeUndefined();
    const date = vi.spyOn(Date, 'now').mockReturnValue(dependencies.now().getTime());
    try {
      await expect(repairExpiredClaims({}, dependencies.getClient)).resolves.toEqual([
        expect.objectContaining({ action: 'repairClaimProjection', fixed: true }),
      ]);
    } finally {
      date.mockRestore();
    }
    expect(labels.has('openslack:claimed')).toBe(true);
    await expect(checkTaskClaimReview(7, taskLink, {}, dependencies)).resolves.toBeUndefined();
    await expect(checkTaskClaimReview(8, taskLink, {}, dependencies)).resolves.toMatchObject({
      reason: expect.stringContaining('CLAIM_REVIEW_EVIDENCE_REQUIRED'),
      recommendation: expect.stringContaining('--pr-url https://github.com/acme/project/pull/8'),
    });
    expect(octokit.issues.createComment).not.toHaveBeenCalled();
  });

  it('blocks a still-present expired lease and accepts a current heartbeat', async () => {
    const { dependencies } = createHarness();
    await expect(reviewClaim(reviewInput, dependencies)).resolves.toMatchObject({
      outcome: 'completed',
    });
    dependencies.now = () => new Date('2026-07-14T01:00:00Z');
    await expect(checkTaskClaimReview(7, taskLink, {}, dependencies)).resolves.toMatchObject({
      reason: expect.stringContaining('CLAIM_LEASE_NOT_CURRENT'),
    });
    await expect(heartbeatClaim(reviewInput, dependencies)).resolves.toMatchObject({
      outcome: 'completed',
    });
    await expect(checkTaskClaimReview(7, taskLink, {}, dependencies)).resolves.toBeUndefined();
  });

  it('requires a completed review projection even when the matching record exists', async () => {
    const harness = createHarness({ labels: ['openslack:ready'] });
    harness.fail.add('removeLabel:openslack:ready');
    await expect(reviewClaim(reviewInput, harness.dependencies)).resolves.toMatchObject({
      outcome: 'partial',
    });
    expect(harness.comments.some((comment) => parseClaimReviewMetadata(comment.body))).toBe(true);
    await expect(
      checkTaskClaimReview(7, taskLink, {}, harness.dependencies),
    ).resolves.toMatchObject({
      reason: expect.stringContaining('CLAIM_REVIEW_TRANSITION_FAILED'),
    });
    harness.fail.delete('removeLabel:openslack:ready');
    await expect(reviewClaim(reviewInput, harness.dependencies)).resolves.toMatchObject({
      outcome: 'completed',
    });
    await expect(
      checkTaskClaimReview(7, taskLink, {}, harness.dependencies),
    ).resolves.toBeUndefined();
  });

  it('rejects the prior review after same-agent reacquisition and records the new claim ID', async () => {
    const harness = createHarness();
    await expect(reviewClaim(reviewInput, harness.dependencies)).resolves.toMatchObject({
      outcome: 'completed',
    });
    harness.comments.push({ id: 8, body: claimComment('agent-one', renewedClaim) });
    harness.dependencies.now = () => new Date('2026-07-14T00:50:00Z');
    await expect(
      checkTaskClaimReview(7, taskLink, {}, harness.dependencies),
    ).resolves.toMatchObject({
      reason: expect.stringContaining('CLAIM_REVIEW_EVIDENCE_REQUIRED'),
    });
    await expect(completeClaim(reviewInput, harness.dependencies)).resolves.toMatchObject({
      errorCode: 'CLAIM_POSTCONDITION_FAILED',
    });
    expect(harness.octokit.git.deleteRef).not.toHaveBeenCalled();
    await expect(reviewClaim(reviewInput, harness.dependencies)).resolves.toMatchObject({
      outcome: 'completed',
    });
    expect(parseClaimReviewMetadata(harness.comments.at(-1)?.body)).toMatchObject({
      claim_id: renewedClaim.claim_id,
    });
    await expect(
      checkTaskClaimReview(7, taskLink.replace('TASK-42', 'TASK-41'), {}, harness.dependencies),
    ).resolves.toMatchObject({ reason: expect.stringContaining('CLAIM_TASK_LINK_MISMATCH') });
    await expect(
      checkTaskClaimReview(7, taskLink, {}, harness.dependencies),
    ).resolves.toBeUndefined();
  });

  it('rejects different claim IDs sharing the same agent and instant', async () => {
    const harness = createHarness();
    harness.comments.push(
      { id: 8, body: claimComment('agent-one', renewedClaim) },
      {
        id: 9,
        body: claimComment('agent-one', {
          ...renewedClaim,
          claimed_at: '2026-07-14T08:40:00+08:00',
          claim_id: '12345678-1234-4000-8000-123456789abd',
        }),
      },
    );
    await expect(
      checkTaskClaimReview(7, taskLink, {}, harness.dependencies),
    ).resolves.toMatchObject({
      reason: expect.stringContaining('CLAIM_OWNER_MISMATCH'),
    });
  });

  it.each([
    [{ owner: 'another-agent' }, 'CLAIM_OWNER_MISMATCH'],
    [{ refExists: false }, 'CLAIM_REF_NOT_FOUND'],
    [{ fail: new Set(['listComments']) }, 'CLAIM_API_UNAVAILABLE'],
  ] as const)(
    'blocks when claim evidence is invalid or unreadable (%j)',
    async (options, reason) => {
      const { dependencies } = createHarness(options);
      await expect(checkTaskClaimReview(7, taskLink, {}, dependencies)).resolves.toMatchObject({
        reason: expect.stringContaining(reason),
      });
    },
  );
});

const invalidInputHandlers = {
  heartbeat: heartbeatClaim,
  review: reviewClaim,
  complete: completeClaim,
};

describe('strict claim lifecycle', () => {
  it.each<[keyof typeof invalidInputHandlers, number]>([
    ['heartbeat', 0],
    ['heartbeat', -1],
    ['heartbeat', 1.5],
    ['review', 0],
    ['review', -1],
    ['review', 1.5],
    ['complete', 0],
    ['complete', -1],
    ['complete', 1.5],
  ])(
    'returns a structured refusal for %s issue %s before client access',
    async (operation, issueNumber) => {
      const getClient = vi.fn(async () => {
        throw new Error('CLIENT_FORBIDDEN');
      });
      const result = await invalidInputHandlers[operation](
        { ...reviewInput, issueNumber },
        { getClient, now: () => new Date('2026-07-14T00:30:00.000Z') },
      );
      expect(result).toMatchObject({
        operation,
        outcome: 'failed',
        errorCode: 'CLAIM_INVALID_INPUT',
        claimRef: '',
      });
      expect(getClient).not.toHaveBeenCalled();
    },
  );

  it('records and verifies a bounded heartbeat', async () => {
    const harness = createHarness();
    const result = await heartbeatClaim(
      { issueNumber: 42, agentId: 'agent-one', ttlMinutes: 60 },
      harness.dependencies,
    );

    expect(result).toMatchObject({
      schema: 'openslack.claim_lifecycle.v1',
      operation: 'heartbeat',
      outcome: 'completed',
      owner: 'agent-one',
      expiresAt: '2026-07-14T01:30:00.000Z',
      ttlMinutes: 60,
      heartbeatMinutes: 15,
      nextHeartbeatAt: '2026-07-14T00:45:00.000Z',
    });
    expect(parseHeartbeatMetadata(harness.comments.at(-1)?.body)).toMatchObject({
      agent_id: 'agent-one',
      claim_ref: 'refs/heads/openslack/claims/issue-42',
      ttl_minutes: 60,
      heartbeat_minutes: 15,
      next_heartbeat_at: '2026-07-14T00:45:00.000Z',
    });
  });

  it('inherits the original claim TTL when the heartbeat omits an override', async () => {
    const harness = createHarness();
    const result = await heartbeatClaim(
      { issueNumber: 42, agentId: 'agent-one' },
      harness.dependencies,
    );

    expect(result).toMatchObject({
      outcome: 'completed',
      ttlMinutes: 60,
      heartbeatMinutes: 15,
      expiresAt: '2026-07-14T01:30:00.000Z',
      nextHeartbeatAt: '2026-07-14T00:45:00.000Z',
    });
  });

  it.each([0, 481, 1.5])(
    'rejects invalid heartbeat TTL %s before GitHub access',
    async (ttlMinutes) => {
      const harness = createHarness();
      const result = await heartbeatClaim(
        { issueNumber: 42, agentId: 'agent-one', ttlMinutes },
        harness.dependencies,
      );
      expect(result).toMatchObject({ outcome: 'failed', errorCode: 'CLAIM_INVALID_INPUT' });
      expect(harness.dependencies.getClient).not.toHaveBeenCalled();
    },
  );

  it('refuses dry-run clients instead of reporting a simulated lifecycle success', async () => {
    const harness = createHarness();
    (harness.client as unknown as { isDryRun: boolean }).isDryRun = true;

    await expect(
      heartbeatClaim({ issueNumber: 42, agentId: 'agent-one' }, harness.dependencies),
    ).resolves.toMatchObject({
      outcome: 'failed',
      errorCode: 'CLAIM_API_UNAVAILABLE',
    });
    expect(harness.octokit.issues.createComment).not.toHaveBeenCalled();
  });

  it('fails closed when structured ownership is absent or mismatched', async () => {
    const missing = createHarness();
    missing.comments.splice(0);
    await expect(
      heartbeatClaim({ issueNumber: 42, agentId: 'agent-one' }, missing.dependencies),
    ).resolves.toMatchObject({ outcome: 'failed', errorCode: 'CLAIM_OWNER_MISSING' });

    const mismatch = createHarness({ owner: 'agent-two' });
    await expect(
      heartbeatClaim({ issueNumber: 42, agentId: 'agent-one' }, mismatch.dependencies),
    ).resolves.toMatchObject({
      outcome: 'failed',
      errorCode: 'CLAIM_OWNER_MISMATCH',
      owner: 'agent-two',
    });
  });

  it('rejects conflicting structured owners', async () => {
    const harness = createHarness();
    harness.comments.push({ id: 2, body: claimComment('agent-two') });
    await expect(
      heartbeatClaim({ issueNumber: 42, agentId: 'agent-one' }, harness.dependencies),
    ).resolves.toMatchObject({ outcome: 'failed', errorCode: 'CLAIM_OWNER_MISMATCH' });
  });

  it('uses the newest claim marker without letting historical ownership block renewal', async () => {
    const harness = createHarness({ owner: 'agent-one' });
    const oldClaim = claimComment('agent-two').replace(
      '2026-07-14T00:00:00.000Z',
      '2026-07-13T00:00:00.000Z',
    );
    harness.comments.unshift({ id: 0, body: oldClaim });

    await expect(
      heartbeatClaim({ issueNumber: 42, agentId: 'agent-one' }, harness.dependencies),
    ).resolves.toMatchObject({ outcome: 'completed', owner: 'agent-one' });
  });

  it('returns a retryable partial result when heartbeat persistence cannot be verified', async () => {
    const harness = createHarness({ fail: new Set(['getComment']) });
    const result = await heartbeatClaim(
      { issueNumber: 42, agentId: 'agent-one', ttlMinutes: 45 },
      harness.dependencies,
    );
    expect(result).toMatchObject({
      outcome: 'partial',
      errorCode: 'CLAIM_POSTCONDITION_FAILED',
      recoveryCommand:
        'openslack github claim heartbeat --issue-number 42 --agent-id agent-one --ttl-minutes 45',
    });
  });

  it('deduplicates an immediate heartbeat retry after the comment was already written', async () => {
    const harness = createHarness({ fail: new Set(['getComment']) });
    const input = { issueNumber: 42, agentId: 'agent-one', ttlMinutes: 45 };
    expect(await heartbeatClaim(input, harness.dependencies)).toMatchObject({
      outcome: 'partial',
      errorCode: 'CLAIM_POSTCONDITION_FAILED',
    });

    harness.fail.delete('getComment');
    expect(await heartbeatClaim(input, harness.dependencies)).toMatchObject({
      outcome: 'completed',
      expiresAt: '2026-07-14T01:15:00.000Z',
    });
    expect(harness.octokit.issues.createComment).toHaveBeenCalledTimes(1);
  });

  it('records a new heartbeat after the retry-deduplication window', async () => {
    const harness = createHarness();
    const input = { issueNumber: 42, agentId: 'agent-one', ttlMinutes: 45 };
    expect(await heartbeatClaim(input, harness.dependencies)).toMatchObject({
      outcome: 'completed',
      expiresAt: '2026-07-14T01:15:00.000Z',
    });

    harness.dependencies.now = () => new Date('2026-07-14T00:31:01.000Z');
    expect(await heartbeatClaim(input, harness.dependencies)).toMatchObject({
      outcome: 'completed',
      expiresAt: '2026-07-14T01:16:01.000Z',
    });
    expect(harness.octokit.issues.createComment).toHaveBeenCalledTimes(2);
  });

  it('uses the original claim marker instead of allowing a heartbeat to override ownership', async () => {
    const harness = createHarness();
    harness.comments.push({
      id: 100,
      body: `<!-- openslack-heartbeat\n${JSON.stringify({
        schema: 'openslack.heartbeat.v1',
        issue_number: 42,
        agent_id: 'agent-two',
        heartbeat_at: '2026-07-14T00:29:30.000Z',
        expires_at: '2026-07-14T01:29:30.000Z',
        claim_ref: 'refs/heads/openslack/claims/issue-42',
      })}\n-->`,
    });

    await expect(
      heartbeatClaim(
        { issueNumber: 42, agentId: 'agent-one', ttlMinutes: 60 },
        harness.dependencies,
      ),
    ).resolves.toMatchObject({ outcome: 'completed', owner: 'agent-one' });
  });

  it('paginates bounded comment history to find the authoritative claim marker', async () => {
    const harness = createHarness();
    for (let index = 0; index < 110; index += 1) {
      harness.comments.push({ id: index + 100, body: `ordinary comment ${index}` });
    }

    await expect(
      heartbeatClaim(
        { issueNumber: 42, agentId: 'agent-one', ttlMinutes: 60 },
        harness.dependencies,
      ),
    ).resolves.toMatchObject({ outcome: 'completed', owner: 'agent-one' });
    expect(harness.octokit.issues.listComments).toHaveBeenCalledTimes(2);
  });

  it('fails closed when ownership evidence exceeds the bounded comment history', async () => {
    const harness = createHarness();
    for (let index = 0; index < 1_000; index += 1) {
      harness.comments.push({ id: index + 100, body: `ordinary comment ${index}` });
    }

    await expect(
      heartbeatClaim(
        { issueNumber: 42, agentId: 'agent-one', ttlMinutes: 60 },
        harness.dependencies,
      ),
    ).resolves.toMatchObject({ outcome: 'failed', errorCode: 'CLAIM_API_UNAVAILABLE' });
    expect(harness.octokit.issues.createComment).not.toHaveBeenCalled();
    expect(harness.octokit.issues.listComments).toHaveBeenCalledTimes(10);
  });

  it('moves a claim to review and verifies both label and exact PR evidence', async () => {
    const harness = createHarness();
    const result = await reviewClaim(reviewInput, harness.dependencies);
    expect(result).toMatchObject({ outcome: 'completed', operation: 'review' });
    expect(harness.labels.has('openslack:review')).toBe(true);
    expect(parseClaimReviewMetadata(harness.comments.at(-1)?.body)).toMatchObject({
      pr_url: reviewInput.prUrl,
      agent_id: 'agent-one',
    });
  });

  it('rejects stale refs and PR URLs outside the selected repository', async () => {
    const missingRef = createHarness({ refExists: false });
    await expect(reviewClaim(reviewInput, missingRef.dependencies)).resolves.toMatchObject({
      outcome: 'failed',
      errorCode: 'CLAIM_REF_NOT_FOUND',
    });

    const wrongRepo = createHarness();
    await expect(
      reviewClaim(
        { ...reviewInput, prUrl: 'https://github.com/other/project/pull/7' },
        wrongRepo.dependencies,
      ),
    ).resolves.toMatchObject({ outcome: 'failed', errorCode: 'CLAIM_INVALID_INPUT' });
  });

  it('returns partial state when a review mutation fails', async () => {
    const harness = createHarness({ fail: new Set(['createComment']) });
    const result = await reviewClaim(reviewInput, harness.dependencies);
    expect(result).toMatchObject({
      outcome: 'partial',
      errorCode: 'CLAIM_REVIEW_TRANSITION_FAILED',
      recoveryCommand:
        'openslack github claim review --issue-number 42 --agent-id agent-one --pr-url https://github.com/acme/project/pull/7',
    });
  });

  it('returns recoverable partial state when review postconditions cannot be re-read', async () => {
    const harness = createHarness({ fail: new Set(['getIssue']) });
    const result = await reviewClaim(reviewInput, harness.dependencies);
    expect(result).toMatchObject({
      outcome: 'partial',
      errorCode: 'CLAIM_PARTIAL_STATE',
      recoveryCommand:
        'openslack github claim review --issue-number 42 --agent-id agent-one --pr-url https://github.com/acme/project/pull/7',
    });
  });

  it('does not duplicate exact PR evidence when a partial review transition is retried', async () => {
    const harness = createHarness({ fail: new Set(['getIssue']) });
    expect(await reviewClaim(reviewInput, harness.dependencies)).toMatchObject({
      outcome: 'partial',
      errorCode: 'CLAIM_PARTIAL_STATE',
    });

    harness.fail.delete('getIssue');
    expect(await reviewClaim(reviewInput, harness.dependencies)).toMatchObject({
      outcome: 'completed',
    });
    expect(harness.octokit.issues.createComment).toHaveBeenCalledTimes(1);
    expect(
      harness.comments.filter((comment) => parseClaimReviewMetadata(comment.body) !== null),
    ).toHaveLength(1);
  });

  it('completes only after review evidence and verifies ref deletion plus done label', async () => {
    const harness = createHarness();
    expect((await reviewClaim(reviewInput, harness.dependencies)).outcome).toBe('completed');

    const result = await completeClaim(reviewInput, harness.dependencies);
    expect(result).toMatchObject({ outcome: 'completed', operation: 'complete' });
    expect(harness.refExists()).toBe(false);
    expect(harness.labels.has('openslack:done')).toBe(true);

    harness.octokit.git.deleteRef.mockClear();
    harness.octokit.issues.addLabels.mockClear();
    harness.octokit.issues.removeLabel.mockClear();
    const repeated = await completeClaim(reviewInput, harness.dependencies);
    expect(repeated).toMatchObject({ outcome: 'completed', operation: 'complete' });
    expect(harness.octokit.git.deleteRef).not.toHaveBeenCalled();
    expect(harness.octokit.issues.addLabels).not.toHaveBeenCalled();
    expect(harness.octokit.issues.removeLabel).not.toHaveBeenCalled();
  });

  it('fails before mutation when exact review evidence is missing', async () => {
    const harness = createHarness();
    const result = await completeClaim(reviewInput, harness.dependencies);
    expect(result).toMatchObject({
      outcome: 'failed',
      errorCode: 'CLAIM_POSTCONDITION_FAILED',
    });
    expect(harness.octokit.git.deleteRef).not.toHaveBeenCalled();
  });

  it('refuses completion before the linked PR is merged', async () => {
    const harness = createHarness({ prMerged: false });
    expect((await reviewClaim(reviewInput, harness.dependencies)).outcome).toBe('completed');
    const result = await completeClaim(reviewInput, harness.dependencies);
    expect(result).toMatchObject({
      outcome: 'failed',
      errorCode: 'CLAIM_POSTCONDITION_FAILED',
      postconditions: expect.arrayContaining([{ name: 'pr_merged', satisfied: false }]),
    });
    expect(harness.octokit.git.deleteRef).not.toHaveBeenCalled();
  });

  it('refuses an older merged PR even after review is recorded against a new claim', async () => {
    const harness = createHarness({ prMergedAt: '2026-07-14T00:35:00Z' });
    harness.comments.push({ id: 8, body: claimComment('agent-one', renewedClaim) });
    harness.dependencies.now = () => new Date('2026-07-14T00:50:00Z');
    await expect(reviewClaim(reviewInput, harness.dependencies)).resolves.toMatchObject({
      outcome: 'completed',
    });
    harness.octokit.issues.addLabels.mockClear();
    await expect(completeClaim(reviewInput, harness.dependencies)).resolves.toMatchObject({
      outcome: 'failed',
      errorCode: 'CLAIM_POSTCONDITION_FAILED',
    });
    expect(harness.octokit.issues.addLabels).not.toHaveBeenCalled();
    expect(harness.octokit.git.deleteRef).not.toHaveBeenCalled();
  });

  it('reconciles done with contradictory ready or blocked projections without ref writes', async () => {
    const harness = createHarness();
    await expect(reviewClaim(reviewInput, harness.dependencies)).resolves.toMatchObject({
      outcome: 'completed',
    });
    await expect(completeClaim(reviewInput, harness.dependencies)).resolves.toMatchObject({
      outcome: 'completed',
    });
    harness.labels.add('openslack:ready');
    harness.labels.add('openslack:blocked');
    await expect(completeClaim(reviewInput, harness.dependencies)).resolves.toMatchObject({
      outcome: 'completed',
    });
    expect([...harness.labels]).toEqual(['openslack:done']);
    expect(harness.octokit.git.deleteRef).toHaveBeenCalledOnce();
  });

  it('preserves a newly observed claim when completion reads the task projection', async () => {
    const harness = createHarness();
    await expect(reviewClaim(reviewInput, harness.dependencies)).resolves.toMatchObject({
      outcome: 'completed',
    });
    harness.octokit.issues.removeLabel.mockClear();
    harness.octokit.issues.addLabels.mockClear();
    harness.octokit.issues.get.mockImplementationOnce(async () => {
      harness.comments.push({ id: 8, body: claimComment('agent-one', renewedClaim) });
      return { data: { labels: [{ name: 'openslack:running' }] } };
    });
    await expect(completeClaim(reviewInput, harness.dependencies)).resolves.toMatchObject({
      outcome: 'partial',
      errorCode: 'CLAIM_PARTIAL_STATE',
    });
    expect(harness.octokit.issues.removeLabel).not.toHaveBeenCalled();
    expect(harness.octokit.issues.addLabels).not.toHaveBeenCalled();
    expect(harness.octokit.git.deleteRef).not.toHaveBeenCalled();
  });

  it('returns recoverable partial state when ref deletion fails', async () => {
    const harness = createHarness();
    expect((await reviewClaim(reviewInput, harness.dependencies)).outcome).toBe('completed');
    harness.fail.add('deleteRef');
    const result = await completeClaim(reviewInput, harness.dependencies);
    expect(result).toMatchObject({
      outcome: 'partial',
      errorCode: 'CLAIM_COMPLETION_FAILED',
      recoveryCommand:
        'openslack github claim complete --issue-number 42 --agent-id agent-one --pr-url https://github.com/acme/project/pull/7',
    });
  });

  it('returns recoverable partial state when completion postconditions cannot be re-read', async () => {
    const harness = createHarness();
    expect((await reviewClaim(reviewInput, harness.dependencies)).outcome).toBe('completed');
    harness.fail.add('getIssue');
    const result = await completeClaim(reviewInput, harness.dependencies);
    expect(result).toMatchObject({
      outcome: 'partial',
      errorCode: 'CLAIM_PARTIAL_STATE',
      recoveryCommand:
        'openslack github claim complete --issue-number 42 --agent-id agent-one --pr-url https://github.com/acme/project/pull/7',
    });
  });

  it('never returns raw transport errors or canaries', async () => {
    const harness = createHarness({ fail: new Set(['listComments']) });
    const result = await heartbeatClaim(
      { issueNumber: 42, agentId: 'agent-one' },
      harness.dependencies,
    );
    expect(result).toMatchObject({ outcome: 'failed', errorCode: 'CLAIM_API_UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toContain('provider-secret-canary');
  });
});

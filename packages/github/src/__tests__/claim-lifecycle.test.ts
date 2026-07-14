import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient } from '../client.js';
import {
  completeClaim,
  heartbeatClaim,
  parseClaimReviewMetadata,
  parseHeartbeatMetadata,
  reviewClaim,
  type ClaimLifecycleDependencies,
} from '../claim-lifecycle.js';
import { renderClaimComment, type ClaimMetadata } from '../claims.js';

interface HarnessOptions {
  owner?: string;
  refExists?: boolean;
  labels?: string[];
  fail?: Set<string>;
  prMerged?: boolean;
}

function statusError(
  status: number,
  message = 'provider-secret-canary',
): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function claimComment(agentId = 'agent-one'): string {
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
      listComments: vi.fn(async () => {
        if (fail.has('listComments')) throw statusError(503);
        return { data: [...comments].reverse() };
      }),
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
        return { data: { merged: options.prMerged ?? true } };
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

describe('strict claim lifecycle', () => {
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
    });
    expect(parseHeartbeatMetadata(harness.comments.at(-1)?.body)).toMatchObject({
      agent_id: 'agent-one',
      claim_ref: 'refs/heads/openslack/claims/issue-42',
    });
  });

  it.each([0, 121, 1.5])(
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

  it('completes only after review evidence and verifies ref deletion plus done label', async () => {
    const harness = createHarness();
    expect((await reviewClaim(reviewInput, harness.dependencies)).outcome).toBe('completed');

    const result = await completeClaim(reviewInput, harness.dependencies);
    expect(result).toMatchObject({ outcome: 'completed', operation: 'complete' });
    expect(harness.refExists()).toBe(false);
    expect(harness.labels.has('openslack:done')).toBe(true);

    const repeated = await completeClaim(reviewInput, harness.dependencies);
    expect(repeated).toMatchObject({ outcome: 'completed', operation: 'complete' });
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

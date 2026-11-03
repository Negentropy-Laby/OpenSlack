import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PRReviewReport } from '../types.js';
import { createWorkflowEvidence } from '../workflow-gate.js';

const ports = vi.hoisted(() => ({
  preview: vi.fn(),
  fetch: vi.fn(),
  codeowners: vi.fn(),
  finalize: vi.fn(),
}));
vi.mock('@openslack/github', () => ({
  previewWorkflowFinalization: (...args: unknown[]) => ports.preview(...args),
  finalizeWorkflowPR: (...args: unknown[]) => ports.finalize(...args),
}));
vi.mock('../fetch.js', () => ({ fetchPRDetails: (...args: unknown[]) => ports.fetch(...args) }));
vi.mock('../codeowners.js', () => ({
  loadPRCodeownerEvidence: (...args: unknown[]) => ports.codeowners(...args),
}));
import { finalizeWorkflowLifecycle } from '../workflow-finalization.js';

function report(): PRReviewReport {
  const artifact = 'templates/workflows/new.yaml';
  const evidence = createWorkflowEvidence({
    baseSha: 'base-sha',
    headSha: 'head-sha',
    baseTree: [],
    headTree: [{ path: artifact, type: 'blob', mode: '100644', sha: 'blob-new' }],
  });
  return {
    prNumber: 185,
    title: 'Workflow update',
    author: 'openslack-agent-operator[bot]',
    state: 'closed',
    merged: true,
    draft: false,
    baseRef: 'main',
    baseSha: 'base-sha',
    headSha: 'head-sha',
    riskZone: 'yellow',
    changedFiles: [artifact],
    checks: [],
    humanApprovals: [{ user: 'reviewer' }],
    reviews: [
      {
        user: 'reviewer',
        state: 'APPROVED',
        commitOid: 'head-sha',
        body: 'Workflow-Trust: trusted',
      },
    ],
    mergeable: true,
    decision: 'MERGED',
    reason: 'Merged',
    recommendation: 'Finalize',
    workflowEvidence: evidence,
    body: 'Workflow governance #186',
    workflowGovernanceIssue: {
      issueNumber: 186,
      prNumber: 185,
      author: 'openslack-agent-operator[bot]',
      body: [
        '```openslack-workflow-governance',
        'schema: "openslack.workflow_governance.v1"',
        'pr: 185',
        'base_sha: "base-sha"',
        'head_sha: "head-sha"',
        `evidence_hash: ${JSON.stringify(evidence.evidenceHash)}`,
        'artifact_files:',
        `  - ${JSON.stringify(artifact)}`,
        '```',
      ].join('\n'),
    },
  };
}

describe('package-owned workflow finalization', () => {
  let current: PRReviewReport;
  beforeEach(() => {
    vi.resetAllMocks();
    current = report();
    ports.fetch.mockImplementation(async () => current);
    ports.codeowners.mockResolvedValue({ ref: 'base-sha', owners: ['@reviewer'], entries: [] });
    ports.finalize.mockResolvedValue({
      closedIssues: [186],
      commentedIssues: [186],
      updatedLabels: [186],
      errors: [],
      failures: [],
    });
  });

  it('preserves credential-free preview with no PR query or write entrypoint', async () => {
    ports.preview.mockResolvedValue({ dryRun: true, errors: [] });
    expect(
      await finalizeWorkflowLifecycle({ prNumber: 185, mode: 'governance-only' }),
    ).toMatchObject({ status: 'preview' });
    expect(ports.fetch).not.toHaveBeenCalled();
    expect(ports.codeowners).not.toHaveBeenCalled();
    expect(ports.finalize).not.toHaveBeenCalled();
  });

  it.each(['governance-only', 'explicit-targets'] as const)(
    'verifies real governance for %s and shares one strict live options identity',
    async (mode) => {
      const signal = new AbortController().signal;
      const outcome = await finalizeWorkflowLifecycle(
        { prNumber: 185, mode },
        { owner: 'org', repo: 'repo', signal, requireLive: false, strictEvidence: false },
      );
      expect(outcome.status).toBe('finalized');
      const options = ports.fetch.mock.calls[0]![1];
      expect(options).toEqual({
        owner: 'org',
        repo: 'repo',
        signal,
        requireLive: true,
        strictEvidence: true,
      });
      expect(ports.codeowners.mock.calls[0]![1]).toBe(options);
      expect(ports.finalize.mock.calls[0]![2]).toBe(options);
      expect(ports.finalize).toHaveBeenCalledExactlyOnceWith(
        185,
        expect.objectContaining({
          governanceIssue: 186,
          workflowHash: current.workflowEvidence!.evidenceHash,
          trustDecision: 'trusted',
          trustReviewer: 'reviewer',
          trustReviewCommitOid: 'head-sha',
          expectedHeadSha: 'head-sha',
          expectedBaseSha: 'base-sha',
        }),
        options,
      );
    },
  );

  it.each([
    { hash: 'sha256:invented' },
    { hash: '' },
    { trust: 'core' },
    { trust: '' },
    { governanceIssue: 186 },
  ])('refuses unsupported evidence claims without artifacts: %j', async (claim) => {
    current.workflowEvidence = undefined;
    current.workflowGovernanceIssue = undefined;
    current.changedFiles = ['docs/example.md'];
    expect(
      await finalizeWorkflowLifecycle({
        prNumber: 185,
        mode: 'explicit-targets',
        reviewIssue: 999,
        ...claim,
      }),
    ).toMatchObject({ status: 'refused' });
    expect(ports.codeowners).not.toHaveBeenCalled();
    expect(ports.finalize).not.toHaveBeenCalled();
  });

  it('retains ordinary CLI lifecycle targets without inventing evidence', async () => {
    current.workflowEvidence = undefined;
    current.changedFiles = ['docs/example.md'];
    expect(
      await finalizeWorkflowLifecycle({
        prNumber: 185,
        mode: 'explicit-targets',
        proposalIssue: 2,
        reviewIssue: 3,
        phaseIssues: [4],
      }),
    ).toMatchObject({ status: 'finalized' });
    expect(ports.finalize).toHaveBeenCalledWith(
      185,
      {
        proposalIssue: 2,
        reviewIssue: 3,
        phaseIssues: [4],
        expectedHeadSha: 'head-sha',
        expectedBaseSha: 'base-sha',
      },
      expect.any(Object),
    );
  });

  it('does not treat missing artifact evidence as an ordinary explicit-target request', async () => {
    current.workflowEvidence = undefined;
    expect(
      await finalizeWorkflowLifecycle({
        prNumber: 185,
        mode: 'explicit-targets',
        reviewIssue: 999,
      }),
    ).toMatchObject({ status: 'refused' });
    expect(ports.finalize).not.toHaveBeenCalled();
  });

  it('owns explicit targets across the initial asynchronous preview', async () => {
    current.workflowEvidence = undefined;
    current.changedFiles = ['docs/example.md'];
    const input = {
      prNumber: 185,
      mode: 'explicit-targets' as const,
      reviewIssue: 2,
      phaseIssues: [3],
    };
    ports.preview.mockImplementation(async () => {
      input.reviewIssue = 999;
      input.phaseIssues.push(999);
      return undefined;
    });
    await finalizeWorkflowLifecycle(input);
    expect(ports.finalize).toHaveBeenCalledWith(
      185,
      expect.objectContaining({ reviewIssue: 2, phaseIssues: [3] }),
      expect.any(Object),
    );
  });

  it('does not infer a TUI governance target when repository evidence is missing', async () => {
    current.workflowEvidence = undefined;
    expect(
      await finalizeWorkflowLifecycle({ prNumber: 185, mode: 'governance-only' }),
    ).toMatchObject({ status: 'refused' });
    expect(ports.finalize).not.toHaveBeenCalled();
  });

  it.each(['headSha', 'baseSha'] as const)(
    'refuses a missing reviewed %s before finalization',
    async (field) => {
      current[field] = undefined;
      expect(
        await finalizeWorkflowLifecycle({
          prNumber: 185,
          mode: 'explicit-targets',
          proposalIssue: 888,
        }),
      ).toMatchObject({ status: 'refused' });
      expect(ports.finalize).not.toHaveBeenCalled();
    },
  );

  it('keeps governance N/A zero-write even when a body reference exists', async () => {
    current.workflowEvidence = createWorkflowEvidence({
      baseSha: 'base-sha',
      headSha: 'head-sha',
      baseTree: [{ path: current.changedFiles[0]!, type: 'blob', mode: '100644', sha: 'old' }],
      headTree: [{ path: current.changedFiles[0]!, type: 'blob', mode: '100644', sha: 'new' }],
    });
    expect(await finalizeWorkflowLifecycle({ prNumber: 185, mode: 'governance-only' })).toEqual({
      status: 'not-required',
    });
    expect(ports.finalize).not.toHaveBeenCalled();
  });

  it.each([
    { hash: 'sha256:wrong' },
    { trust: 'core' },
    { trust: 'nonsense' },
    { governanceIssue: 999 },
  ])('rejects overrides before effects: %j', async (override) => {
    expect(
      await finalizeWorkflowLifecycle({ prNumber: 185, mode: 'explicit-targets', ...override }),
    ).toMatchObject({ status: 'refused', message: expect.stringContaining('Cannot override') });
    expect(ports.finalize).not.toHaveBeenCalled();
  });

  it.each([
    'report-pr',
    'head',
    'base',
    'author',
    'issue-pr',
    'issue-number',
    'missing-issue',
    'hash',
    'artifacts',
    'trust',
  ] as const)('rejects drifting %s through the actual gate', async (field) => {
    if (field === 'report-pr') current.prNumber = 186;
    if (field === 'head') current.headSha = 'stale';
    if (field === 'base') current.baseSha = 'stale';
    if (field === 'author') current.workflowGovernanceIssue!.author = 'untrusted-human';
    if (field === 'issue-pr') current.workflowGovernanceIssue!.prNumber = 186;
    if (field === 'issue-number') current.workflowGovernanceIssue!.issueNumber = 999;
    if (field === 'missing-issue') current.workflowGovernanceIssue = undefined;
    if (field === 'hash')
      current.workflowGovernanceIssue!.body = current.workflowGovernanceIssue!.body.replace(
        current.workflowEvidence!.evidenceHash,
        'sha256:wrong',
      );
    if (field === 'artifacts')
      current.workflowGovernanceIssue!.body = current.workflowGovernanceIssue!.body.replace(
        'new.yaml',
        'other.yaml',
      );
    if (field === 'trust') current.reviews = [];
    expect(
      await finalizeWorkflowLifecycle({ prNumber: 185, mode: 'governance-only' }),
    ).toMatchObject({ status: 'refused' });
    expect(ports.finalize).not.toHaveBeenCalled();
  });

  it('retains publisher failures and confirmed partial effects without reporting completion', async () => {
    const result = {
      closedIssues: [],
      commentedIssues: [186],
      updatedLabels: [],
      errors: ['write failed'],
      failures: [{ code: 'LIFECYCLE_WRITE_FAILED', stage: 'labels', issueNumber: 186 }],
    };
    ports.finalize.mockResolvedValue(result);
    expect(await finalizeWorkflowLifecycle({ prNumber: 185, mode: 'governance-only' })).toEqual({
      status: 'finalized',
      result,
    });
  });

  it('does not downgrade a live evidence read failure to ordinary finalization', async () => {
    ports.codeowners.mockRejectedValue(new Error('evidence unavailable'));
    await expect(
      finalizeWorkflowLifecycle({ prNumber: 185, mode: 'explicit-targets' }),
    ).rejects.toThrow('evidence unavailable');
    expect(ports.finalize).not.toHaveBeenCalled();
  });
});

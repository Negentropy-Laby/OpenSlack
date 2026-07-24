import { describe, it, expect } from 'vitest';
import { diagnosePR } from '../doctor.js';
import { generateDoctorReport } from '../doctor-report.js';
import { createWorkflowEvidence } from '../workflow-gate.js';
import type { PRReviewReport, PRReviewPolicy } from '../types.js';

function makeReport(overrides: Partial<PRReviewReport> = {}): PRReviewReport {
  return {
    prNumber: 1,
    title: 'Test PR',
    author: 'wsman',
    state: 'open',
    draft: false,
    baseRef: 'main',
    riskZone: 'green',
    changedFiles: ['docs/readme.md'],
    checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    reviews: [],
    humanApprovals: [],
    decision: 'ANALYZED',
    reason: '',
    recommendation: '',
    mergeable: true,
    ...overrides,
  };
}

const DEFAULT_POLICY: PRReviewPolicy = {
  no_auto_approval: true,
  no_self_review: true,
  red_zone_human_required: true,
  black_zone_never_merge: true,
  required_base_ref: 'main',
  effective_after_pr: 296,
};

describe('diagnosePR', () => {
  it.each(['integration/notification-delivery-0.3', 'release/0.3', 'feature/topic'])(
    'blocks the non-canonical %s base before mergeability, workflow trust, checks, and approval',
    (baseRef) => {
      const report = makeReport({
        prNumber: 413,
        baseRef,
        mergeable: false,
        riskZone: 'red',
        changedFiles: ['templates/workflows/feature.yaml'],
        checks: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
        reviews: [{ user: 'alice', state: 'APPROVED' }],
      });
      const result = diagnosePR(report, DEFAULT_POLICY, []);
      expect(result.decision).toBe('BLOCKED_BASE_BRANCH');
      expect(result.recommendation).toContain('gh pr edit 413 --base main');
    },
  );

  it('blocks draft PRs', () => {
    const report = makeReport({ draft: true });
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('BLOCKED_DRAFT');
  });

  it('blocks closed PRs', () => {
    const report = makeReport({ state: 'closed' });
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('BLOCKED_POLICY');
  });

  it('blocks merge conflicts', () => {
    const report = makeReport({ mergeable: false });
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('BLOCKED_POLICY');
  });

  it('blocks black zone PRs', () => {
    const report = makeReport({ riskZone: 'black' });
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('BLOCKED_BLACK_ZONE');
  });

  it('blocks when checks are pending', () => {
    const report = makeReport({
      checks: [{ name: 'ci', status: 'in_progress', conclusion: null }],
    });
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('CHECKS_PENDING');
  });

  it('blocks when checks fail', () => {
    const report = makeReport({
      checks: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
    });
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('CHECKS_FAILED');
  });

  it('blocks author-is-sole-codeowner deadlock', () => {
    const report = makeReport({
      riskZone: 'red',
      changedFiles: ['.github/workflows/ci.yml'],
    });
    const result = diagnosePR(report, DEFAULT_POLICY, ['@wsman']);
    expect(result.decision).toBe('BLOCKED_AUTHOR_IS_SOLE_CODEOWNER');
  });

  it('blocks self-review', () => {
    const report = makeReport({
      reviews: [{ user: 'wsman', state: 'APPROVED' }],
    });
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('BLOCKED_SELF_REVIEW');
  });

  it('needs human approval when none exist', () => {
    const report = makeReport();
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('NEEDS_HUMAN_APPROVAL');
  });

  it('ignores bot approvals and needs human approval', () => {
    const report = makeReport({
      reviews: [{ user: 'dependabot[bot]', state: 'APPROVED' }],
    });
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('BOT_APPROVAL_IGNORED');
  });

  it('needs CODEOWNER approval for red zone', () => {
    const report = makeReport({
      author: 'bob',
      riskZone: 'red',
      changedFiles: ['.github/workflows/ci.yml'],
      reviews: [{ user: 'alice', state: 'APPROVED' }],
    });
    const result = diagnosePR(report, DEFAULT_POLICY, ['@wsman', '@bob']);
    expect(result.decision).toBe('NEEDS_CODEOWNER_APPROVAL');
  });

  it('allows green zone with passing checks and valid approval', () => {
    const report = makeReport({
      reviews: [{ user: 'alice', state: 'APPROVED' }],
    });
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('READY_TO_MERGE');
  });

  it('allows yellow zone with passing checks and valid approval', () => {
    const report = makeReport({
      riskZone: 'yellow',
      changedFiles: ['apps/cli/src/index.ts'],
      reviews: [{ user: 'alice', state: 'APPROVED' }],
    });
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('READY_TO_MERGE');

    const stale = diagnosePR(
      makeReport({
        riskZone: 'yellow',
        headSha: 'current-head',
        changedFiles: ['apps/cli/src/index.ts'],
        reviews: [{ user: 'alice', state: 'APPROVED', commitOid: 'old-head' }],
      }),
      DEFAULT_POLICY,
      [],
    );
    expect(stale.decision).toBe('NEEDS_HUMAN_APPROVAL');
  });

  it('uses one current-head approval as both workflow trust and merge approval', () => {
    const path = 'templates/workflows/feature.yaml';
    const workflowEvidence = createWorkflowEvidence({
      baseSha: 'base',
      headSha: 'head',
      baseTree: [{ path, mode: '100644', type: 'blob', sha: 'old' }],
      headTree: [{ path, mode: '100644', type: 'blob', sha: 'new' }],
    });
    const report = makeReport({
      riskZone: 'yellow',
      changedFiles: [path],
      baseSha: 'base',
      headSha: 'head',
      workflowEvidence,
      reviews: [
        {
          user: 'alice',
          state: 'APPROVED',
          body: 'Workflow-Trust: trusted',
          commitOid: 'head',
        },
      ],
    });

    expect(diagnosePR(report, DEFAULT_POLICY, []).decision).toBe('READY_TO_MERGE');
  });

  it('blocks an artifact when the approval targets an older head', () => {
    const path = 'templates/workflows/feature.yaml';
    const workflowEvidence = createWorkflowEvidence({
      baseSha: 'base',
      headSha: 'head',
      baseTree: [{ path, mode: '100644', type: 'blob', sha: 'old' }],
      headTree: [{ path, mode: '100644', type: 'blob', sha: 'new' }],
    });
    const report = makeReport({
      riskZone: 'yellow',
      changedFiles: [path],
      baseSha: 'base',
      headSha: 'head',
      workflowEvidence,
      reviews: [
        {
          user: 'alice',
          state: 'APPROVED',
          body: 'Workflow-Trust: trusted',
          commitOid: 'old-head',
        },
      ],
    });

    expect(diagnosePR(report, DEFAULT_POLICY, []).decision).toBe('BLOCKED_WORKFLOW_GATE');
  });

  it('allows red zone with CODEOWNER approval or an independent human when no owners match', () => {
    const report = makeReport({
      author: 'bob',
      riskZone: 'red',
      changedFiles: ['.github/workflows/ci.yml'],
      reviews: [{ user: 'alice', state: 'APPROVED' }],
    });
    const result = diagnosePR(report, DEFAULT_POLICY, ['@wsman', '@alice']);
    expect(result.decision).toBe('READY_TO_MERGE');
    expect(result.reason).toContain('CODEOWNER approval satisfied');

    const noMatchingOwners = diagnosePR(report, DEFAULT_POLICY, []);
    expect(noMatchingOwners.decision).toBe('READY_TO_MERGE');
    expect(noMatchingOwners.reason).toContain('Independent human approval satisfied');

    const staleNoMatchingOwners = diagnosePR(
      {
        ...report,
        headSha: 'current-head',
        reviews: [{ user: 'alice', state: 'APPROVED', commitOid: 'old-head' }],
      },
      DEFAULT_POLICY,
      [],
    );
    expect(staleNoMatchingOwners.decision).toBe('NEEDS_HUMAN_APPROVAL');

    const botNoMatchingOwners = diagnosePR(
      {
        ...report,
        reviews: [{ user: 'dependabot[bot]', state: 'APPROVED' }],
      },
      DEFAULT_POLICY,
      [],
    );
    expect(botNoMatchingOwners.decision).toBe('BOT_APPROVAL_IGNORED');
  });

  it('allows red zone when policy does not require human approval', () => {
    const report = makeReport({
      author: 'bob',
      riskZone: 'red',
      changedFiles: ['.github/workflows/ci.yml'],
      reviews: [{ user: 'alice', state: 'APPROVED' }],
    });
    const policy = { ...DEFAULT_POLICY, red_zone_human_required: false };
    const result = diagnosePR(report, policy, ['@wsman', '@alice']);
    // Without red_zone_human_required, it skips the codeowner approval gate
    expect(result.decision).toBe('READY_TO_MERGE');
  });
});

describe('generateDoctorReport', () => {
  it('renders skipped checks with skip icon', () => {
    const report = makeReport({
      checks: [
        { name: 'canary', status: 'completed', conclusion: 'success' },
        { name: 'on-pr-merged', status: 'completed', conclusion: 'skipped' },
      ],
    });
    const md = generateDoctorReport(report, []);
    expect(md).toContain('⏭️');
    expect(md).toContain('on-pr-merged');
    expect(md).toContain('| Checks | pass |');
    expect(md).not.toContain('❌');
  });
});

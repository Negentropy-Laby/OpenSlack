import { describe, expect, it } from 'vitest';
import {
  createWorkflowEvidence,
  evaluateWorkflowGate,
  isWorkflowArtifactPath,
  NoWorkflowArtifactChangeError,
} from '../workflow-gate.js';
import type { PRReviewEvidence, WorkflowTreeEntry } from '../types.js';

const BASE_SHA = 'base-sha';
const HEAD_SHA = 'head-sha';

function entry(path: string, sha: string): WorkflowTreeEntry {
  return { path, sha, mode: '100644', type: 'blob' };
}

function modifiedEvidence(path = 'templates/workflows/feature.yaml') {
  return createWorkflowEvidence({
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    baseTree: [entry(path, 'old')],
    headTree: [entry(path, 'new')],
  });
}

function governanceIssue(evidence: ReturnType<typeof modifiedEvidence>, issueNumber = 123) {
  return {
    issueNumber,
    prNumber: 176,
    author: 'openslack-agent-operator[bot]',
    body: [
      '```openslack-workflow-governance',
      'schema: "openslack.workflow_governance.v1"',
      'pr: 176',
      `base_sha: ${JSON.stringify(evidence.baseSha)}`,
      `head_sha: ${JSON.stringify(evidence.headSha)}`,
      `evidence_hash: ${JSON.stringify(evidence.evidenceHash)}`,
      'artifact_files:',
      ...evidence.artifactFiles.map((path) => `  - ${JSON.stringify(path)}`),
      '```',
    ].join('\n'),
  };
}

function review(
  user: string,
  body: string,
  overrides: Partial<PRReviewEvidence> = {},
): PRReviewEvidence {
  return {
    user,
    body,
    state: 'APPROVED',
    commitOid: HEAD_SHA,
    ...overrides,
  };
}

function evaluate(overrides: Partial<Parameters<typeof evaluateWorkflowGate>[0]> = {}) {
  return evaluateWorkflowGate({
    changedFiles: ['templates/workflows/feature.yaml'],
    body: '',
    author: 'author',
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    reviews: [review('reviewer', 'Workflow-Trust: trusted')],
    workflowEvidence: modifiedEvidence(),
    codeowners: ['@owner'],
    ...overrides,
  });
}

describe('workflow artifact classification', () => {
  it.each([
    '.openslack/workflows/review.js',
    '.claude/workflows/review.js',
    'templates/workflows/feature.yaml',
    'packages/workflows/src/builtins/profile-sync.ts',
    'packages/workflows/src/workflow-catalog.ts',
    'packages/workflows/src/pattern-registry.ts',
  ])('classifies %s as a governed artifact', (path) => {
    expect(isWorkflowArtifactPath(path)).toBe(true);
  });

  it.each([
    'packages/workflows/src/runtime.ts',
    'packages/workflows/src/agent-shim.ts',
    'packages/workflows/src/__tests__/runtime.test.ts',
    'packages/workflows/src/__fixtures__/workflow.js',
    'apps/cli/src/commands/collaboration.ts',
  ])('does not classify engine path %s as an artifact', (path) => {
    expect(isWorkflowArtifactPath(path)).toBe(false);
  });

  it('treats the PR #176 workflow engine and test paths as not applicable', () => {
    const result = evaluateWorkflowGate({
      changedFiles: [
        'packages/workflows/src/agent-resolver.ts',
        'packages/workflows/src/agent-shim.ts',
        'packages/workflows/src/workflow-progress.ts',
        'packages/workflows/src/__tests__/runtime.test.ts',
      ],
      body: '',
      author: 'openslack-agent-operator[bot]',
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      reviews: [review('wsman', '')],
      codeowners: [],
    });

    expect(result.overall).toBe('N/A');
  });
});

describe('workflow tree evidence', () => {
  it('is deterministic across tree ordering and path separators', () => {
    const first = createWorkflowEvidence({
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      baseTree: [
        entry('templates/workflows/b.yaml', 'b1'),
        entry('templates/workflows/a.yaml', 'a1'),
      ],
      headTree: [
        entry('templates/workflows/a.yaml', 'a2'),
        entry('templates/workflows/b.yaml', 'b1'),
      ],
    });
    const second = createWorkflowEvidence({
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      baseTree: [
        entry('templates\\workflows\\a.yaml', 'a1'),
        entry('templates/workflows/b.yaml', 'b1'),
        { path: 'templates/workflows/nested', mode: '040000', type: 'tree', sha: 'tree-old' },
      ],
      headTree: [
        entry('templates/workflows/b.yaml', 'b1'),
        entry('templates\\workflows\\a.yaml', 'a2'),
        { path: 'templates/workflows/nested', mode: '040000', type: 'tree', sha: 'tree-new' },
      ],
    });

    expect(first.evidenceHash).toBe(second.evidenceHash);
    expect(first.modifiedFiles).toEqual(['templates/workflows/a.yaml']);
    expect(() =>
      createWorkflowEvidence({
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        baseTree: [entry('templates/workflows/a.yaml', 'same')],
        headTree: [entry('templates/workflows/a.yaml', 'same')],
      }),
    ).toThrow(NoWorkflowArtifactChangeError);
  });

  it('records added, modified, deleted, renamed, and binary blobs by Git identity', () => {
    const evidence = createWorkflowEvidence({
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      baseTree: [
        entry('templates/workflows/old.yaml', 'rename-sha'),
        entry('templates/workflows/delete.yaml', 'delete-sha'),
        entry('templates/workflows/binary.bin', 'binary-old'),
      ],
      headTree: [
        entry('templates/workflows/new.yaml', 'rename-sha'),
        entry('templates/workflows/add.yaml', 'add-sha'),
        entry('templates/workflows/binary.bin', 'binary-new'),
      ],
    });

    expect(evidence.changeKind).toBe('mixed');
    expect(evidence.addedFiles).toEqual([
      'templates/workflows/add.yaml',
      'templates/workflows/new.yaml',
    ]);
    expect(evidence.modifiedFiles).toEqual(['templates/workflows/binary.bin']);
    expect(evidence.deletedFiles).toEqual([
      'templates/workflows/delete.yaml',
      'templates/workflows/old.yaml',
    ]);
    expect(
      evaluate({
        changedFiles: ['templates/workflows/new.yaml', 'templates/workflows/binary.bin'],
        workflowEvidence: evidence,
        body: 'Workflow governance #123',
        governanceIssue: governanceIssue(evidence),
      }).overall,
    ).toBe('PASS');
  });
});

describe('human workflow trust review', () => {
  it('accepts one current-head human approval as the merge and trust decision', () => {
    const result = evaluate();
    expect(result.overall).toBe('PASS');
    expect(result).toMatchObject({
      trustDecision: 'trusted',
      trustReviewer: 'reviewer',
      trustReviewCommitOid: HEAD_SHA,
      trustSource: 'human-review',
    });
  });

  it.each([
    ['bot', review('github-actions[bot]', 'Workflow-Trust: trusted')],
    ['author', review('author', 'Workflow-Trust: trusted')],
    ['stale head', review('reviewer', 'Workflow-Trust: trusted', { commitOid: 'old-head' })],
    ['non-approval', review('reviewer', 'Workflow-Trust: trusted', { state: 'COMMENTED' })],
    ['missing marker', review('reviewer', 'Looks good')],
  ])('rejects a %s review', (_name, invalidReview) => {
    expect(evaluate({ reviews: [invalidReview] }).overall).toBe('FAIL');
  });

  it('rejects duplicate, unknown, and conflicting trust markers', () => {
    expect(
      evaluate({
        reviews: [review('reviewer', 'Workflow-Trust: trusted\nWorkflow-Trust: trusted')],
      }).overall,
    ).toBe('FAIL');
    expect(
      evaluate({
        reviews: [review('reviewer', 'Workflow-Trust: superuser')],
      }).overall,
    ).toBe('FAIL');
    expect(
      evaluate({
        reviews: [
          review('alice', 'Workflow-Trust: trusted'),
          review('bob', 'Workflow-Trust: untrusted'),
        ],
      }).overall,
    ).toBe('FAIL');
  });

  it('allows an untrusted artifact to merge under runtime read-only restrictions', () => {
    const result = evaluate({ reviews: [review('reviewer', 'Workflow-Trust: untrusted')] });
    expect(result.overall).toBe('PASS');
    expect(result.trustDecision).toBe('untrusted');
  });

  it('requires a governance issue for a new non-core artifact', () => {
    const evidence = createWorkflowEvidence({
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      baseTree: [],
      headTree: [entry('templates/workflows/new.yaml', 'new')],
    });
    const input = {
      changedFiles: ['templates/workflows/new.yaml'],
      workflowEvidence: evidence,
    };

    expect(evaluate(input).overall).toBe('FAIL');
    expect(evaluate({ ...input, body: 'Workflow governance #123' }).overall).toBe('FAIL');
    expect(
      evaluate({
        ...input,
        body: 'Workflow governance #123',
        governanceIssue: { ...governanceIssue(evidence), author: 'human-author' },
      }).overall,
    ).toBe('FAIL');
    expect(
      evaluate({
        ...input,
        body: 'Workflow governance #123',
        governanceIssue: governanceIssue(evidence),
      }).overall,
    ).toBe('PASS');
  });

  it('requires core trust, a CODEOWNER, and a governance issue for core artifacts', () => {
    const path = 'packages/workflows/src/builtins/profile-sync.ts';
    const workflowEvidence = modifiedEvidence(path);
    const common = {
      changedFiles: [path],
      workflowEvidence,
      body: 'Workflow governance #123',
      governanceIssue: governanceIssue(workflowEvidence),
    };

    expect(evaluate(common).overall).toBe('FAIL');
    expect(
      evaluate({
        ...common,
        reviews: [review('reviewer', 'Workflow-Trust: core')],
      }).overall,
    ).toBe('FAIL');
    expect(
      evaluate({
        ...common,
        reviews: [review('owner', 'Workflow-Trust: core')],
      }).overall,
    ).toBe('PASS');
  });

  it('accepts the PR #185 evidence shape using PR-level CODEOWNER evidence', () => {
    const path = 'packages/workflows/src/builtins/profile-sync.ts';
    const workflowEvidence = modifiedEvidence(path);
    const issue = governanceIssue(workflowEvidence, 186);
    issue.prNumber = 185;
    issue.body = issue.body.replaceAll('pr: 176', 'pr: 185');

    const result = evaluateWorkflowGate({
      changedFiles: ['.github/workflows/openslack-release.yml', path],
      body: 'Workflow governance #186',
      author: 'openslack-agent-operator[bot]',
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      reviews: [review('wsman', 'Workflow-Trust: core')],
      workflowEvidence,
      governanceIssue: issue,
      codeowners: ['@wsman'],
    });

    expect(result).toMatchObject({
      overall: 'PASS',
      trustDecision: 'core',
      trustReviewer: 'wsman',
      trustReviewCommitOid: HEAD_SHA,
      evidenceHash: workflowEvidence.evidenceHash,
      governanceIssue: 186,
    });
  });

  it('rejects a governance issue with the wrong evidence hash or issue binding', () => {
    const path = 'packages/workflows/src/builtins/profile-sync.ts';
    const workflowEvidence = modifiedEvidence(path);
    const issue = governanceIssue(workflowEvidence, 186);
    const common = {
      changedFiles: [path],
      body: 'Workflow governance #186',
      author: 'openslack-agent-operator[bot]',
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      reviews: [review('owner', 'Workflow-Trust: core')],
      workflowEvidence,
      codeowners: ['@owner'],
    };

    expect(
      evaluateWorkflowGate({
        ...common,
        governanceIssue: {
          ...issue,
          body: issue.body.replace(workflowEvidence.evidenceHash, 'sha256:wrong'),
        },
      }).overall,
    ).toBe('FAIL');
    expect(
      evaluateWorkflowGate({
        ...common,
        governanceIssue: { ...issue, issueNumber: 187 },
      }).overall,
    ).toBe('FAIL');
  });
});

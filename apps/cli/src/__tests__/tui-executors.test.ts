import type * as MockModule2 from '@openslack/workflows';
// Fixture ownership must use the same built module as the CLI package consumer.
import { createWorkflowSourceSnapshot } from '../../../../packages/workflows/dist/internal/workflow-source-snapshot.js';
import type * as MockModule1 from '@openslack/collaboration';
import type * as MockModule0 from '@openslack/operator';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  executeApproval,
  executeTrustChange,
  executeWorkflowRun,
  finalizeWorkflowPr,
  recordWorkbenchActionFromTui,
  saveWorkflowRunScriptFromTui,
  splitWorkflowIntoIssues,
  startWorkflowFromPattern,
  startWorkflowFromPrompt,
  submitWorkbenchAskFromTui,
} from '../commands/tui-executors.js';
import type { ApprovalExecutionParams } from '../commands/tui-executors.js';
import { TrustStore } from '@openslack/workflows';
import * as operator from '@openslack/operator';
import type { ActionRegistryPort } from '@openslack/operator';
import * as collaboration from '@openslack/collaboration';
import * as pr from '@openslack/pr';
import * as github from '@openslack/github';
import {
  createWorkflowEvidence,
  evaluateWorkflowGate as evaluateRealWorkflowGate,
} from '../../../../packages/pr/src/workflow-gate.js';

// ── Module-level mocks ──────────────────────────────────────────────────────────

vi.mock('@openslack/operator', async () => {
  const actual = await vi.importActual<typeof MockModule0>('@openslack/operator');
  return {
    ...actual,
    updatePendingPlanState: vi.fn(),
    listPendingPlans: vi.fn(),
  };
});

vi.mock('@openslack/collaboration', async () => {
  const actual = await vi.importActual<typeof MockModule1>('@openslack/collaboration');
  return {
    ...actual,
    recordDecision: vi.fn(),
    listHandoffs: vi.fn(() => []),
    recordEvent: vi.fn(),
  };
});

vi.mock('@openslack/pr', () => ({
  mergeIfReady: vi.fn(),
  fetchPRDetails: vi.fn(),
  loadPRCodeownerEvidence: vi.fn(),
  evaluateWorkflowGate: vi.fn(),
}));

vi.mock('@openslack/github', () => ({
  publishWorkflowSplit: vi.fn(),
  finalizeWorkflowPR: vi.fn(),
  fetchWorkflowLifecycleIssues: vi.fn(),
  getPR: vi.fn(),
}));

vi.mock('@openslack/workflows', async () => {
  const actual = await vi.importActual<typeof MockModule2>('@openslack/workflows');
  return {
    ...actual,
    TrustStore: vi.fn((opts: { rootDir: string }) => ({
      rootDir: opts.rootDir,
      get: vi.fn(() => 'untrusted'),
      set: vi.fn(),
      save: vi.fn(),
    })),
    findWorkflow: vi.fn(),
    loadWorkflow: vi.fn(),
    executePreview: vi.fn(),
    executeDryRun: vi.fn(),
    executeWorkflowThroughRunner: vi.fn(),
    loadWorkflowRunnerControlConfig: vi.fn(() => ({
      origin: 'http://127.0.0.1:18181',
      workspaceId: 'workspace.test',
      bearerToken: 't'.repeat(32),
      descriptorRoot: '/test/root/.openslack.local/workflow-runner/descriptors',
    })),
    loadWorkflowRunRoutingConfig: vi.fn(() => ({ mode: 'disabled', ignoredSettings: [] })),
    createWorkflowRunRoutingExecutionContext: vi.fn(() => ({ mode: 'disabled' })),
    readWorkflowRunnerSourceBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
    buildApprovalManifest: vi.fn(() => ({
      workflowName: 'test-wf',
      runId: 'dryrun-test-001',
      actorId: 'tui-user',
      workflowHash: 'hash123',
      inputHash: 'input-hash',
      risk: 'medium',
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      approvedEffects: [],
    })),
    generateWorkflowDraft: vi.fn(() =>
      Promise.resolve({
        draftId: 'draft-001',
        path: '/test/root/.openslack/workflows/drafts/draft-001.workflow.yaml',
        pattern: 'fanout-synthesize',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ),
    getWorkflowPattern: vi.fn((patternId: string) =>
      patternId === 'fanout-synthesize'
        ? {
            id: 'fanout-synthesize',
            name: 'Fanout synthesize',
            description: 'Fan out research and synthesize evidence',
            useCases: ['research broad task surfaces'],
            phases: [],
            requiredCapabilities: [],
          }
        : null,
    ),
    saveWorkflowRunScript: vi.fn(() =>
      Promise.resolve({
        workflowName: 'test-wf',
        sourceRunId: 'run-001',
        source: 'project',
        path: '/test/root/.openslack/workflows/test-wf.mjs',
        scriptHash: 'script-hash',
      }),
    ),
    WorkflowPausedError: class WorkflowPausedError extends Error {
      readonly operation: string;
      readonly runId: string;
      constructor(operation: string, _detail: string, runId: string) {
        super(`Workflow paused: ${operation}`);
        this.name = 'WorkflowPausedError';
        this.operation = operation;
        this.runId = runId;
      }
    },
    WorkflowBudgetPausedError: class WorkflowBudgetPausedError extends Error {
      readonly runId: string;
      readonly detail: string;
      constructor(runId: string, detail: string) {
        super(`Workflow paused: budget exceeded for run ${runId}`);
        this.name = 'WorkflowBudgetPausedError';
        this.runId = runId;
        this.detail = detail;
      }
    },
    hashString: vi.fn(() => 'hashed-input'),
  };
});

// ── Constants ──────────────────────────────────────────────────────────────────

const ROOT = '/test/root';

// ── Helpers ─────────────────────────────────────────────────────────────────────

function planParams(overrides?: Partial<ApprovalExecutionParams>): ApprovalExecutionParams {
  return {
    id: 'ITEM-1',
    category: 'plan',
    title: 'Test Plan',
    planId: 'PLAN-1',
    ...overrides,
  };
}

function mergeParams(overrides?: Partial<ApprovalExecutionParams>): ApprovalExecutionParams {
  return {
    id: 'ITEM-2',
    category: 'merge-request',
    title: 'Merge PR #42',
    prNumber: 42,
    ...overrides,
  };
}

function workflowEffectParams(
  overrides?: Partial<ApprovalExecutionParams>,
): ApprovalExecutionParams {
  return {
    id: 'ITEM-3',
    category: 'workflow-effect',
    title: 'Deploy to staging',
    workflowName: 'deploy-staging',
    ...overrides,
  };
}

function githubReviewParams(overrides?: Partial<ApprovalExecutionParams>): ApprovalExecutionParams {
  return {
    id: 'ITEM-4',
    category: 'github-review',
    title: 'Approve PR #99',
    ...overrides,
  };
}

// ── executeApproval ─────────────────────────────────────────────────────────────

describe('finalizeWorkflowPr evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('does not auto-select a body issue when the real governance criterion is N/A', async () => {
    const path = '.openslack/workflows/existing.mjs';
    const report = {
      workflowEvidence: createWorkflowEvidence({
        baseSha: 'base',
        headSha: 'head',
        baseTree: [{ path, sha: 'old', mode: '100644', type: 'blob' }],
        headTree: [{ path, sha: 'new', mode: '100644', type: 'blob' }],
      }),
      changedFiles: [path],
      body: 'Historical discussion: Workflow governance #999',
      author: 'author',
      baseSha: 'base',
      headSha: 'head',
      reviews: [
        {
          user: 'human-reviewer',
          state: 'APPROVED',
          commitOid: 'head',
          body: 'Workflow-Trust: trusted',
        },
      ],
    };
    const gate = evaluateRealWorkflowGate(report);
    expect(gate.overall).toBe('PASS');
    expect(gate.criteria).toContainEqual(
      expect.objectContaining({
        name: 'Governance issue',
        status: 'N/A',
      }),
    );
    expect(gate.governanceIssue).toBe(999);
    vi.mocked(pr.fetchPRDetails).mockResolvedValue(report as never);
    vi.mocked(pr.loadPRCodeownerEvidence).mockResolvedValue({ owners: [] } as never);
    vi.mocked(pr.evaluateWorkflowGate).mockReturnValue(gate);
    vi.mocked(github.getPR).mockResolvedValue({
      merged: true,
      head: { sha: 'head' },
      base: { sha: 'base' },
    } as never);
    expect(await finalizeWorkflowPr('existing', 42, '/test')).toMatchObject({ success: false });
    expect(github.finalizeWorkflowPR).not.toHaveBeenCalled();
  });
  it('fails closed without repository artifact evidence', async () => {
    vi.mocked(pr.fetchPRDetails).mockResolvedValue({} as never);
    expect(await finalizeWorkflowPr('workflow.test', 42, '/test')).toMatchObject({
      success: false,
    });
    expect(github.finalizeWorkflowPR).not.toHaveBeenCalled();
  });
  it.each(['PASS', 'FAIL'] as const)(
    'uses only the repository gate evidence on %s',
    async (overall) => {
      vi.mocked(pr.fetchPRDetails).mockResolvedValue({
        workflowEvidence: {},
        workflowGovernanceIssue: { issueNumber: 41, prNumber: 42 },
        changedFiles: [],
        reviews: [],
        baseSha: 'base',
        headSha: 'head',
        author: 'author',
      } as never);
      vi.mocked(pr.loadPRCodeownerEvidence).mockResolvedValue({ owners: ['reviewer'] } as never);
      vi.mocked(pr.evaluateWorkflowGate).mockReturnValue({
        overall,
        criteria: [{ name: 'Governance issue', status: 'PASS' }],
        evidenceHash: 'sha256:artifact',
        trustDecision: 'trusted',
        governanceIssue: 41,
        trustReviewer: 'reviewer',
        trustReviewCommitOid: 'head',
      } as never);
      vi.mocked(github.fetchWorkflowLifecycleIssues).mockResolvedValue({
        phaseIssues: [],
      } as never);
      vi.mocked(github.finalizeWorkflowPR).mockResolvedValue({
        closedIssues: [],
        commentedIssues: [],
        updatedLabels: [],
        errors: [],
      });
      vi.mocked(github.getPR).mockResolvedValue({
        merged: true,
        head: { sha: 'head' },
        base: { sha: 'base' },
      } as never);
      expect(await finalizeWorkflowPr('workflow.test', 42, '/test')).toMatchObject({
        success: overall === 'PASS',
      });
      if (overall === 'FAIL') expect(github.finalizeWorkflowPR).not.toHaveBeenCalled();
      else
        expect(github.finalizeWorkflowPR).toHaveBeenCalledWith(
          42,
          expect.objectContaining({
            workflowHash: 'sha256:artifact',
            trustDecision: 'trusted',
            governanceIssue: 41,
            trustReviewer: 'reviewer',
            trustReviewCommitOid: 'head',
          }),
        );
      expect(github.fetchWorkflowLifecycleIssues).not.toHaveBeenCalled();
      if (overall === 'PASS') {
        for (const side of ['head', 'base']) {
          vi.mocked(github.finalizeWorkflowPR).mockClear();
          vi.mocked(github.getPR).mockResolvedValue({
            merged: true,
            head: { sha: side === 'head' ? 'drift' : 'head' },
            base: { sha: side === 'base' ? 'drift' : 'base' },
          } as never);
          expect(await finalizeWorkflowPr('workflow.test', 42, '/test')).toMatchObject({
            success: false,
          });
          expect(github.finalizeWorkflowPR).not.toHaveBeenCalled();
        }
        vi.mocked(github.getPR).mockRejectedValueOnce(new Error('offline'));
        expect(await finalizeWorkflowPr('workflow.test', 42, '/test')).toMatchObject({
          success: false,
        });
        expect(github.finalizeWorkflowPR).not.toHaveBeenCalled();
        vi.mocked(github.getPR).mockResolvedValue({
          merged: true,
          head: { sha: 'head' },
          base: { sha: 'base' },
        } as never);
        vi.mocked(github.finalizeWorkflowPR).mockResolvedValueOnce({
          closedIssues: [],
          commentedIssues: [],
          updatedLabels: [],
          errors: [],
          dryRun: true,
        });
        expect(await finalizeWorkflowPr('workflow.test', 42, '/test')).toMatchObject({
          message: expect.stringContaining('preview only'),
        });
        vi.mocked(pr.evaluateWorkflowGate).mockReturnValueOnce({
          overall: 'PASS',
          evidenceHash: 'sha256:artifact',
          trustDecision: 'trusted',
        } as never);
        vi.mocked(github.finalizeWorkflowPR).mockClear();
        expect(await finalizeWorkflowPr('workflow.test', 42, '/test')).toMatchObject({
          success: false,
          message: expect.stringContaining('governance issue is missing'),
        });
        expect(github.finalizeWorkflowPR).not.toHaveBeenCalled();
      }
      vi.mocked(github.finalizeWorkflowPR).mockClear();
      for (const state of ['open', 'closed']) {
        vi.mocked(github.getPR).mockResolvedValue({
          merged: false,
          state,
          head: { sha: 'head' },
          base: { sha: 'base' },
        } as never);
        expect(await finalizeWorkflowPr('unrelated-workflow', 42, '/test')).toMatchObject({
          success: false,
        });
        expect(github.finalizeWorkflowPR).not.toHaveBeenCalled();
      }
    },
  );
});

describe('executeApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Plan category ──────────────────────────────────────────────────────────

  describe('plan category', () => {
    it('plan approve - updates state and records decision', async () => {
      vi.mocked(operator.updatePendingPlanState).mockReturnValue({
        planId: 'PLAN-1',
        state: 'approved',
      } as unknown as ReturnType<typeof operator.updatePendingPlanState>);

      const result = await executeApproval(planParams(), true, ROOT, 'tui-user');

      expect(result.success).toBe(true);
      expect(result.message).toContain('PLAN-1');
      expect(result.message).toContain('approved');
      expect(operator.updatePendingPlanState).toHaveBeenCalledWith('PLAN-1', 'approved', ROOT);
      expect(collaboration.recordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'Test Plan',
          decision: 'approved',
          decidedBy: 'tui-user',
          tags: expect.arrayContaining(['plan-approval', 'tui']),
        }),
      );
    });

    it('plan reject - cancels plan and records decision', async () => {
      vi.mocked(operator.updatePendingPlanState).mockReturnValue({
        planId: 'PLAN-1',
        state: 'cancelled',
      } as unknown as ReturnType<typeof operator.updatePendingPlanState>);

      const result = await executeApproval(planParams(), false, ROOT, 'tui-user');

      expect(result.success).toBe(true);
      expect(result.message).toContain('rejected');
      expect(operator.updatePendingPlanState).toHaveBeenCalledWith('PLAN-1', 'cancelled', ROOT);
      expect(collaboration.recordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'rejected',
          rationale: expect.stringContaining('Rejected'),
        }),
      );
    });

    it('plan not found - returns failure', async () => {
      vi.mocked(operator.updatePendingPlanState).mockReturnValue(null);

      const result = await executeApproval(planParams(), true, ROOT, 'tui-user');

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
      expect(collaboration.recordDecision).not.toHaveBeenCalled();
    });

    it('plan without planId - returns failure', async () => {
      const result = await executeApproval(
        planParams({ planId: undefined }),
        true,
        ROOT,
        'tui-user',
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Plan ID not available');
      expect(operator.updatePendingPlanState).not.toHaveBeenCalled();
    });

    it('handles API errors gracefully', async () => {
      vi.mocked(operator.updatePendingPlanState).mockImplementation(() => {
        throw new Error('disk full');
      });

      const result = await executeApproval(planParams(), true, ROOT, 'tui-user');

      expect(result.success).toBe(false);
      expect(result.message).toContain('disk full');
    });
  });

  // ── Merge-request category ─────────────────────────────────────────────────

  describe('merge-request category', () => {
    it('merge-request approve - calls mergeIfReady', async () => {
      vi.mocked(pr.mergeIfReady).mockResolvedValue({
        merged: true,
        decision: 'MERGED',
        reason: 'ok',
        message: 'Merged successfully',
        sha: 'abc123',
      });

      const result = await executeApproval(mergeParams(), true, ROOT, 'tui-user');

      expect(result.success).toBe(true);
      expect(result.data?.sha).toBe('abc123');
      expect(pr.mergeIfReady).toHaveBeenCalledWith(42, {
        no_auto_approval: true,
        no_self_review: true,
        red_zone_human_required: true,
        black_zone_never_merge: true,
        required_base_ref: 'main',
        effective_after_pr: 296,
      });
      expect(collaboration.recordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'Merge PR #42',
          decision: 'approved',
          tags: expect.arrayContaining(['merge-request', 'tui', 'pr-42']),
        }),
      );
    });

    it('merge-request approve - merge blocked returns failure', async () => {
      vi.mocked(pr.mergeIfReady).mockResolvedValue({
        merged: false,
        decision: 'BLOCKED' as unknown as 'approved',
        reason: 'checks failed',
        message: 'Blocked',
      } as unknown as Awaited<ReturnType<typeof pr.mergeIfReady>>);

      const result = await executeApproval(mergeParams(), true, ROOT, 'tui-user');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Merge blocked');
      expect(result.message).toContain('checks failed');
      expect(collaboration.recordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'blocked',
          rationale: 'checks failed',
        }),
      );
    });

    it('merge-request reject - records cancelled decision', async () => {
      const result = await executeApproval(mergeParams(), false, ROOT, 'tui-user');

      expect(result.success).toBe(true);
      expect(result.message).toContain('rejected');
      expect(pr.mergeIfReady).not.toHaveBeenCalled();
      expect(collaboration.recordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'cancelled',
          rationale: expect.stringContaining('rejected via TUI'),
        }),
      );
    });

    it('merge-request without prNumber - returns failure', async () => {
      const result = await executeApproval(
        mergeParams({ prNumber: undefined }),
        true,
        ROOT,
        'tui-user',
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('PR number not available');
      expect(pr.mergeIfReady).not.toHaveBeenCalled();
    });
  });

  // ── Workflow-effect category ───────────────────────────────────────────────

  describe('workflow-effect category', () => {
    it('workflow-effect confirm - records decision', async () => {
      const result = await executeApproval(workflowEffectParams(), true, ROOT, 'tui-user');

      expect(result.success).toBe(true);
      expect(result.message).toContain('confirmed');
      expect(collaboration.recordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'Deploy to staging',
          decision: 'confirmed',
          rationale: expect.stringContaining('confirmed via TUI'),
          tags: expect.arrayContaining(['workflow-run-gate', 'legacy', 'tui']),
        }),
      );
    });

    it('workflow-effect cancel - records decision', async () => {
      const result = await executeApproval(workflowEffectParams(), false, ROOT, 'tui-user');

      expect(result.success).toBe(true);
      expect(result.message).toContain('cancelled');
      expect(collaboration.recordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'cancelled',
          rationale: expect.stringContaining('cancelled via TUI'),
        }),
      );
    });

    it('workflow-effect includes workflowName in rationale when present', async () => {
      await executeApproval(workflowEffectParams(), true, ROOT, 'tui-user');

      expect(collaboration.recordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          rationale: expect.stringContaining('for deploy-staging'),
        }),
      );
    });

    it('workflow-effect omits workflow name from rationale when absent', async () => {
      await executeApproval(
        workflowEffectParams({ workflowName: undefined }),
        true,
        ROOT,
        'tui-user',
      );

      const call = vi.mocked(collaboration.recordDecision).mock.calls[0][0] as {
        rationale: string;
      };
      expect(call.rationale).not.toContain('for undefined');
    });
  });

  // ── GitHub-review category ─────────────────────────────────────────────────

  describe('github-review category', () => {
    it('github-review always returns CLI fallback', async () => {
      const result = await executeApproval(githubReviewParams(), true, ROOT, 'tui-user');

      expect(result.success).toBe(false);
      expect(result.message).toContain('GitHub PR approval requires human GitHub identity');
      expect(result.data?.cliCommand).toContain('gh pr review');
    });
  });
});

// ── executeTrustChange ───────────────────────────────────────────────────────────

describe('executeTrustChange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('changes trust level successfully', async () => {
    const result = await executeTrustChange('my-workflow', 'untrusted', 'trusted', ROOT);

    expect(result.success).toBe(true);
    expect(result.message).toContain('my-workflow');
    expect(result.message).toContain('untrusted');
    expect(result.message).toContain('trusted');
    expect(vi.mocked(TrustStore).mock.results[0].value.set).toHaveBeenCalledWith(
      'my-workflow',
      'trusted',
    );
    expect(vi.mocked(TrustStore).mock.results[0].value.save).toHaveBeenCalled();
    expect(TrustStore).toHaveBeenCalledWith({ rootDir: ROOT });
  });

  it('rejects core workflows', async () => {
    const result = await executeTrustChange('system-critical', 'core', 'trusted', ROOT);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Protected workflows');
  });

  it('rejects builtin workflows', async () => {
    const result = await executeTrustChange('builtin-checks', 'builtin', 'trusted', ROOT);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Protected workflows');
  });

  it('handles save errors', async () => {
    const { TrustStore: MockedTrustStore } = await import('@openslack/workflows');
    vi.mocked(MockedTrustStore).mockImplementation(
      () =>
        ({
          rootDir: ROOT,
          get: vi.fn(() => 'untrusted'),
          set: vi.fn(),
          save: vi.fn(() => {
            throw new Error('permission denied');
          }),
        }) as unknown as InstanceType<typeof MockedTrustStore>,
    );

    const result = await executeTrustChange('my-workflow', 'untrusted', 'trusted', ROOT);

    expect(result.success).toBe(false);
    expect(result.message).toContain('permission denied');
  });
});

// ── workflow start and save/share handlers ─────────────────────────────────────

describe('workflow start and save/share handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts a workflow draft from prompt', async () => {
    const { generateWorkflowDraft } = await import('@openslack/workflows');

    const result = await startWorkflowFromPrompt('audit all workflow routes', ROOT);

    expect(result.success).toBe(true);
    expect(result.message).toContain('draft-001');
    expect(generateWorkflowDraft).toHaveBeenCalledWith({
      prompt: 'audit all workflow routes',
      rootDir: ROOT,
    });
  });

  it('starts a workflow draft from pattern registry', async () => {
    const { generateWorkflowDraft, getWorkflowPattern } = await import('@openslack/workflows');

    const result = await startWorkflowFromPattern('fanout-synthesize', ROOT);

    expect(result.success).toBe(true);
    expect(getWorkflowPattern).toHaveBeenCalledWith('fanout-synthesize');
    expect(generateWorkflowDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        pattern: 'fanout-synthesize',
        rootDir: ROOT,
      }),
    );
  });

  it('rejects unknown workflow start patterns', async () => {
    const result = await startWorkflowFromPattern('missing-pattern', ROOT);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Unknown workflow pattern');
  });

  it('saves workflow run scripts to project, user, and Claude project targets', async () => {
    const { saveWorkflowRunScript } = await import('@openslack/workflows');

    await saveWorkflowRunScriptFromTui('run-001', ROOT, 'project');
    await saveWorkflowRunScriptFromTui('run-001', ROOT, 'user');
    await saveWorkflowRunScriptFromTui('run-001', ROOT, 'claude-project');

    expect(saveWorkflowRunScript).toHaveBeenNthCalledWith(1, 'run-001', {
      rootDir: ROOT,
      to: 'project',
    });
    expect(saveWorkflowRunScript).toHaveBeenNthCalledWith(2, 'run-001', {
      rootDir: ROOT,
      to: 'user',
    });
    expect(saveWorkflowRunScript).toHaveBeenNthCalledWith(3, 'run-001', {
      rootDir: ROOT,
      to: 'claude-project',
    });
  });

  it('splits workflow phases by creating a parent issue when none is provided', async () => {
    const { findWorkflow, loadWorkflow } = await import('@openslack/workflows');
    vi.mocked(findWorkflow).mockResolvedValueOnce({
      path: '/test/wf.js',
      name: 'test-wf',
      source: 'openslack-project',
    });
    vi.mocked(loadWorkflow).mockResolvedValueOnce({
      meta: {
        name: 'test-wf',
        description: 'Test',
        phases: [{ title: 'Scan', detail: 'Scan' }],
        risk: 'medium',
      },
      format: 'openslack-native',
      hash: 'hash123',
    });
    vi.mocked(github.publishWorkflowSplit).mockResolvedValueOnce({
      parentIssueNumber: 100,
      subIssues: [{ phase: 'Scan', issueNumber: 101, url: 'https://github.com/test/101' }],
      links: {
        nativeSubIssues: 0,
        fallbackSubIssues: 1,
        nativeDependencies: 0,
        fallbackDependencies: 0,
        fallbackReasons: [],
      },
    });

    const result = await splitWorkflowIntoIssues('test-wf', undefined, ROOT);

    expect(result.success).toBe(true);
    expect(github.publishWorkflowSplit).toHaveBeenCalledWith(expect.any(Object), {});
    expect(result.data?.parentIssueNumber).toBe(100);
  });

  it('passes an existing parent issue when splitting workflow phases', async () => {
    const { findWorkflow, loadWorkflow } = await import('@openslack/workflows');
    vi.mocked(findWorkflow).mockResolvedValueOnce({
      path: '/test/wf.js',
      name: 'test-wf',
      source: 'openslack-project',
    });
    vi.mocked(loadWorkflow).mockResolvedValueOnce({
      meta: {
        name: 'test-wf',
        description: 'Test',
        phases: [{ title: 'Scan', detail: 'Scan' }],
        risk: 'medium',
      },
      format: 'openslack-native',
      hash: 'hash123',
    });
    vi.mocked(github.publishWorkflowSplit).mockResolvedValueOnce({
      parentIssueNumber: 42,
      subIssues: [{ phase: 'Scan', issueNumber: 43, url: 'https://github.com/test/43' }],
      links: {
        nativeSubIssues: 0,
        fallbackSubIssues: 1,
        nativeDependencies: 0,
        fallbackDependencies: 0,
        fallbackReasons: [],
      },
    });

    const result = await splitWorkflowIntoIssues('test-wf', 42, ROOT);

    expect(result.success).toBe(true);
    expect(github.publishWorkflowSplit).toHaveBeenCalledWith(expect.any(Object), {
      parentIssue: 42,
    });
    expect(result.data?.parentIssueNumber).toBe(42);
  });
});

// ── executeWorkflowRun ───────────────────────────────────────────────────────────

describe('executeWorkflowRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not found for missing workflow', async () => {
    const result = await executeWorkflowRun('deploy-production', 'preview', process.cwd());

    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('returns not found for missing workflow in dry-run mode', async () => {
    const result = await executeWorkflowRun('deploy-production', 'dry-run', process.cwd());

    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('returns not found for missing workflow in run mode', async () => {
    const result = await executeWorkflowRun('deploy-production', 'run', process.cwd());

    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('run mode builds manifest and passes confirmationPolicy', async () => {
    const {
      findWorkflow,
      loadWorkflow,
      executeDryRun,
      executeWorkflowThroughRunner,
      buildApprovalManifest,
      TrustStore,
    } = await import('@openslack/workflows');
    vi.mocked(findWorkflow).mockResolvedValue({
      path: '/test/wf.js',
      name: 'test-wf',
      source: 'openslack-project',
    });
    vi.mocked(loadWorkflow).mockResolvedValue({
      meta: {
        name: 'test-wf',
        description: 'Test',
        phases: [{ title: 'Scan', detail: 'Scan' }],
        risk: 'medium',
      },
      format: 'openslack-native',
      hash: 'hash123',
      sourceSnapshot: createWorkflowSourceSnapshot(new Uint8Array([1, 2, 3]), {
        name: 'test-wf',
        description: 'Test',
        phases: [{ title: 'Scan', detail: 'Scan' }],
        risk: 'medium',
      }),
    });
    vi.mocked(TrustStore).mockImplementation(
      () =>
        ({
          rootDir: ROOT,
          get: vi.fn(() => 'trusted'),
          set: vi.fn(),
          save: vi.fn(),
        }) as unknown as InstanceType<typeof TrustStore>,
    );
    vi.mocked(executeDryRun).mockResolvedValue({
      dryRun: true,
      runId: 'dryrun-001',
      workflowName: 'test-wf',
      simulatedEffects: [
        {
          operation: 'openslack.task.createIssue',
          detail: 'Create issue',
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
      errors: [],
    });
    vi.mocked(executeWorkflowThroughRunner).mockResolvedValue({ status: 'completed' });

    const result = await executeWorkflowRun('test-wf', 'run', ROOT);

    expect(result.success).toBe(true);
    expect(executeDryRun).toHaveBeenCalled();
    expect(buildApprovalManifest).toHaveBeenCalled();
    const submitted = vi.mocked(executeWorkflowThroughRunner).mock.calls.at(-1)![0];
    expect(vi.mocked(buildApprovalManifest).mock.calls.at(-1)![3]).toBe(
      submitted.sourceSnapshot!.workflowSourceHash,
    );
    expect(executeWorkflowThroughRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmationPolicy: expect.objectContaining({
          mode: 'preapproved-manifest',
          onUnexpectedEffect: 'pause',
        }),
      }),
    );
  });

  it('rejects source changed during dry-run before building approval evidence or submitting', async () => {
    const {
      findWorkflow,
      loadWorkflow,
      executeDryRun,
      executeWorkflowThroughRunner,
      buildApprovalManifest,
      readWorkflowRunnerSourceBytes,
    } = await import('@openslack/workflows');
    const meta = {
      name: 'test-wf',
      description: 'Test',
      phases: [{ title: 'Scan', detail: 'Scan' }],
      risk: 'low' as const,
    };
    const sourceSnapshot = createWorkflowSourceSnapshot(new Uint8Array([1, 2, 3]), meta);
    vi.mocked(findWorkflow).mockResolvedValue({
      path: '/test/wf.js',
      name: 'test-wf',
      source: 'openslack-project',
    });
    vi.mocked(loadWorkflow).mockResolvedValue({
      meta,
      format: 'openslack-native',
      hash: sourceSnapshot.rawHash,
      sourceSnapshot,
    });
    vi.mocked(executeDryRun).mockImplementation(async () => {
      vi.mocked(readWorkflowRunnerSourceBytes).mockResolvedValueOnce(new Uint8Array([4, 5, 6]));
      return {
        dryRun: true,
        runId: 'dryrun-drift',
        workflowName: meta.name,
        simulatedEffects: [],
        errors: [],
      };
    });
    const result = await executeWorkflowRun('test-wf', 'run', ROOT);
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      code: 'WORKFLOW_SOURCE_EVIDENCE_INVALID',
      reasonCode: 'SOURCE_DRIFT',
    });
    expect(buildApprovalManifest).not.toHaveBeenCalled();
    expect(executeWorkflowThroughRunner).not.toHaveBeenCalled();
  });

  it('run mode rejects untrusted high-risk workflow', async () => {
    const { findWorkflow, loadWorkflow, TrustStore } = await import('@openslack/workflows');
    vi.mocked(findWorkflow).mockResolvedValue({
      path: '/test/wf.js',
      name: 'risky-wf',
      source: 'openslack-project',
    });
    vi.mocked(loadWorkflow).mockResolvedValue({
      meta: {
        name: 'risky-wf',
        description: 'Risky',
        phases: [{ title: 'Scan', detail: 'Scan' }],
        risk: 'high',
      },
      format: 'openslack-native',
      hash: 'hash123',
    });
    vi.mocked(TrustStore).mockImplementation(
      () =>
        ({
          rootDir: ROOT,
          get: vi.fn(() => 'untrusted'),
          set: vi.fn(),
          save: vi.fn(),
        }) as unknown as InstanceType<typeof TrustStore>,
    );

    const result = await executeWorkflowRun('risky-wf', 'run', ROOT, 'tui-user');

    expect(result.success).toBe(false);
    expect(result.message).toContain('untrusted');
  });

  it('run mode returns pause message on WorkflowPausedError', async () => {
    const {
      findWorkflow,
      loadWorkflow,
      executeDryRun,
      executeWorkflowThroughRunner,
      WorkflowPausedError,
    } = await import('@openslack/workflows');
    vi.mocked(findWorkflow).mockResolvedValue({
      path: '/test/wf.js',
      name: 'test-wf',
      source: 'openslack-project',
    });
    vi.mocked(loadWorkflow).mockResolvedValue({
      meta: {
        name: 'test-wf',
        description: 'Test',
        phases: [{ title: 'Scan', detail: 'Scan' }],
        risk: 'low',
      },
      format: 'openslack-native',
      hash: 'hash123',
      sourceSnapshot: createWorkflowSourceSnapshot(new Uint8Array([1, 2, 3]), {
        name: 'test-wf',
        description: 'Test',
        phases: [{ title: 'Scan', detail: 'Scan' }],
        risk: 'low',
      }),
    });
    vi.mocked(executeDryRun).mockResolvedValue({
      dryRun: true,
      runId: 'dryrun-001',
      workflowName: 'test-wf',
      simulatedEffects: [],
      errors: [],
    });
    vi.mocked(executeWorkflowThroughRunner).mockImplementation(() => {
      throw new WorkflowPausedError('openslack.task.checkout', 'Checkout', 'run-001');
    });

    const result = await executeWorkflowRun('test-wf', 'run', ROOT);

    expect(result.success).toBe(false);
    expect(result.message).toContain('paused');
    expect(result.message).toContain('openslack.task.checkout');
    expect(result.data).toMatchObject({ runId: 'run-001', operation: 'openslack.task.checkout' });
  });
});

// ── executeApproval workflow-effect with runId ───────────────────────────────────

describe('executeApproval workflow-effect with runId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['approve', true],
    ['reject', false],
  ])('retires the legacy TypeScript %s mutation path', async (_label, approved) => {
    const result = await executeApproval(
      {
        id: 'run-001',
        category: 'workflow-effect',
        title: 'Paused workflow',
        runId: 'run-001',
        workflowName: 'test-wf',
      },
      approved,
      ROOT,
      'tui-user',
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('TypeScript workflow mutation is retired');
    expect(result.data).toMatchObject({
      runId: 'run-001',
      code: 'WORKFLOW_RUNNER_CONTROL_TS_MUTATION_RETIRED',
    });
    expect(collaboration.recordDecision).not.toHaveBeenCalled();
  });
});

// ── conversation-first workbench ask handlers ─────────────────────────────────

describe('conversation-first workbench ask handlers', () => {
  let tempRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempRoot = mkdtempSync(join(tmpdir(), 'openslack-tui-ask-'));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('creates a workbench thread and records user ask plus plan summary', async () => {
    const result = await submitWorkbenchAskFromTui('check status', tempRoot, 'tui-user');

    expect(result.status).toBe('planned');
    expect(result.threadId).toMatch(/^CONV-/);
    expect(result.message).toContain('status');
    expect(result.cards.some((card) => card.route === 'status')).toBe(true);

    const stored = collaboration.getThread(result.threadId, tempRoot);
    expect(stored?.thread.title).toBe('OpenSlack Workbench Session');
    expect(stored?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'user_message',
          authorId: 'tui-user',
          text: 'check status',
        }),
        expect.objectContaining({
          kind: 'plan',
          authorId: 'openslack',
          planId: `tui-${result.threadId}-plan-2`,
          steps: expect.arrayContaining([expect.stringContaining('status')]),
        }),
      ]),
    );
  });

  it('routes workbench planning through the supplied application registries', async () => {
    const createStep = vi.fn((...args: Parameters<ActionRegistryPort['createStep']>) =>
      operator.BUILTIN_ACTION_REGISTRY.createStep(...args),
    );
    const actionRegistry = {
      list: () => operator.BUILTIN_ACTION_REGISTRY.list(),
      get: (actionId: string) => operator.BUILTIN_ACTION_REGISTRY.get(actionId),
      createStep,
      revalidateStep: (value: unknown) => operator.BUILTIN_ACTION_REGISTRY.revalidateStep(value),
      buildPlanSteps: (...args: Parameters<ActionRegistryPort['buildPlanSteps']>) =>
        operator.BUILTIN_ACTION_REGISTRY.buildPlanSteps(...args),
    } satisfies ActionRegistryPort;

    const result = await submitWorkbenchAskFromTui(
      'check status',
      tempRoot,
      'tui-user',
      undefined,
      {
        actionRegistry,
        llmProviderRegistry: operator.createLLMPlannerProviderRegistry(),
      },
    );

    expect(result.status).toBe('planned');
    expect(result.cards).toContainEqual(expect.objectContaining({ route: 'status' }));
    expect(createStep).toHaveBeenCalledWith('status.show', {}, 's1');
  });

  it('does not create a workbench thread for empty input', async () => {
    const result = await submitWorkbenchAskFromTui('   ', tempRoot, 'tui-user');

    expect(result.status).toBe('error');
    expect(collaboration.listThreads({ rootDir: tempRoot })).toHaveLength(0);
  });

  it('records action card execution and links referenced objects', async () => {
    const ask = await submitWorkbenchAskFromTui('PR #42 status', tempRoot, 'tui-user');
    expect(ask.cards).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: 'openslack pr status 42' })]),
    );
    const card = ask.cards.find((item) => item.linkedObject?.kind === 'pr');
    expect(card).toBeDefined();

    const result = await recordWorkbenchActionFromTui(
      ask.threadId,
      card!,
      'Use: openslack pr status 42',
      tempRoot,
      'tui-user',
    );

    expect(result.success).toBe(true);
    const stored = collaboration.getThread(ask.threadId, tempRoot);
    expect(stored?.thread.linkedObjects).toContainEqual({ kind: 'pr', id: '42' });
    expect(stored?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool_event',
          toolName: 'tui.action_card',
          input: expect.objectContaining({ id: card!.id, kind: card!.kind }),
          output: expect.objectContaining({ message: 'Use: openslack pr status 42' }),
        }),
      ]),
    );
  });

  it('records missing subagent mentions as user messages without dispatching', async () => {
    const result = await submitWorkbenchAskFromTui(
      '@missing-agent review PR #42',
      tempRoot,
      'tui-user',
    );

    expect(result.status).toBe('recorded');
    expect(result.cards).toHaveLength(0);
    expect(result.message).toContain('Agent "missing-agent" not found');

    const stored = collaboration.getThread(result.threadId, tempRoot);
    expect(stored?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'user_message',
          text: '@missing-agent review PR #42',
        }),
      ]),
    );
  });

  it('surfaces an unconfigured agent runtime as an error without a mock response', async () => {
    const registryDir = join(tempRoot, '.openslack', 'agents', 'registry');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      join(registryDir, 'unconfigured-agent.yaml'),
      [
        'schema: openslack.agent_registry.v1',
        'agent_id: unconfigured-agent',
        'vendor:',
        '  provider: anthropic',
        '  model: test-model',
      ].join('\n'),
      'utf-8',
    );

    const result = await submitWorkbenchAskFromTui(
      '@unconfigured-agent review PR #42',
      tempRoot,
      'tui-user',
    );

    expect(result.status).toBe('error');
    expect(result.message).toContain('[RUNTIME_NOT_CONFIGURED]');
    expect(result.cards).toEqual([expect.objectContaining({ kind: 'agent_run' })]);
    const stored = collaboration.getThread(result.threadId, tempRoot);
    expect(stored?.messages.filter((message) => message.kind === 'user_message')).toHaveLength(1);
    expect(stored?.messages.filter((message) => message.kind === 'agent_response')).toHaveLength(0);
  });
});

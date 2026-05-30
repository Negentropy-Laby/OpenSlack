import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeApproval, executeTrustChange, executeWorkflowRun } from '../commands/tui-executors.js'
import type { ApprovalExecutionParams } from '../commands/tui-executors.js'
import { TrustStore } from '@openslack/workflows'
import * as operator from '@openslack/operator'
import * as collaboration from '@openslack/collaboration'
import * as pr from '@openslack/pr'

// ── Module-level mocks ──────────────────────────────────────────────────────────

vi.mock('@openslack/operator', () => ({
  updatePendingPlanState: vi.fn(),
  listPendingPlans: vi.fn(),
}))

vi.mock('@openslack/collaboration', () => ({
  recordDecision: vi.fn(),
  listHandoffs: vi.fn(() => []),
}))

vi.mock('@openslack/pr', () => ({
  mergeIfReady: vi.fn(),
}))

vi.mock('@openslack/workflows', async () => {
  const actual = await vi.importActual<typeof import('@openslack/workflows')>('@openslack/workflows')
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
    executeRun: vi.fn(),
    executeResume: vi.fn(),
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
    WorkflowPausedError: class WorkflowPausedError extends Error {
      readonly operation: string
      readonly runId: string
      constructor(operation: string, _detail: string, runId: string) {
        super(`Workflow paused: ${operation}`)
        this.name = 'WorkflowPausedError'
        this.operation = operation
        this.runId = runId
      }
    },
    hashString: vi.fn(() => 'hashed-input'),
    RunStore: vi.fn(() => ({
      loadPendingApprovals: vi.fn(() => []),
      resolvePendingApproval: vi.fn(),
      transitionStatus: vi.fn(),
      loadMeta: vi.fn(),
      listRunsByStatus: vi.fn(() => []),
    })),
  }
})

// ── Constants ──────────────────────────────────────────────────────────────────

const ROOT = '/test/root'

// ── Helpers ─────────────────────────────────────────────────────────────────────

function planParams(overrides?: Partial<ApprovalExecutionParams>): ApprovalExecutionParams {
  return {
    id: 'ITEM-1',
    category: 'plan',
    title: 'Test Plan',
    planId: 'PLAN-1',
    ...overrides,
  }
}

function mergeParams(overrides?: Partial<ApprovalExecutionParams>): ApprovalExecutionParams {
  return {
    id: 'ITEM-2',
    category: 'merge-request',
    title: 'Merge PR #42',
    prNumber: 42,
    ...overrides,
  }
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
  }
}

function githubReviewParams(overrides?: Partial<ApprovalExecutionParams>): ApprovalExecutionParams {
  return {
    id: 'ITEM-4',
    category: 'github-review',
    title: 'Approve PR #99',
    ...overrides,
  }
}

// ── executeApproval ─────────────────────────────────────────────────────────────

describe('executeApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Plan category ──────────────────────────────────────────────────────────

  describe('plan category', () => {
    it('plan approve - updates state and records decision', async () => {
      vi.mocked(operator.updatePendingPlanState).mockReturnValue({ planId: 'PLAN-1', state: 'approved' } as unknown as ReturnType<typeof operator.updatePendingPlanState>)

      const result = await executeApproval(planParams(), true, ROOT, 'tui-user')

      expect(result.success).toBe(true)
      expect(result.message).toContain('PLAN-1')
      expect(result.message).toContain('approved')
      expect(operator.updatePendingPlanState).toHaveBeenCalledWith('PLAN-1', 'approved', ROOT)
      expect(collaboration.recordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'Test Plan',
          decision: 'approved',
          decidedBy: 'tui-user',
          tags: expect.arrayContaining(['plan-approval', 'tui']),
        }),
      )
    })

    it('plan reject - cancels plan and records decision', async () => {
      vi.mocked(operator.updatePendingPlanState).mockReturnValue({ planId: 'PLAN-1', state: 'cancelled' } as unknown as ReturnType<typeof operator.updatePendingPlanState>)

      const result = await executeApproval(planParams(), false, ROOT, 'tui-user')

      expect(result.success).toBe(true)
      expect(result.message).toContain('rejected')
      expect(operator.updatePendingPlanState).toHaveBeenCalledWith('PLAN-1', 'cancelled', ROOT)
      expect(collaboration.recordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'rejected',
          rationale: expect.stringContaining('Rejected'),
        }),
      )
    })

    it('plan not found - returns failure', async () => {
      vi.mocked(operator.updatePendingPlanState).mockReturnValue(null)

      const result = await executeApproval(planParams(), true, ROOT, 'tui-user')

      expect(result.success).toBe(false)
      expect(result.message).toContain('not found')
      expect(collaboration.recordDecision).not.toHaveBeenCalled()
    })

    it('plan without planId - returns failure', async () => {
      const result = await executeApproval(planParams({ planId: undefined }), true, ROOT, 'tui-user')

      expect(result.success).toBe(false)
      expect(result.message).toContain('Plan ID not available')
      expect(operator.updatePendingPlanState).not.toHaveBeenCalled()
    })

    it('handles API errors gracefully', async () => {
      vi.mocked(operator.updatePendingPlanState).mockImplementation(() => {
        throw new Error('disk full')
      })

      const result = await executeApproval(planParams(), true, ROOT, 'tui-user')

      expect(result.success).toBe(false)
      expect(result.message).toContain('disk full')
    })
  })

  // ── Merge-request category ─────────────────────────────────────────────────

  describe('merge-request category', () => {
    it('merge-request approve - calls mergeIfReady', async () => {
      vi.mocked(pr.mergeIfReady).mockResolvedValue({
        merged: true,
        decision: 'MERGED',
        reason: 'ok',
        message: 'Merged successfully',
        sha: 'abc123',
      })

      const result = await executeApproval(mergeParams(), true, ROOT, 'tui-user')

      expect(result.success).toBe(true)
      expect(result.data?.sha).toBe('abc123')
      expect(pr.mergeIfReady).toHaveBeenCalledWith(42, {
        no_auto_approval: true,
        no_self_review: true,
        red_zone_human_required: true,
        black_zone_never_merge: true,
      })
      expect(collaboration.recordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'Merge PR #42',
          decision: 'approved',
          tags: expect.arrayContaining(['merge-request', 'tui', 'pr-42']),
        }),
      )
    })

    it('merge-request approve - merge blocked returns failure', async () => {
      vi.mocked(pr.mergeIfReady).mockResolvedValue({
        merged: false,
        decision: 'BLOCKED' as unknown as 'approved',
        reason: 'checks failed',
        message: 'Blocked',
      } as unknown as Awaited<ReturnType<typeof pr.mergeIfReady>>)

      const result = await executeApproval(mergeParams(), true, ROOT, 'tui-user')

      expect(result.success).toBe(false)
      expect(result.message).toContain('Merge blocked')
      expect(result.message).toContain('checks failed')
      expect(collaboration.recordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'blocked',
          rationale: 'checks failed',
        }),
      )
    })

    it('merge-request reject - records cancelled decision', async () => {
      const result = await executeApproval(mergeParams(), false, ROOT, 'tui-user')

      expect(result.success).toBe(true)
      expect(result.message).toContain('rejected')
      expect(pr.mergeIfReady).not.toHaveBeenCalled()
      expect(collaboration.recordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'cancelled',
          rationale: expect.stringContaining('rejected via TUI'),
        }),
      )
    })

    it('merge-request without prNumber - returns failure', async () => {
      const result = await executeApproval(mergeParams({ prNumber: undefined }), true, ROOT, 'tui-user')

      expect(result.success).toBe(false)
      expect(result.message).toContain('PR number not available')
      expect(pr.mergeIfReady).not.toHaveBeenCalled()
    })
  })

  // ── Workflow-effect category ───────────────────────────────────────────────

  describe('workflow-effect category', () => {
    it('workflow-effect confirm - records decision', async () => {
      const result = await executeApproval(workflowEffectParams(), true, ROOT, 'tui-user')

      expect(result.success).toBe(true)
      expect(result.message).toContain('confirmed')
      expect(collaboration.recordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'Deploy to staging',
          decision: 'confirmed',
          rationale: expect.stringContaining('confirmed via TUI'),
          tags: expect.arrayContaining(['workflow-effect', 'tui']),
        }),
      )
    })

    it('workflow-effect cancel - records decision', async () => {
      const result = await executeApproval(workflowEffectParams(), false, ROOT, 'tui-user')

      expect(result.success).toBe(true)
      expect(result.message).toContain('cancelled')
      expect(collaboration.recordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'cancelled',
          rationale: expect.stringContaining('cancelled via TUI'),
        }),
      )
    })

    it('workflow-effect includes workflowName in rationale when present', async () => {
      await executeApproval(workflowEffectParams(), true, ROOT, 'tui-user')

      expect(collaboration.recordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          rationale: expect.stringContaining('for deploy-staging'),
        }),
      )
    })

    it('workflow-effect omits workflow name from rationale when absent', async () => {
      await executeApproval(workflowEffectParams({ workflowName: undefined }), true, ROOT, 'tui-user')

      const call = vi.mocked(collaboration.recordDecision).mock.calls[0][0] as { rationale: string }
      expect(call.rationale).not.toContain('for undefined')
    })
  })

  // ── GitHub-review category ─────────────────────────────────────────────────

  describe('github-review category', () => {
    it('github-review always returns CLI fallback', async () => {
      const result = await executeApproval(githubReviewParams(), true, ROOT, 'tui-user')

      expect(result.success).toBe(false)
      expect(result.message).toContain('GitHub PR approval requires human GitHub identity')
      expect(result.data?.cliCommand).toContain('gh pr review')
    })
  })
})

// ── executeTrustChange ───────────────────────────────────────────────────────────

describe('executeTrustChange', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('changes trust level successfully', async () => {
    const result = await executeTrustChange('my-workflow', 'untrusted', 'trusted', ROOT)

    expect(result.success).toBe(true)
    expect(result.message).toContain('my-workflow')
    expect(result.message).toContain('untrusted')
    expect(result.message).toContain('trusted')
    expect(vi.mocked(TrustStore).mock.results[0].value.set).toHaveBeenCalledWith('my-workflow', 'trusted')
    expect(vi.mocked(TrustStore).mock.results[0].value.save).toHaveBeenCalled()
    expect(TrustStore).toHaveBeenCalledWith({ rootDir: ROOT })
  })

  it('rejects core workflows', async () => {
    const result = await executeTrustChange('system-critical', 'core', 'trusted', ROOT)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Protected workflows')
  })

  it('rejects builtin workflows', async () => {
    const result = await executeTrustChange('builtin-checks', 'builtin', 'trusted', ROOT)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Protected workflows')
  })

  it('handles save errors', async () => {
    const { TrustStore: MockedTrustStore } = await import('@openslack/workflows')
    vi.mocked(MockedTrustStore).mockImplementation(() => (({
      rootDir: ROOT,
      get: vi.fn(() => 'untrusted'),
      set: vi.fn(),
      save: vi.fn(() => { throw new Error('permission denied') }),
    }) as unknown as InstanceType<typeof MockedTrustStore>))

    const result = await executeTrustChange('my-workflow', 'untrusted', 'trusted', ROOT)

    expect(result.success).toBe(false)
    expect(result.message).toContain('permission denied')
  })
})

// ── executeWorkflowRun ───────────────────────────────────────────────────────────

describe('executeWorkflowRun', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns not found for missing workflow', async () => {
    const result = await executeWorkflowRun('deploy-production', 'preview', process.cwd())

    expect(result.success).toBe(false)
    expect(result.message).toContain('not found')
  })

  it('returns not found for missing workflow in dry-run mode', async () => {
    const result = await executeWorkflowRun('deploy-production', 'dry-run', process.cwd())

    expect(result.success).toBe(false)
    expect(result.message).toContain('not found')
  })

  it('returns not found for missing workflow in run mode', async () => {
    const result = await executeWorkflowRun('deploy-production', 'run', process.cwd())

    expect(result.success).toBe(false)
    expect(result.message).toContain('not found')
  })

  it('run mode builds manifest and passes confirmationPolicy', async () => {
    const { findWorkflow, loadWorkflow, executeDryRun, executeRun, buildApprovalManifest, TrustStore } = await import('@openslack/workflows')
    vi.mocked(findWorkflow).mockResolvedValue({ path: '/test/wf.js', name: 'test-wf', source: 'openslack-project' })
    vi.mocked(loadWorkflow).mockResolvedValue({
      meta: { name: 'test-wf', description: 'Test', phases: [{ title: 'Scan', detail: 'Scan' }], risk: 'medium' },
      format: 'openslack-native',
      hash: 'hash123',
    })
    vi.mocked(TrustStore).mockImplementation(() => ({
      rootDir: ROOT,
      get: vi.fn(() => 'trusted'),
      set: vi.fn(),
      save: vi.fn(),
    }) as unknown as InstanceType<typeof TrustStore>)
    vi.mocked(executeDryRun).mockResolvedValue({
      dryRun: true,
      runId: 'dryrun-001',
      workflowName: 'test-wf',
      simulatedEffects: [{ operation: 'openslack.task.createIssue', detail: 'Create issue', timestamp: '2026-01-01T00:00:00Z' }],
      errors: [],
    })
    vi.mocked(executeRun).mockResolvedValue({ status: 'completed' })

    const result = await executeWorkflowRun('test-wf', 'run', ROOT)

    expect(result.success).toBe(true)
    expect(executeDryRun).toHaveBeenCalled()
    expect(buildApprovalManifest).toHaveBeenCalled()
    expect(executeRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        confirmationPolicy: expect.objectContaining({
          mode: 'preapproved-manifest',
          onUnexpectedEffect: 'pause',
        }),
      }),
    )
  })

  it('run mode rejects untrusted high-risk workflow', async () => {
    const { findWorkflow, loadWorkflow, TrustStore } = await import('@openslack/workflows')
    vi.mocked(findWorkflow).mockResolvedValue({ path: '/test/wf.js', name: 'risky-wf', source: 'openslack-project' })
    vi.mocked(loadWorkflow).mockResolvedValue({
      meta: { name: 'risky-wf', description: 'Risky', phases: [{ title: 'Scan', detail: 'Scan' }], risk: 'high' },
      format: 'openslack-native',
      hash: 'hash123',
    })
    vi.mocked(TrustStore).mockImplementation(() => ({
      rootDir: ROOT,
      get: vi.fn(() => 'untrusted'),
      set: vi.fn(),
      save: vi.fn(),
    }) as unknown as InstanceType<typeof TrustStore>)

    const result = await executeWorkflowRun('risky-wf', 'run', ROOT, 'tui-user')

    expect(result.success).toBe(false)
    expect(result.message).toContain('untrusted')
  })

  it('run mode returns pause message on WorkflowPausedError', async () => {
    const { findWorkflow, loadWorkflow, executeDryRun, executeRun, WorkflowPausedError } = await import('@openslack/workflows')
    vi.mocked(findWorkflow).mockResolvedValue({ path: '/test/wf.js', name: 'test-wf', source: 'openslack-project' })
    vi.mocked(loadWorkflow).mockResolvedValue({
      meta: { name: 'test-wf', description: 'Test', phases: [{ title: 'Scan', detail: 'Scan' }], risk: 'low' },
      format: 'openslack-native',
      hash: 'hash123',
    })
    vi.mocked(executeDryRun).mockResolvedValue({
      dryRun: true,
      runId: 'dryrun-001',
      workflowName: 'test-wf',
      simulatedEffects: [],
      errors: [],
    })
    vi.mocked(executeRun).mockImplementation(() => {
      throw new WorkflowPausedError('openslack.task.checkout', 'Checkout', 'run-001')
    })

    const result = await executeWorkflowRun('test-wf', 'run', ROOT)

    expect(result.success).toBe(false)
    expect(result.message).toContain('paused')
    expect(result.message).toContain('openslack.task.checkout')
    expect(result.data).toMatchObject({ runId: 'run-001', operation: 'openslack.task.checkout' })
  })
})

// ── executeApproval workflow-effect with runId ───────────────────────────────────

describe('executeApproval workflow-effect with runId', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('approves and resumes paused workflow', async () => {
    const { RunStore, findWorkflow, loadWorkflow, executeResume } = await import('@openslack/workflows')
    const mockStore = {
      loadPendingApprovals: vi.fn(() => [
        { id: 'appr-1', operation: 'openslack.task.createIssue', detail: 'Create issue', timestamp: '2026-01-01T00:00:00Z', status: 'pending' },
      ]),
      resolvePendingApproval: vi.fn(),
      transitionStatus: vi.fn(),
      loadMeta: vi.fn(() => ({ runId: 'run-001', workflowName: 'test-wf', mode: 'execute', manifestHash: 'abc', args: {}, startedAt: '2026-01-01T00:00:00Z' })),
    }
    vi.mocked(RunStore).mockImplementation(() => mockStore as unknown as InstanceType<typeof RunStore>)
    vi.mocked(findWorkflow).mockResolvedValue({ path: '/test/wf.js', name: 'test-wf', source: 'openslack-project' })
    vi.mocked(loadWorkflow).mockResolvedValue({
      meta: { name: 'test-wf', description: 'Test', phases: [{ title: 'Scan', detail: 'Scan' }] },
      format: 'openslack-native',
      hash: 'hash123',
    })
    vi.mocked(executeResume).mockResolvedValue({ status: 'completed' })

    const result = await executeApproval(
      { id: 'run-001', category: 'workflow-effect', title: 'Paused workflow', runId: 'run-001', workflowName: 'test-wf' },
      true,
      ROOT,
      'tui-user',
    )

    expect(result.success).toBe(true)
    expect(result.message).toContain('resumed')
    expect(mockStore.resolvePendingApproval).toHaveBeenCalledWith('run-001', 'appr-1', 'approved')
    expect(collaboration.recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'approved',
        tags: expect.arrayContaining(['workflow-effect', 'tui', 'run-run-001']),
      }),
    )
  })

  it('rejects and cancels paused workflow', async () => {
    const { RunStore } = await import('@openslack/workflows')
    const mockStore = {
      loadPendingApprovals: vi.fn(() => [
        { id: 'appr-1', operation: 'openslack.task.createIssue', detail: 'Create issue', timestamp: '2026-01-01T00:00:00Z', status: 'pending' },
      ]),
      resolvePendingApproval: vi.fn(),
      transitionStatus: vi.fn(),
    }
    vi.mocked(RunStore).mockImplementation(() => mockStore as unknown as InstanceType<typeof RunStore>)

    const result = await executeApproval(
      { id: 'run-001', category: 'workflow-effect', title: 'Paused workflow', runId: 'run-001', workflowName: 'test-wf' },
      false,
      ROOT,
      'tui-user',
    )

    expect(result.success).toBe(true)
    expect(result.message).toContain('cancelled')
    expect(mockStore.resolvePendingApproval).toHaveBeenCalledWith('run-001', 'appr-1', 'rejected')
    expect(mockStore.transitionStatus).toHaveBeenCalledWith('run-001', 'cancelled')
    expect(collaboration.recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'cancelled',
        tags: expect.arrayContaining(['workflow-effect', 'tui', 'run-run-001']),
      }),
    )
  })
})

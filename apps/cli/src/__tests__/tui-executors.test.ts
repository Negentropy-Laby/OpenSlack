import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeApproval, executeTrustChange, executeWorkflowRun } from '../commands/tui-executors.js'
import type { ApprovalExecutionParams } from '../commands/tui-executors.js'
import { TrustStore } from '@openslack/workflows'

// ── Module-level mocks ──────────────────────────────────────────────────────────

const mockUpdatePendingPlanState = vi.fn()
const mockListPendingPlans = vi.fn()
const mockRecordDecision = vi.fn()
const mockListHandoffs = vi.fn(() => [])
const mockMergeIfReady = vi.fn()
const mockTrustStoreGet = vi.fn(() => 'untrusted')
const mockTrustStoreSet = vi.fn()
const mockTrustStoreSave = vi.fn()

vi.mock('@openslack/operator', () => ({
  updatePendingPlanState: mockUpdatePendingPlanState,
  listPendingPlans: mockListPendingPlans,
}))

vi.mock('@openslack/collaboration', () => ({
  recordDecision: mockRecordDecision,
  listHandoffs: mockListHandoffs,
}))

vi.mock('@openslack/pr', () => ({
  mergeIfReady: mockMergeIfReady,
}))

vi.mock('@openslack/workflows', () => ({
  TrustStore: vi.fn((opts: { rootDir: string }) => ({
    rootDir: opts.rootDir,
    get: mockTrustStoreGet,
    set: mockTrustStoreSet,
    save: mockTrustStoreSave,
  })),
}))

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
      mockUpdatePendingPlanState.mockReturnValue({ planId: 'PLAN-1', state: 'approved' })

      const result = await executeApproval(planParams(), true, ROOT)

      expect(result.success).toBe(true)
      expect(result.message).toContain('PLAN-1')
      expect(result.message).toContain('approved')
      expect(mockUpdatePendingPlanState).toHaveBeenCalledWith('PLAN-1', 'approved', ROOT)
      expect(mockRecordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'Test Plan',
          decision: 'approved',
          decidedBy: 'tui-user',
          tags: expect.arrayContaining(['plan-approval', 'tui']),
        }),
      )
    })

    it('plan reject - cancels plan and records decision', async () => {
      mockUpdatePendingPlanState.mockReturnValue({ planId: 'PLAN-1', state: 'cancelled' })

      const result = await executeApproval(planParams(), false, ROOT)

      expect(result.success).toBe(true)
      expect(result.message).toContain('rejected')
      expect(mockUpdatePendingPlanState).toHaveBeenCalledWith('PLAN-1', 'cancelled', ROOT)
      expect(mockRecordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'rejected',
          rationale: expect.stringContaining('Rejected'),
        }),
      )
    })

    it('plan not found - returns failure', async () => {
      mockUpdatePendingPlanState.mockReturnValue(null)

      const result = await executeApproval(planParams(), true, ROOT)

      expect(result.success).toBe(false)
      expect(result.message).toContain('not found')
      expect(mockRecordDecision).not.toHaveBeenCalled()
    })

    it('plan without planId - returns failure', async () => {
      const result = await executeApproval(planParams({ planId: undefined }), true, ROOT)

      expect(result.success).toBe(false)
      expect(result.message).toContain('Plan ID not available')
      expect(mockUpdatePendingPlanState).not.toHaveBeenCalled()
    })

    it('handles API errors gracefully', async () => {
      mockUpdatePendingPlanState.mockImplementation(() => {
        throw new Error('disk full')
      })

      const result = await executeApproval(planParams(), true, ROOT)

      expect(result.success).toBe(false)
      expect(result.message).toContain('disk full')
    })
  })

  // ── Merge-request category ─────────────────────────────────────────────────

  describe('merge-request category', () => {
    it('merge-request approve - calls mergeIfReady', async () => {
      mockMergeIfReady.mockResolvedValue({
        merged: true,
        decision: 'MERGED',
        reason: 'ok',
        message: 'Merged successfully',
        sha: 'abc123',
      })

      const result = await executeApproval(mergeParams(), true, ROOT)

      expect(result.success).toBe(true)
      expect(result.data?.sha).toBe('abc123')
      expect(mockMergeIfReady).toHaveBeenCalledWith(42, {
        no_auto_approval: true,
        no_self_review: true,
        red_zone_human_required: true,
        black_zone_never_merge: true,
      })
      expect(mockRecordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'Merge PR #42',
          decision: 'approved',
          tags: expect.arrayContaining(['merge-request', 'tui', 'pr-42']),
        }),
      )
    })

    it('merge-request approve - merge blocked returns failure', async () => {
      mockMergeIfReady.mockResolvedValue({
        merged: false,
        decision: 'BLOCKED',
        reason: 'checks failed',
        message: 'Blocked',
      })

      const result = await executeApproval(mergeParams(), true, ROOT)

      expect(result.success).toBe(false)
      expect(result.message).toContain('Merge blocked')
      expect(result.message).toContain('checks failed')
      expect(mockRecordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'blocked',
          rationale: 'checks failed',
        }),
      )
    })

    it('merge-request reject - records cancelled decision', async () => {
      const result = await executeApproval(mergeParams(), false, ROOT)

      expect(result.success).toBe(true)
      expect(result.message).toContain('rejected')
      expect(mockMergeIfReady).not.toHaveBeenCalled()
      expect(mockRecordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'cancelled',
          rationale: expect.stringContaining('rejected via TUI'),
        }),
      )
    })

    it('merge-request without prNumber - returns failure', async () => {
      const result = await executeApproval(mergeParams({ prNumber: undefined }), true, ROOT)

      expect(result.success).toBe(false)
      expect(result.message).toContain('PR number not available')
      expect(mockMergeIfReady).not.toHaveBeenCalled()
    })
  })

  // ── Workflow-effect category ───────────────────────────────────────────────

  describe('workflow-effect category', () => {
    it('workflow-effect confirm - records decision', async () => {
      const result = await executeApproval(workflowEffectParams(), true, ROOT)

      expect(result.success).toBe(true)
      expect(result.message).toContain('confirmed')
      expect(mockRecordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'Deploy to staging',
          decision: 'confirmed',
          rationale: expect.stringContaining('confirmed via TUI'),
          tags: expect.arrayContaining(['workflow-effect', 'tui']),
        }),
      )
    })

    it('workflow-effect cancel - records decision', async () => {
      const result = await executeApproval(workflowEffectParams(), false, ROOT)

      expect(result.success).toBe(true)
      expect(result.message).toContain('cancelled')
      expect(mockRecordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'cancelled',
          rationale: expect.stringContaining('cancelled via TUI'),
        }),
      )
    })

    it('workflow-effect includes workflowName in rationale when present', async () => {
      await executeApproval(workflowEffectParams(), true, ROOT)

      expect(mockRecordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          rationale: expect.stringContaining('for deploy-staging'),
        }),
      )
    })

    it('workflow-effect omits workflow name from rationale when absent', async () => {
      await executeApproval(workflowEffectParams({ workflowName: undefined }), true, ROOT)

      const call = mockRecordDecision.mock.calls[0][0] as { rationale: string }
      expect(call.rationale).not.toContain('for undefined')
    })
  })

  // ── GitHub-review category ─────────────────────────────────────────────────

  describe('github-review category', () => {
    it('github-review always returns CLI fallback', async () => {
      const result = await executeApproval(githubReviewParams(), true, ROOT)

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
    expect(mockTrustStoreSet).toHaveBeenCalledWith('my-workflow', 'trusted')
    expect(mockTrustStoreSave).toHaveBeenCalled()
    expect(vi.mocked(TrustStore)).toHaveBeenCalledWith({ rootDir: ROOT })
  })

  it('rejects core workflows', async () => {
    const result = await executeTrustChange('system-critical', 'core', 'trusted', ROOT)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Protected workflows')
    expect(mockTrustStoreSet).not.toHaveBeenCalled()
    expect(mockTrustStoreSave).not.toHaveBeenCalled()
  })

  it('rejects builtin workflows', async () => {
    const result = await executeTrustChange('builtin-checks', 'builtin', 'trusted', ROOT)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Protected workflows')
    expect(mockTrustStoreSet).not.toHaveBeenCalled()
    expect(mockTrustStoreSave).not.toHaveBeenCalled()
  })

  it('handles save errors', async () => {
    mockTrustStoreSave.mockImplementation(() => {
      throw new Error('permission denied')
    })

    const result = await executeTrustChange('my-workflow', 'untrusted', 'trusted', ROOT)

    expect(result.success).toBe(false)
    expect(result.message).toContain('permission denied')
  })
})

// ── executeWorkflowRun ───────────────────────────────────────────────────────────

describe('executeWorkflowRun', () => {
  it('returns CLI fallback for P0', async () => {
    const result = await executeWorkflowRun('deploy-production')

    expect(result.success).toBe(false)
    expect(result.message).toContain('Workflow run requires full CLI execution context')
    expect(result.data?.cliCommand).toContain('openslack collaboration workflow run deploy-production')
  })
})

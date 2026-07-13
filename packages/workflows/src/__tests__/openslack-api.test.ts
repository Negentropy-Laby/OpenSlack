import { describe, it, expect, vi } from 'vitest'
import { createOpenSlackAPI } from '../openslack-api.js'
import type { PrmsDoctorResult } from '../types.js'
import type { PRReviewReport, PRReviewPolicy } from '@openslack/pr'

function makeAPI(overrides: Parameters<typeof createOpenSlackAPI>[0] = {}) {
  return createOpenSlackAPI(overrides)
}

const defaultPolicy: PRReviewPolicy = {
  no_auto_approval: true,
  no_self_review: true,
  red_zone_human_required: true,
  black_zone_never_merge: true,
}

function stubPRReport(overrides: Partial<PRReviewReport> = {}): PRReviewReport {
  return {
    prNumber: 1,
    title: 'Test PR',
    author: 'bot',
    state: 'open',
    draft: false,
    baseRef: 'main',
    baseSha: 'base-sha',
    riskZone: 'green',
    changedFiles: ['docs/readme.md'],
    checks: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
    reviews: [{ user: 'reviewer', state: 'APPROVED' }],
    humanApprovals: [{ user: 'reviewer' }],
    decision: 'DISCOVERED',
    reason: 'Initial',
    recommendation: 'Classify',
    mergeable: true,
    ...overrides,
  }
}

describe('createOpenSlackAPI', () => {
  describe('task namespace', () => {
    it('task.createPreview returns preview with data', async () => {
      const api = makeAPI()
      const result = await api.task.createPreview({ title: 'Test issue' })
      expect(result).toEqual({ preview: true, data: { title: 'Test issue' } })
    })

    it('task.createPreview works with any input', async () => {
      const api = makeAPI()
      const result = await api.task.createPreview(null)
      expect(result).toEqual({ preview: true, data: null })
    })

    it('task.checkout returns worktree path and branch name', async () => {
      const api = makeAPI()
      const result = await api.task.checkout(42, 'agent-007')
      expect(result.worktreePath).toContain('42')
      expect(result.branchName).toContain('42')
    })

    it('task.sync returns pushed status', async () => {
      const api = makeAPI()
      const result = await api.task.sync(42)
      expect(typeof result.pushed).toBe('boolean')
    })
  })

  describe('prms namespace', () => {
    it('prms.classify categorizes paths by risk zone', async () => {
      const api = makeAPI({
        _classifyPaths: () => ({
          green: ['docs/readme.md'],
          yellow: ['packages/core/src/index.ts'],
          red: ['.github/workflows/ci.yml'],
        }),
      })
      const result = await api.prms.classify([
        'docs/readme.md',
        'packages/core/src/index.ts',
        '.github/workflows/ci.yml',
      ])
      expect(result.green).toEqual(['docs/readme.md'])
      expect(result.yellow).toEqual(['packages/core/src/index.ts'])
      expect(result.red).toEqual(['.github/workflows/ci.yml'])
    })

    it('prms.classify delegates to real classifyPaths by default', async () => {
      const api = makeAPI()
      const result = await api.prms.classify(['docs/faq.md', 'new-root-config.yaml'])
      expect(result.green).toContain('docs/faq.md')
      expect(result.yellow).toContain('new-root-config.yaml')
    })

    it('prms.doctor returns READY_TO_MERGE when all gates pass', async () => {
      const api = makeAPI({
        _fetchPRDetails: async () => stubPRReport(),
        _diagnosePR: () => stubPRReport({
          decision: 'READY_TO_MERGE',
          reason: 'Green Zone. All checks passed.',
          recommendation: 'Safe to merge.',
          riskZone: 'green',
        }),
        _loadPRReviewPolicy: () => defaultPolicy,
        _loadPRCodeownerEvidence: async () => ({ ref: 'base-sha', owners: [], entries: [] }),
      })

      const result: PrmsDoctorResult = await api.prms.doctor(1)
      expect(result.status).toBe('READY_TO_MERGE')
      expect(result.zone).toBe('green')
      expect(result.why).toContain('Green Zone')
    })

    it('prms.doctor returns BLOCKED when checks fail', async () => {
      const api = makeAPI({
        _fetchPRDetails: async () => stubPRReport({
          riskZone: 'yellow',
          changedFiles: ['packages/core/src/index.ts'],
          checks: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
        }),
        _diagnosePR: () => stubPRReport({
          decision: 'CHECKS_FAILED',
          reason: 'Failing checks: ci',
          recommendation: 'Fix failing checks.',
          riskZone: 'yellow',
        }),
        _loadPRReviewPolicy: () => defaultPolicy,
        _loadPRCodeownerEvidence: async () => ({ ref: 'base-sha', owners: [], entries: [] }),
      })

      const result: PrmsDoctorResult = await api.prms.doctor(2)
      expect(result.status).toBe('BLOCKED')
      expect(result.blockers.length).toBeGreaterThan(0)
    })

    it('prms.doctor returns ERROR when an exception occurs', async () => {
      const api = makeAPI({
        _fetchPRDetails: async () => {
          throw new Error('Network failure')
        },
      })

      const result: PrmsDoctorResult = await api.prms.doctor(99)
      expect(result.status).toBe('ERROR')
      expect(result.why).toContain('Network failure')
      expect(result.zone).toBe('red')
    })

    it('prms.doctor gates map correctly for READY_TO_MERGE', async () => {
      const api = makeAPI({
        _fetchPRDetails: async () => stubPRReport(),
        _diagnosePR: () => stubPRReport({
          decision: 'READY_TO_MERGE',
          reason: 'All good',
          recommendation: 'Merge it',
          riskZone: 'green',
        }),
        _loadPRReviewPolicy: () => defaultPolicy,
        _loadPRCodeownerEvidence: async () => ({ ref: 'base-sha', owners: [], entries: [] }),
      })

      const result: PrmsDoctorResult = await api.prms.doctor(1)
      expect(result.gates.classification.passed).toBe(true)
      expect(result.gates.checks.passed).toBe(true)
      expect(result.gates.approval.passed).toBe(true)
      expect(result.gates.mergeability.passed).toBe(true)
    })

    it('prms.queue returns list of open PRs', async () => {
      const api = makeAPI({
        _listOpenPRs: async () => [
          { number: 1, title: 'Fix bug', status: 'open', author: 'dev', draft: false, updatedAt: '2026-05-28T00:00:00Z', url: 'https://github.com/test/pull/1' },
          { number: 2, title: 'Add feature', status: 'open', author: 'dev', draft: false, updatedAt: '2026-05-28T00:00:00Z', url: 'https://github.com/test/pull/2' },
        ],
      })

      const result = await api.prms.queue()
      expect(result).toHaveLength(2)
      expect(result[0].prNumber).toBe(1)
      expect(result[1].title).toBe('Add feature')
    })

    it('prms.queue returns empty array when no PRs', async () => {
      const api = makeAPI({
        _listOpenPRs: async () => [],
      })

      const result = await api.prms.queue()
      expect(result).toEqual([])
    })

    it('prms.requestMerge routes through PRMS Merge Steward', async () => {
      const mergeFn = vi.fn(async () => ({
        merged: true,
        decision: 'READY_TO_MERGE',
        reason: 'All gates passed',
        message: 'PR merged successfully.',
      }))

      const api = makeAPI({
        _loadPRReviewPolicy: () => defaultPolicy,
        _mergeIfReady: mergeFn,
      })

      const result = await api.prms.requestMerge(42)
      expect(mergeFn).toHaveBeenCalledWith(42, defaultPolicy)
      expect(result.merged).toBe(true)
      expect(result.prmsStatus).toBe('READY_TO_MERGE')
    })

    it('prms.requestMerge reports blocked status when steward blocks', async () => {
      const mergeFn = vi.fn(async () => ({
        merged: false,
        decision: 'BLOCKED',
        reason: 'Missing approval',
        message: 'Merge blocked: BLOCKED\nMissing approval',
      }))

      const api = makeAPI({
        _loadPRReviewPolicy: () => defaultPolicy,
        _mergeIfReady: mergeFn,
      })

      const result = await api.prms.requestMerge(10)
      expect(result.merged).toBe(false)
      expect(result.prmsStatus).toBe('BLOCKED')
    })
  })

  describe('collaboration namespace', () => {
    it('collaboration.recordEvent delegates to collaboration package', async () => {
      const recordFn = vi.fn()
      const api = makeAPI({ _recordEvent: recordFn })

      await api.collaboration.recordEvent({ type: 'task.created' })
      expect(recordFn).toHaveBeenCalledWith({ type: 'task.created' })
    })

    it('collaboration.createHandoff delegates to collaboration package', async () => {
      const handoffFn = vi.fn((d: unknown) => ({ id: 'H-001', ...d as object }))
      const api = makeAPI({ _createHandoff: handoffFn })

      const details = { from: 'agent-a', to: 'agent-b', context: 'handoff' }
      const result = await api.collaboration.createHandoff(details)
      expect(handoffFn).toHaveBeenCalledWith(details)
      expect(result).toEqual({ id: 'H-001', from: 'agent-a', to: 'agent-b', context: 'handoff' })
    })

    it('collaboration.recordDecision delegates to collaboration package', async () => {
      const decisionFn = vi.fn((d: unknown) => ({ id: 'D-001', ...d as object }))
      const api = makeAPI({ _recordDecision: decisionFn })

      const details = { topic: 'Architecture', decision: 'Use microservices' }
      const result = await api.collaboration.recordDecision(details)
      expect(decisionFn).toHaveBeenCalledWith(details)
      expect(result).toEqual({ id: 'D-001', topic: 'Architecture', decision: 'Use microservices' })
    })
  })

  describe('governance namespace', () => {
    it('governance.audit records an audit event', async () => {
      const recordFn = vi.fn()
      const api = makeAPI({ _recordEvent: recordFn })

      await api.governance.audit('github.merge', { pr: 42 })
      expect(recordFn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'governance.audit.passed',
          summary: 'Audit: github.merge',
          details: { pr: 42 },
        }),
      )
    })

    it('governance.audit works without details', async () => {
      const recordFn = vi.fn()
      const api = makeAPI({ _recordEvent: recordFn })

      await api.governance.audit('test.action')
      expect(recordFn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'governance.audit.passed',
          summary: 'Audit: test.action',
        }),
      )
    })
  })

  describe('dependency injection', () => {
    it('uses default implementations when no overrides provided', () => {
      const api = createOpenSlackAPI()
      expect(api).toBeDefined()
      expect(api.task).toBeDefined()
      expect(api.prms).toBeDefined()
      expect(api.collaboration).toBeDefined()
      expect(api.governance).toBeDefined()
    })

    it('all namespace methods are async functions', () => {
      const api = makeAPI()
      expect(typeof api.task.createPreview).toBe('function')
      expect(typeof api.task.createIssue).toBe('function')
      expect(typeof api.task.checkout).toBe('function')
      expect(typeof api.task.sync).toBe('function')
      expect(typeof api.prms.classify).toBe('function')
      expect(typeof api.prms.doctor).toBe('function')
      expect(typeof api.prms.queue).toBe('function')
      expect(typeof api.prms.requestMerge).toBe('function')
      expect(typeof api.collaboration.recordEvent).toBe('function')
      expect(typeof api.collaboration.createHandoff).toBe('function')
      expect(typeof api.collaboration.recordDecision).toBe('function')
      expect(typeof api.governance.audit).toBe('function')
    })
  })
})

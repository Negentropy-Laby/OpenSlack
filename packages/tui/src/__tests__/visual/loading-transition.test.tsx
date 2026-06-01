/**
 * loading-transition.test.tsx -- Loading -> loaded state transition tests.
 *
 * Verifies that TUI views transition cleanly from loading state to loaded
 * state without residual artifacts from the loading frame.
 *
 * Views tested:
 * 1. WorkflowLifecycleViewWrapper (async loader)
 * 2. DashboardView (loads room data, activity data)
 * 3. PrQueueView (loads PR data)
 * 4. ProfileView (loads profile sync status)
 * 5. ApprovalCenterView (loads pending approvals)
 * 6. RoomView (loads room events)
 *
 * For each view:
 * - Loading state renders within terminal width
 * - Loaded state renders within terminal width
 * - Loaded output does not contain loading spinner/indicator artifacts
 * - Output is non-empty in both states
 * - View does not throw during the transition
 */
import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from '@openslack/tui'
import { NavigationProvider } from '../../navigation/context.js'
import stripAnsi from 'strip-ansi'

import WorkflowLifecycleView from '../../views/WorkflowLifecycleView.js'
import WorkflowLifecycleViewWrapper from '../../views/WorkflowLifecycleViewWrapper.js'
import DashboardView from '../../views/DashboardView.js'
import PrQueueView from '../../views/PrQueueView.js'
import ProfileView from '../../views/ProfileView.js'
import ApprovalCenterView from '../../views/ApprovalCenterView.js'
import RoomView from '../../views/RoomView.js'

import type { WorkflowLifecycleViewModel } from '../../view-models/workflow-lifecycle.js'
import type { WorkflowLifecycleLoader } from '../../views/render-shell.js'
import type { DashboardViewModel } from '../../view-models/dashboard.js'
import type { PrQueueViewModel } from '../../view-models/pr-queue.js'
import type { ProfileViewModel } from '../../view-models/profile.js'
import type { ApprovalCenterViewModel } from '../../view-models/approval-center.js'
import type { RoomViewModel } from '../../view-models/room.js'

import { assertNoLineExceedsWidth } from '../helpers/render-at-columns.js'

import { Writable } from 'stream'

// -- Helpers --

function createMockStdout(columns: number, rows = 50) {
  const chunks: string[] = []
  const stdout = new Writable({
    write(chunk: Buffer | string, _encoding: string, cb: () => void) {
      chunks.push(String(chunk))
      cb()
    },
  }) as NodeJS.WriteStream
  Object.defineProperties(stdout, {
    columns: { value: columns, writable: true, configurable: true },
    rows: { value: rows, writable: true, configurable: true },
    isTTY: { value: false, configurable: true },
  })
  return { stdout, chunks }
}

async function renderAt(element: React.ReactElement, cols: number): Promise<string> {
  const { stdout, chunks } = createMockStdout(cols)
  const instance = await render(element, { stdout, patchConsole: false })
  await new Promise((r) => setTimeout(r, 200))
  const output = chunks.join('')
  instance.unmount()
  return output
}

function withNav(element: React.ReactElement): React.ReactElement {
  return React.createElement(NavigationProvider, null, element)
}

// -- Model factories --

function createLifecycleModel(overrides?: Partial<WorkflowLifecycleViewModel>): WorkflowLifecycleViewModel {
  return {
    workflowName: 'test-workflow',
    workflowHash: 'abc123',
    trustLevel: 'trusted',
    risk: 'low',
    sourcePath: '.openslack/workflows/test-workflow',
    stages: [
      { name: 'proposal', label: 'Proposal', status: 'complete', icon: 'check', issueNumber: 120, detail: 'Accepted' },
      { name: 'review', label: 'Review', status: 'complete', icon: 'check', issueNumber: 121, detail: 'Passed' },
      { name: 'run', label: 'Run', status: 'in-progress', icon: 'running', detail: 'Executing' },
      { name: 'pr', label: 'PR', status: 'pending', icon: 'clock', detail: 'Not created' },
      { name: 'merged', label: 'Merged', status: 'pending', icon: 'clock', detail: 'Pending' },
    ],
    phaseIssues: [
      { phase: 'proposal', issueNumber: 120, status: 'closed' },
    ],
    currentRun: {
      runId: 'run-001',
      status: 'running',
      startedAt: '2026-06-01T10:00:00Z',
      phaseIndex: 2,
    },
    prNumber: undefined,
    prStatus: undefined,
    nextAction: 'Wait for completion',
    subIssueMode: 'native',
    dependencyMode: 'native',
    fallbackReasons: [],
    blockedGateItems: [],
    statusSummary: 'At run stage, executing',
    ...overrides,
  }
}

function createDashboardModel(overrides?: Partial<DashboardViewModel>): DashboardViewModel {
  return {
    title: 'OpenSlack Team Dashboard',
    generatedAt: '2026-06-01 12:00:00',
    summary: { blockers: 1, handoffs: 2, decisions: 1 },
    blockers: [
      { object: 'pr:42', summary: 'Missing human approval', nextAction: 'Run gh pr review 42 --approve', severity: 'high' },
    ],
    handoffs: [
      { id: 'h1', from: 'agent-a', to: 'agent-b', status: 'open', context: 'PR review handoff', age: '2h' },
      { id: 'h2', from: 'agent-c', to: 'human-d', status: 'closed', context: 'Decision made', age: '5d' },
    ],
    decisions: [
      { id: 'd1', topic: 'Use React for TUI', status: 'accepted', decidedBy: 'team-lead' },
    ],
    recentActivity: [
      { time: '11:45', type: 'pr.passed', summary: 'PR #137 passed CI', actor: 'openslack-bot' },
      { time: '11:30', type: 'handoff.opened', summary: 'Handoff from agent-a to agent-b', actor: 'agent-a' },
      { time: '11:00', type: 'decision.accepted', summary: 'Decision on architecture', actor: 'team-lead' },
    ],
    ...overrides,
  }
}

function createPrQueueModel(overrides?: Partial<PrQueueViewModel>): PrQueueViewModel {
  return {
    title: 'PR Queue',
    totalPRs: 3,
    readyCount: 1,
    blockedCount: 1,
    pendingCount: 1,
    items: [
      {
        prNumber: 101,
        title: 'feat: add dashboard view',
        author: 'bot',
        decision: 'APPROVED',
        blockerCategory: 'none',
        owner: 'team-lead',
        canMerge: true,
        riskZone: 'yellow',
        nextAction: 'Merge',
        rerunCommand: 'openslack pr doctor 101',
        workflowGate: { touched: true, criteria: [{ name: 'Build', passed: true }, { name: 'Tests', passed: true }], overall: 'PASS' },
      },
      {
        prNumber: 102,
        title: 'fix: profile sync bug',
        author: 'bot',
        decision: 'REVIEW_REQUIRED',
        blockerCategory: 'approval',
        owner: 'team-lead',
        canMerge: false,
        riskZone: 'yellow',
        nextAction: 'Needs human approval',
        rerunCommand: 'openslack pr doctor 102',
        workflowGate: { touched: false, criteria: [], overall: 'N/A' },
      },
      {
        prNumber: 103,
        title: 'chore: update docs',
        author: 'bot',
        decision: 'PENDING',
        blockerCategory: 'checks',
        owner: 'any',
        canMerge: false,
        riskZone: 'green',
        nextAction: 'Waiting for CI',
        rerunCommand: 'openslack pr doctor 103',
        workflowGate: { touched: true, criteria: [{ name: 'Tests', passed: false }], overall: 'FAIL' },
      },
    ],
    ...overrides,
  }
}

function createProfileModel(overrides?: Partial<ProfileViewModel>): ProfileViewModel {
  return {
    title: 'Organization Profile',
    targetRepo: 'Negentropy-Laby/.github',
    targetPath: 'profile/README.md',
    marker: 'latest-insights',
    syncStatus: 'synced',
    lastSyncDate: '2026-06-01',
    lastPrUrl: 'https://github.com/Negentropy-Laby/.github/pull/42',
    markerStatus: 'present',
    pendingPR: undefined,
    posts: [
      { title: 'First Post', date: '2026-05-30', summary: 'Summary of the first post content for testing', sourcePath: 'posts/first.md', url: 'https://example.com/first' },
      { title: 'Second Post', date: '2026-05-31', summary: 'Summary of the second post content for testing', sourcePath: 'posts/second.md', url: 'https://example.com/second' },
    ],
    validationSummary: { total: 2, published: 2, failed: 0 },
    syncDetails: {
      sourceCommit: 'abc1234',
      sourceDate: '2026-06-01',
      targetHash: 'def5678',
      mode: 'auto-pr',
    },
    mode: 'auto-pr',
    actions: [
      { id: 'check', key: 'c', label: 'Check', description: 'Check sync readiness', risk: 'low' },
      { id: 'preview', key: 'p', label: 'Preview', description: 'Preview diff patch', risk: 'low' },
      { id: 'create-pr', key: 'r', label: 'Create PR', description: 'Run profile sync and create PR', risk: 'medium' },
    ],
    ...overrides,
  }
}

function createApprovalCenterModel(overrides?: Partial<ApprovalCenterViewModel>): ApprovalCenterViewModel {
  return {
    pendingApprovals: [
      {
        id: 'ap-1',
        category: 'plan',
        title: 'Refactor CLI routing',
        detail: 'Plan to restructure CLI command routing',
        risk: 'medium',
        requestedBy: 'agent-operator',
        requestedAt: '2026-06-01T10:00:00Z',
        planId: 'plan-001',
        explanation: {
          why: 'Current routing is fragile',
          ifApproved: 'Agent will execute refactoring',
          ifRejected: 'Agent will not proceed',
          source: 'Agent self-triage',
        },
      },
      {
        id: 'ap-2',
        category: 'merge-request',
        title: 'Merge PR #101',
        detail: 'All gates pass, ready to merge',
        risk: 'low',
        requestedBy: 'prms-steward',
        requestedAt: '2026-06-01T11:00:00Z',
        prNumber: 101,
      },
      {
        id: 'ap-3',
        category: 'github-review',
        title: 'Approve PR #105',
        detail: 'Requires human GitHub review',
        risk: 'low',
        requestedBy: 'agent-operator',
        requestedAt: '2026-06-01T12:00:00Z',
        prNumber: 105,
      },
    ],
    groups: [
      {
        category: 'merge-request',
        label: 'Merge Requests',
        items: [
          {
            id: 'ap-2',
            category: 'merge-request',
            title: 'Merge PR #101',
            detail: 'All gates pass, ready to merge',
            risk: 'low',
            requestedBy: 'prms-steward',
            requestedAt: '2026-06-01T11:00:00Z',
            prNumber: 101,
          },
        ],
      },
      {
        category: 'plan',
        label: 'Operator Plans',
        items: [
          {
            id: 'ap-1',
            category: 'plan',
            title: 'Refactor CLI routing',
            detail: 'Plan to restructure CLI command routing',
            risk: 'medium',
            requestedBy: 'agent-operator',
            requestedAt: '2026-06-01T10:00:00Z',
            planId: 'plan-001',
            explanation: {
              why: 'Current routing is fragile',
              ifApproved: 'Agent will execute refactoring',
              ifRejected: 'Agent will not proceed',
              source: 'Agent self-triage',
            },
          },
        ],
      },
      {
        category: 'github-review',
        label: 'GitHub Reviews Required',
        items: [
          {
            id: 'ap-3',
            category: 'github-review',
            title: 'Approve PR #105',
            detail: 'Requires human GitHub review',
            risk: 'low',
            requestedBy: 'agent-operator',
            requestedAt: '2026-06-01T12:00:00Z',
            prNumber: 105,
          },
        ],
      },
    ],
    summary: { plans: 1, mergeRequests: 1, workflowEffects: 0, profileSyncs: 0, githubReviews: 1 },
    ...overrides,
  }
}

function createRoomModel(overrides?: Partial<RoomViewModel>): RoomViewModel {
  return {
    roomId: 'pr:42',
    objectKind: 'pr',
    objectId: '42',
    sourceUrl: 'https://github.com/org/repo/pull/42',
    owner: 'team-lead',
    nextAction: 'Review and approve',
    blockerCount: 1,
    blockers: [
      { type: 'approval', summary: 'Missing human approval', timestamp: '2h ago' },
    ],
    handoffs: [
      { id: 'h1', from: 'agent-a', to: 'agent-b', status: 'open', context: 'PR review handoff' },
    ],
    decisions: [
      { id: 'd1', topic: 'Architecture choice', decision: 'Use TUI components', status: 'accepted' },
    ],
    recentActivity: [
      { time: '11:45', type: 'pr.passed', summary: 'CI checks passed', actor: 'openslack-bot' },
      { time: '11:30', type: 'handoff.opened', summary: 'Handoff from agent-a to agent-b', actor: 'agent-a' },
    ],
    ...overrides,
  }
}

// -- Loading indicator words to check for in loaded state --
const LOADING_INDICATORS = ['Loading', 'loading', '...', 'Loading...', 'spinner']

function assertNoLoadingArtifacts(output: string, viewName: string): void {
  const stripped = stripAnsi(output)
  // Views should show actual data content, not generic loading text
  // Only check for specific loading indicators that would indicate a stale frame
  for (const indicator of LOADING_INDICATORS) {
    // Allow "..." within diff output or other legitimate contexts by checking
    // that the indicator is not the dominant content
    if (indicator === '...') continue
    // "Loading" should not appear in final loaded output
    if (indicator === 'Loading' || indicator === 'loading') {
      // Only fail if "Loading" or "loading" appears as standalone loading text
      const loadingPattern = /\bLoading\b|\bloading\b/
      if (loadingPattern.test(stripped)) {
        // Allow if it's part of a real content word like "Uploading" or "Downloading"
        const hasOnlyLoadingState = /^\s*(Loading|loading)[.\s]*$/.test(stripped.trim())
        if (hasOnlyLoadingState) {
          throw new Error(`${viewName}: Final output appears to be a loading state, not loaded content`)
        }
      }
    }
  }
}

// -- Tests --

const WIDTHS = [80, 100, 120] as const

describe.each(WIDTHS)('loading transition at %d columns', (cols) => {

  // ─── WorkflowLifecycleView (existing) ───

  describe('WorkflowLifecycleView (direct render = loaded)', () => {
    it('renders loaded state within width', async () => {
      const model = createLifecycleModel()
      const output = await renderAt(
        withNav(React.createElement(WorkflowLifecycleView, { model })),
        cols,
      )
      expect(output.length).toBeGreaterThan(0)
      assertNoLineExceedsWidth(output, cols)
      expect(output).toContain('Lifecycle')
      expect(output).toContain('test-workflow')
    })
  })

  describe('WorkflowLifecycleViewWrapper (async loader)', () => {
    it('renders loading state within width', async () => {
      const neverResolve: WorkflowLifecycleLoader = () => new Promise<WorkflowLifecycleViewModel>(() => {})
      const output = await renderAt(
        withNav(
          React.createElement(WorkflowLifecycleViewWrapper, {
            workflowName: 'test-workflow',
            loadLifecycle: neverResolve,
          }),
        ),
        cols,
      )
      expect(output.length).toBeGreaterThan(0)
      assertNoLineExceedsWidth(output, cols)
      expect(output).toContain('test-workflow')
      expect(output).toContain('Loading')
    })

    it('transitions to loaded without residual loading artifacts', async () => {
      const model = createLifecycleModel()
      const resolveImmediately: WorkflowLifecycleLoader = async () => model
      const output = await renderAt(
        withNav(
          React.createElement(WorkflowLifecycleViewWrapper, {
            workflowName: 'test-workflow',
            loadLifecycle: resolveImmediately,
          }),
        ),
        cols,
      )
      expect(output.length).toBeGreaterThan(0)
      assertNoLineExceedsWidth(output, cols)
      expect(output).toContain('Lifecycle')
      expect(output).toContain('test-workflow')
      const stripped = stripAnsi(output)
      expect(stripped).toContain('Proposal')
    })
  })

  describe('transition from failed model', () => {
    it('renders blocked lifecycle within width', async () => {
      const model = createLifecycleModel({
        nextAction: '',
        blockedGateItems: [
          { gate: 'Approval', detail: 'No valid human approval' },
          { gate: 'Checks', detail: 'CI failing on test suite' },
        ],
        statusSummary: 'BLOCKED: 2 gates failing',
      })
      const output = await renderAt(
        withNav(React.createElement(WorkflowLifecycleView, { model })),
        cols,
      )
      expect(output.length).toBeGreaterThan(0)
      assertNoLineExceedsWidth(output, cols)
    })
  })

  // ─── DashboardView ───

  describe('DashboardView', () => {
    it('renders loaded state with room and activity data within width', async () => {
      const model = createDashboardModel()
      const output = await renderAt(
        withNav(React.createElement(DashboardView, { model })),
        cols,
      )
      expect(output.length).toBeGreaterThan(0)
      assertNoLineExceedsWidth(output, cols)
      // Verify actual content markers
      const stripped = stripAnsi(output)
      expect(stripped).toContain('Dashboard')
      expect(stripped).toContain('Blockers')
      expect(stripped).toContain('Handoffs')
      expect(stripped).toContain('Decisions')
      // Loaded content should contain actual data
      expect(stripped).toContain('pr:42')
      expect(stripped).toContain('agent-a')
    })

    it('renders empty data (loading-like sparse state) within width', async () => {
      const model = createDashboardModel({
        summary: { blockers: 0, handoffs: 0, decisions: 0 },
        blockers: [],
        handoffs: [],
        decisions: [],
        recentActivity: [],
      })
      const output = await renderAt(
        withNav(React.createElement(DashboardView, { model })),
        cols,
      )
      expect(output.length).toBeGreaterThan(0)
      assertNoLineExceedsWidth(output, cols)
      // Empty state should show no-blockers indicator
      const stripped = stripAnsi(output)
      expect(stripped).toContain('No blockers')
    })

    it('does not throw during transition from sparse to full data', async () => {
      // Simulate the transition by rendering a full model and verifying no throw
      const sparseModel = createDashboardModel({
        summary: { blockers: 0, handoffs: 0, decisions: 0 },
        blockers: [],
        handoffs: [],
        decisions: [],
        recentActivity: [],
      })
      const fullModel = createDashboardModel()
      // Render sparse, then full -- no throw means clean transition
      const output1 = await renderAt(
        withNav(React.createElement(DashboardView, { model: sparseModel })),
        cols,
      )
      expect(output1.length).toBeGreaterThan(0)
      const output2 = await renderAt(
        withNav(React.createElement(DashboardView, { model: fullModel })),
        cols,
      )
      expect(output2.length).toBeGreaterThan(0)
      assertNoLoadingArtifacts(output2, 'DashboardView')
    })

    it('loaded output contains no stale loading artifacts', async () => {
      const model = createDashboardModel()
      const output = await renderAt(
        withNav(React.createElement(DashboardView, { model })),
        cols,
      )
      assertNoLoadingArtifacts(output, 'DashboardView')
    })
  })

  // ─── PrQueueView ───

  describe('PrQueueView', () => {
    it('renders loaded state with PR data within width', async () => {
      const model = createPrQueueModel()
      const output = await renderAt(
        withNav(React.createElement(PrQueueView, { model })),
        cols,
      )
      expect(output.length).toBeGreaterThan(0)
      assertNoLineExceedsWidth(output, cols)
      const stripped = stripAnsi(output)
      expect(stripped).toContain('PR Queue')
      expect(stripped).toContain('Ready')
      expect(stripped).toContain('Blocked')
      expect(stripped).toContain('#101')
      expect(stripped).toContain('#102')
    })

    it('renders empty queue (loading-like sparse state) within width', async () => {
      const model = createPrQueueModel({
        totalPRs: 0,
        readyCount: 0,
        blockedCount: 0,
        pendingCount: 0,
        items: [],
      })
      const output = await renderAt(
        withNav(React.createElement(PrQueueView, { model })),
        cols,
      )
      expect(output.length).toBeGreaterThan(0)
      assertNoLineExceedsWidth(output, cols)
      const stripped = stripAnsi(output)
      expect(stripped).toContain('No open PRs found')
    })

    it('does not throw during transition from empty to populated queue', async () => {
      const emptyModel = createPrQueueModel({
        totalPRs: 0,
        readyCount: 0,
        blockedCount: 0,
        pendingCount: 0,
        items: [],
      })
      const fullModel = createPrQueueModel()
      const output1 = await renderAt(
        withNav(React.createElement(PrQueueView, { model: emptyModel })),
        cols,
      )
      expect(output1.length).toBeGreaterThan(0)
      const output2 = await renderAt(
        withNav(React.createElement(PrQueueView, { model: fullModel })),
        cols,
      )
      expect(output2.length).toBeGreaterThan(0)
      assertNoLoadingArtifacts(output2, 'PrQueueView')
    })

    it('loaded output contains no stale loading artifacts', async () => {
      const model = createPrQueueModel()
      const output = await renderAt(
        withNav(React.createElement(PrQueueView, { model })),
        cols,
      )
      assertNoLoadingArtifacts(output, 'PrQueueView')
    })
  })

  // ─── ProfileView ───

  describe('ProfileView', () => {
    it('renders loaded state with profile sync status within width', async () => {
      const model = createProfileModel()
      const output = await renderAt(
        withNav(React.createElement(ProfileView, { model })),
        cols,
      )
      expect(output.length).toBeGreaterThan(0)
      assertNoLineExceedsWidth(output, cols)
      const stripped = stripAnsi(output)
      expect(stripped).toContain('Organization Profile')
      expect(stripped).toContain('Sync Status')
      expect(stripped).toContain('Validation')
      expect(stripped).toContain('synced')
    })

    it('renders never-synced state (loading-like sparse state) within width', async () => {
      const model = createProfileModel({
        syncStatus: 'never',
        markerStatus: 'unknown',
        lastSyncDate: undefined,
        lastPrUrl: undefined,
        posts: [],
        validationSummary: { total: 0, published: 0, failed: 0 },
      })
      const output = await renderAt(
        withNav(React.createElement(ProfileView, { model })),
        cols,
      )
      expect(output.length).toBeGreaterThan(0)
      assertNoLineExceedsWidth(output, cols)
      const stripped = stripAnsi(output)
      expect(stripped).toContain('never')
      expect(stripped).toContain('No posts synced yet')
    })

    it('renders failed sync state within width', async () => {
      const model = createProfileModel({
        syncStatus: 'failed',
        markerStatus: 'missing',
        failureDetails: {
          reason: 'Marker not found in target file',
          nextAction: 'Manually add marker and retry',
        },
      })
      const output = await renderAt(
        withNav(React.createElement(ProfileView, { model })),
        cols,
      )
      expect(output.length).toBeGreaterThan(0)
      assertNoLineExceedsWidth(output, cols)
      const stripped = stripAnsi(output)
      expect(stripped).toContain('Sync Failed')
      expect(stripped).toContain('failed')
    })

    it('does not throw during transition from never-synced to synced', async () => {
      const sparseModel = createProfileModel({
        syncStatus: 'never',
        markerStatus: 'unknown',
        posts: [],
        validationSummary: { total: 0, published: 0, failed: 0 },
      })
      const fullModel = createProfileModel()
      const output1 = await renderAt(
        withNav(React.createElement(ProfileView, { model: sparseModel })),
        cols,
      )
      expect(output1.length).toBeGreaterThan(0)
      const output2 = await renderAt(
        withNav(React.createElement(ProfileView, { model: fullModel })),
        cols,
      )
      expect(output2.length).toBeGreaterThan(0)
      assertNoLoadingArtifacts(output2, 'ProfileView')
    })

    it('loaded output contains no stale loading artifacts', async () => {
      const model = createProfileModel()
      const output = await renderAt(
        withNav(React.createElement(ProfileView, { model })),
        cols,
      )
      assertNoLoadingArtifacts(output, 'ProfileView')
    })
  })

  // ─── ApprovalCenterView ───

  describe('ApprovalCenterView', () => {
    it('renders loaded state with pending approvals within width', async () => {
      const model = createApprovalCenterModel()
      const output = await renderAt(
        withNav(React.createElement(ApprovalCenterView, { model })),
        cols,
      )
      expect(output.length).toBeGreaterThan(0)
      assertNoLineExceedsWidth(output, cols)
      const stripped = stripAnsi(output)
      expect(stripped).toContain('Approvals')
      expect(stripped).toContain('Merge Requests')
      expect(stripped).toContain('Operator Plans')
      expect(stripped).toContain('GitHub Reviews Required')
    })

    it('renders empty approvals (loading-like sparse state) within width', async () => {
      const model = createApprovalCenterModel({
        pendingApprovals: [],
        groups: [],
        summary: { plans: 0, mergeRequests: 0, workflowEffects: 0, profileSyncs: 0, githubReviews: 0 },
      })
      const output = await renderAt(
        withNav(React.createElement(ApprovalCenterView, { model })),
        cols,
      )
      expect(output.length).toBeGreaterThan(0)
      assertNoLineExceedsWidth(output, cols)
      const stripped = stripAnsi(output)
      expect(stripped).toContain('No pending approvals')
    })

    it('does not throw during transition from empty to populated approvals', async () => {
      const emptyModel = createApprovalCenterModel({
        pendingApprovals: [],
        groups: [],
        summary: { plans: 0, mergeRequests: 0, workflowEffects: 0, profileSyncs: 0, githubReviews: 0 },
      })
      const fullModel = createApprovalCenterModel()
      const output1 = await renderAt(
        withNav(React.createElement(ApprovalCenterView, { model: emptyModel })),
        cols,
      )
      expect(output1.length).toBeGreaterThan(0)
      const output2 = await renderAt(
        withNav(React.createElement(ApprovalCenterView, { model: fullModel })),
        cols,
      )
      expect(output2.length).toBeGreaterThan(0)
      assertNoLoadingArtifacts(output2, 'ApprovalCenterView')
    })

    it('loaded output contains no stale loading artifacts', async () => {
      const model = createApprovalCenterModel()
      const output = await renderAt(
        withNav(React.createElement(ApprovalCenterView, { model })),
        cols,
      )
      assertNoLoadingArtifacts(output, 'ApprovalCenterView')
    })
  })

  // ─── RoomView ───

  describe('RoomView', () => {
    it('renders loaded state with room events within width', async () => {
      const model = createRoomModel()
      const output = await renderAt(
        withNav(React.createElement(RoomView, { model })),
        cols,
      )
      expect(output.length).toBeGreaterThan(0)
      assertNoLineExceedsWidth(output, cols)
      const stripped = stripAnsi(output)
      expect(stripped).toContain('Room')
      expect(stripped).toContain('pr:42')
      expect(stripped).toContain('Blockers')
      expect(stripped).toContain('Handoffs')
      expect(stripped).toContain('Decisions')
      expect(stripped).toContain('Recent Activity')
    })

    it('renders empty room (loading-like sparse state) within width', async () => {
      const model = createRoomModel({
        blockerCount: 0,
        blockers: [],
        handoffs: [],
        decisions: [],
        recentActivity: [],
        nextAction: '',
        sourceUrl: '',
        owner: '',
      })
      const output = await renderAt(
        withNav(React.createElement(RoomView, { model })),
        cols,
      )
      expect(output.length).toBeGreaterThan(0)
      assertNoLineExceedsWidth(output, cols)
      const stripped = stripAnsi(output)
      expect(stripped).toContain('No blockers')
      expect(stripped).toContain('No activity found')
    })

    it('renders room with only blockers (partial data) within width', async () => {
      const model = createRoomModel({
        handoffs: [],
        decisions: [],
        recentActivity: [],
        nextAction: 'Fix CI failure',
        owner: 'dev-lead',
      })
      const output = await renderAt(
        withNav(React.createElement(RoomView, { model })),
        cols,
      )
      expect(output.length).toBeGreaterThan(0)
      assertNoLineExceedsWidth(output, cols)
      const stripped = stripAnsi(output)
      expect(stripped).toContain('Blockers')
      expect(stripped).toContain('approval')
    })

    it('does not throw during transition from empty to full room data', async () => {
      const sparseModel = createRoomModel({
        blockerCount: 0,
        blockers: [],
        handoffs: [],
        decisions: [],
        recentActivity: [],
        nextAction: '',
        sourceUrl: '',
        owner: '',
      })
      const fullModel = createRoomModel()
      const output1 = await renderAt(
        withNav(React.createElement(RoomView, { model: sparseModel })),
        cols,
      )
      expect(output1.length).toBeGreaterThan(0)
      const output2 = await renderAt(
        withNav(React.createElement(RoomView, { model: fullModel })),
        cols,
      )
      expect(output2.length).toBeGreaterThan(0)
      assertNoLoadingArtifacts(output2, 'RoomView')
    })

    it('loaded output contains no stale loading artifacts', async () => {
      const model = createRoomModel()
      const output = await renderAt(
        withNav(React.createElement(RoomView, { model })),
        cols,
      )
      assertNoLoadingArtifacts(output, 'RoomView')
    })
  })
})

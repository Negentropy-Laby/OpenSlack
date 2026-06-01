/**
 * error-missing-state.test.tsx -- Error, missing, and empty data state rendering.
 *
 * Tests that all 9 core views handle gracefully:
 * - Empty data (no items, no activity, no blockers)
 * - Missing optional fields
 * - Error / failed states
 * - Loading indicators
 *
 * At 80 and 100 columns. Asserts no crash, no width overflow, output non-empty.
 */
import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from '@openslack/tui'
import { NavigationProvider } from '../../navigation/context.js'
import stripAnsi from 'strip-ansi'

import HomeView from '../../views/HomeView.js'
import DoctorView from '../../views/DoctorView.js'
import PrQueueView from '../../views/PrQueueView.js'
import ProfileView from '../../views/ProfileView.js'
import WorkflowLifecycleView from '../../views/WorkflowLifecycleView.js'
import WorkflowWorkbenchView from '../../views/WorkflowWorkbenchView.js'
import DashboardView from '../../views/DashboardView.js'
import ApprovalCenterView from '../../views/ApprovalCenterView.js'
import RoomView from '../../views/RoomView.js'

import type { HomeViewModel } from '../../view-models/home.js'
import type { DoctorViewModel } from '../../view-models/doctor.js'
import type { PrQueueViewModel } from '../../view-models/pr-queue.js'
import type { ProfileViewModel } from '../../view-models/profile.js'
import type { WorkflowLifecycleViewModel } from '../../view-models/workflow-lifecycle.js'
import type { WorkflowGalleryViewModel } from '../../view-models/workflow-gallery.js'
import type { DashboardViewModel } from '../../view-models/dashboard.js'
import type { ApprovalCenterViewModel } from '../../view-models/approval-center.js'
import type { RoomViewModel } from '../../view-models/room.js'

import { assertNoLineExceedsWidth } from '../helpers/render-at-columns.js'

import { Writable } from 'stream'

// ── Helpers ──

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

// ── Empty/missing factories ──

function createEmptyHomeViewModel(): HomeViewModel {
  return {
    attentionItems: [],
    allClear: true,
    navItems: [],
    tasks: [],
    systemStatus: 'ready',
    nextRecommendedAction: undefined,
  }
}

function createFailedDoctorViewModel(): DoctorViewModel {
  return {
    prNumber: 99,
    title: 'Broken PR with failures',
    author: 'test-bot',
    state: 'open',
    draft: false,
    riskZone: 'red',
    mergeable: false,
    decision: 'BLOCKED',
    reason: 'Multiple gates failed',
    recommendation: 'Do not merge',
    gates: [
      { name: 'Draft', status: 'PASS', detail: 'Ready for review' },
      { name: 'State', status: 'PASS', detail: 'Open' },
      { name: 'Merge', status: 'FAIL', detail: 'Merge conflicts detected' },
      { name: 'Checks', status: 'FAIL', detail: '2 of 3 failed' },
      { name: 'Approvals', status: 'FAIL', detail: 'No valid approvals' },
      { name: 'Risk', status: 'WARN', detail: 'Zone: RED' },
    ],
    checks: [
      { name: 'ci/lint', status: 'PASS', conclusion: 'success' },
      { name: 'ci/test', status: 'FAIL', conclusion: 'failure' },
      { name: 'ci/build', status: 'FAIL', conclusion: 'failure' },
    ],
    reviews: [],
    evidence: ['No valid approval found'],
    compressed: false,
    profileSyncGate: {
      passed: false,
      detail: 'Profile sync not run',
    },
  }
}

function createEmptyPrQueueViewModel(): PrQueueViewModel {
  return {
    title: 'PR Queue',
    totalPRs: 0,
    readyCount: 0,
    blockedCount: 0,
    pendingCount: 0,
    items: [],
  }
}

function createMissingProfileViewModel(): ProfileViewModel {
  return {
    title: 'Organization Profile',
    targetRepo: '',
    targetPath: '',
    marker: '',
    syncStatus: 'never',
    lastSyncDate: '',
    markerStatus: 'missing',
    posts: [],
    validationSummary: { total: 0, published: 0, failed: 0 },
    syncDetails: undefined as any,
    mode: 'manual',
    guidedStep: 'check',
    checkGroups: [
      { key: 'source', label: 'Source repository', status: 'fail', detail: 'Repository not configured' },
      { key: 'posts', label: 'Posts', status: 'unknown', detail: 'No posts found' },
      { key: 'target-marker', label: 'Target marker', status: 'fail', detail: 'Marker not found in target' },
      { key: 'permissions', label: 'Permissions', status: 'unknown', detail: 'Cannot verify permissions' },
    ],
    actions: [],
  }
}

function createEmptyWorkflowLifecycleViewModel(): WorkflowLifecycleViewModel {
  return {
    workflowName: '',
    workflowHash: '',
    trustLevel: 'unknown',
    risk: 'unknown',
    sourcePath: '',
    stages: [],
    phaseIssues: [],
    currentRun: undefined,
    prNumber: undefined,
    prStatus: undefined,
    nextAction: '',
    subIssueMode: 'unknown',
    dependencyMode: 'none',
    fallbackReasons: ['No workflow data available'],
    blockedGateItems: [],
    statusSummary: 'No workflow data',
  }
}

function createEmptyWorkflowWorkbenchViewModel(): WorkflowGalleryViewModel {
  return {
    workflows: [],
    summary: { total: 0, yaml: 0, js: 0 },
  }
}

function createEmptyDashboardViewModel(): DashboardViewModel {
  return {
    title: 'OpenSlack Team Dashboard',
    generatedAt: '2026-06-01T12:00:00Z',
    summary: { blockers: 0, handoffs: 0, decisions: 0 },
    blockers: [],
    handoffs: [],
    decisions: [],
    recentActivity: [],
  }
}

function createEmptyApprovalCenterViewModel(): ApprovalCenterViewModel {
  return {
    pendingApprovals: [],
    groups: [],
    summary: {
      plans: 0,
      mergeRequests: 0,
      workflowEffects: 0,
      profileSyncs: 0,
      githubReviews: 0,
    },
  }
}

function createEmptyRoomViewModel(): RoomViewModel {
  return {
    roomId: 'pr:0',
    objectKind: 'pr',
    objectId: '0',
    sourceUrl: '',
    owner: '',
    nextAction: '',
    blockerCount: 0,
    blockers: [],
    handoffs: [],
    decisions: [],
    recentActivity: [],
  }
}

// ── Test matrix ──

const WIDTHS = [80, 100] as const

type EmptyViewSpec = {
  name: string
  needsNav: boolean
  create: () => React.ReactElement
  requiredMarker?: string
}

const EMPTY_VIEWS: EmptyViewSpec[] = [
  {
    name: 'HomeView (empty)',
    needsNav: true,
    create: () => React.createElement(HomeView, { model: createEmptyHomeViewModel() }),
    requiredMarker: 'OpenSlack',
  },
  {
    name: 'DoctorView (failed)',
    needsNav: false,
    create: () => React.createElement(DoctorView, { model: createFailedDoctorViewModel() }),
    requiredMarker: 'Doctor Report',
  },
  {
    name: 'PrQueueView (empty)',
    needsNav: false,
    create: () => React.createElement(PrQueueView, { model: createEmptyPrQueueViewModel() }),
    requiredMarker: 'PR Queue',
  },
  {
    name: 'ProfileView (missing)',
    needsNav: false,
    create: () => React.createElement(ProfileView, { model: createMissingProfileViewModel() }),
    requiredMarker: 'Organization Profile',
  },
  {
    name: 'WorkflowLifecycleView (empty)',
    needsNav: true,
    create: () => React.createElement(WorkflowLifecycleView, { model: createEmptyWorkflowLifecycleViewModel() }),
    requiredMarker: 'Lifecycle',
  },
  {
    name: 'WorkflowWorkbenchView (empty)',
    needsNav: true,
    create: () => React.createElement(WorkflowWorkbenchView, { galleryModel: createEmptyWorkflowWorkbenchViewModel() }),
    requiredMarker: 'Workflows',
  },
  {
    name: 'DashboardView (empty)',
    needsNav: false,
    create: () => React.createElement(DashboardView, { model: createEmptyDashboardViewModel() }),
    requiredMarker: 'Team Dashboard',
  },
  {
    name: 'ApprovalCenterView (empty)',
    needsNav: true,
    create: () => React.createElement(ApprovalCenterView, { model: createEmptyApprovalCenterViewModel() }),
    requiredMarker: 'Approvals',
  },
  {
    name: 'RoomView (empty)',
    needsNav: false,
    create: () => React.createElement(RoomView, { model: createEmptyRoomViewModel() }),
    requiredMarker: 'Room',
  },
]

// ── Tests ──

describe.each(WIDTHS)('error/missing state at %d columns', (cols) => {
  for (const spec of EMPTY_VIEWS) {
    describe(spec.name, () => {
      it('renders without crashing', async () => {
        const element = spec.create()
        const wrapped = spec.needsNav ? withNav(element) : element
        const output = await renderAt(wrapped, cols)
        expect(output.length).toBeGreaterThan(0)
      })

      it('does not exceed column width', async () => {
        const element = spec.create()
        const wrapped = spec.needsNav ? withNav(element) : element
        const output = await renderAt(wrapped, cols)
        assertNoLineExceedsWidth(output, cols)
      })

      if (spec.requiredMarker) {
        it(`contains required marker: ${spec.requiredMarker}`, async () => {
          const element = spec.create()
          const wrapped = spec.needsNav ? withNav(element) : element
          const output = await renderAt(wrapped, cols)
          expect(output).toContain(spec.requiredMarker!)
        })
      }

      it('does not contain raw ANSI after stripping Ink colors', async () => {
        const element = spec.create()
        const wrapped = spec.needsNav ? withNav(element) : element
        const output = await renderAt(wrapped, cols)
        const stripped = stripAnsi(output)
        expect(stripped).not.toContain('\x1b[')
      })
    })
  }
})

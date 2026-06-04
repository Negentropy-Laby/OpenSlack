/**
 * plain-render.test.ts -- Tests for the plain-text fallback renderer.
 *
 * For all 7 renderers, verifies:
 * - Output contains expected text markers
 * - No box-drawing characters
 * - No ANSI escape sequences
 * - No line exceeds 80 characters
 * - Empty/minimal data is safe (no crashes)
 * - CJK characters are preserved
 */
import { describe, it, expect } from 'vitest'
import { stringWidth } from '../ink/stringWidth.js'
import {
  renderPlainHome,
  renderPlainDoctor,
  renderPlainPrQueue,
  renderPlainProfile,
  renderPlainWorkflowLifecycle,
  renderPlainWorkflowWorkbench,
  renderPlainDashboard,
  renderPlainActivity,
  renderPlainDecisionList,
  renderPlainDecisionDetail,
  renderPlainDigest,
  renderPlainHandoffList,
  renderPlainHandoffDetail,
  renderPlainIssuesPr,
  renderPlainSetup,
  renderPlainStatus,
  renderPlainShell,
  renderPlainWorkflowPreview,
  renderPlain,
} from '../plain-render.js'

import {
  createHomeViewModel,
  createHomeViewModelWithAction,
  createDoctorViewModel,
  createPrQueueViewModel,
  createProfileViewModel,
  createWorkflowLifecycleViewModel,
  createWorkflowWorkbenchViewModel,
  createDashboardViewModel,
  createActivityViewModel,
  createDecisionListViewModel,
  createDecisionDetailViewModel,
  createDigestViewModel,
  createHandoffListViewModel,
  createHandoffDetailViewModel,
  createIssuesPrViewModel,
  createSetupViewModel,
  createStatusViewModel,
  createWorkflowPreviewViewModel,
  createShellViewData,
} from './helpers/view-model-factories.js'

import type { HomeViewModel } from '../view-models/home.js'
import type { DoctorViewModel } from '../view-models/doctor.js'
import type { PrQueueViewModel } from '../view-models/pr-queue.js'
import type { ProfileViewModel } from '../view-models/profile.js'
import type { WorkflowLifecycleViewModel } from '../view-models/workflow-lifecycle.js'
import { mapWorkflowLifecycleToViewModel } from '../view-models/workflow-lifecycle.js'
import type { WorkflowGalleryViewModel } from '../view-models/workflow-gallery.js'
import type { DashboardViewModel } from '../view-models/dashboard.js'
import type { ActivityViewModel } from '../view-models/activity.js'
import type { DecisionListViewModel, DecisionDetailViewModel } from '../view-models/decision.js'
import type { DigestViewModel } from '../view-models/digest.js'
import type { HandoffListViewModel, HandoffDetailViewModel } from '../view-models/handoff.js'
import type { IssuesPrViewModel } from '../view-models/issues-pr.js'
import type { SetupViewModel } from '../view-models/setup.js'
import type { StatusViewModel } from '../view-models/status.js'
import type { WorkflowPreviewViewModel } from '../view-models/workflow-preview.js'

// Box-drawing characters that must NOT appear in plain output
const BOX_DRAWING_RE = /[─-╿]/

// ANSI escape sequence pattern
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/

function assertNoBoxDrawing(output: string) {
  const lines = output.split('\n')
  for (const line of lines) {
    expect(BOX_DRAWING_RE.test(line), `Box-drawing char found in: "${line}"`).toBe(false)
  }
}

function assertNoAnsi(output: string) {
  expect(ANSI_RE.test(output), 'ANSI escape sequence found in output').toBe(false)
}

function assertNoLineExceeds80(output: string) {
  assertNoLineExceeds(output, 80)
}

function assertNoLineExceeds(output: string, maxWidth: number) {
  const lines = output.split('\n')
  for (const line of lines) {
    const visualWidth = stringWidth(line)
    expect(visualWidth, `Line exceeds ${maxWidth} columns (${visualWidth}): "${line}"`).toBeLessThanOrEqual(maxWidth)
  }
}

// --- Home ---

describe('renderPlainHome', () => {
  it('contains expected markers', () => {
    const vm = createHomeViewModel()
    const out = renderPlainHome(vm)
    expect(out).toContain('OpenSlack Home')
    expect(out).toContain('All clear')
    expect(out).toContain('Quick Navigation:')
    expect(out).toContain('System: ready')
  })

  it('has no box-drawing characters', () => {
    assertNoBoxDrawing(renderPlainHome(createHomeViewModel()))
  })

  it('has no ANSI escape sequences', () => {
    assertNoAnsi(renderPlainHome(createHomeViewModel()))
  })

  it('no line exceeds 80 columns', () => {
    assertNoLineExceeds80(renderPlainHome(createHomeViewModel()))
  })

  it('handles empty data safely', () => {
    const vm: HomeViewModel = {
      attentionItems: [],
      allClear: true,
      navItems: [],
      tasks: [],
      systemStatus: 'ready',
    }
    const out = renderPlainHome(vm)
    expect(out).toContain('All clear')
    expect(out).toContain('System: ready')
    assertNoLineExceeds80(out)
  })

  it('preserves CJK in attention items', () => {
    const vm: HomeViewModel = {
      ...createHomeViewModel(),
      attentionItems: [
        {
          label: '使用者設定を検証',
          detail: '리뷰 완료: 시스템 정상',
          route: 'status',
          colorTheme: 'warning',
        },
      ],
      allClear: false,
    }
    const out = renderPlainHome(vm)
    expect(out).toContain('使用者設定を検証')
    expect(out).toContain('리뷰 완료: 시스템 정상')
    assertNoLineExceeds80(out)
  })

  it('renders attention items with details', () => {
    const vm: HomeViewModel = {
      ...createHomeViewModel(),
      attentionItems: [
        {
          label: '3 Pending Approvals',
          detail: 'Plan: deploy to production',
          route: 'approvals',
          colorTheme: 'warning',
        },
      ],
      allClear: false,
    }
    const out = renderPlainHome(vm)
    expect(out).toContain('3 Pending Approvals')
    expect(out).toContain('Plan: deploy to production')
  })

  it('renders next recommended action when present', () => {
    const vm = createHomeViewModelWithAction()
    const out = renderPlainHome(vm)
    expect(out).toContain('Next Recommended Action:')
    expect(out).toContain('Approve pending plan: deploy to production')
    expect(out).toContain('1 plan awaiting approval, risk: medium')
    assertNoLineExceeds80(out)
  })
})

// --- Doctor ---

describe('renderPlainDoctor', () => {
  it('contains expected markers', () => {
    const vm = createDoctorViewModel()
    const out = renderPlainDoctor(vm)
    expect(out).toContain('PR Doctor -- #42')
    expect(out).toContain('Gates:')
    expect(out).toContain('[PASS] Draft')
    expect(out).toContain('[PASS] Approvals')
    expect(out).toContain('Checks:')
    expect(out).toContain('Reviews:')
    expect(out).toContain('Evidence:')
  })

  it('has no box-drawing characters', () => {
    assertNoBoxDrawing(renderPlainDoctor(createDoctorViewModel()))
  })

  it('has no ANSI escape sequences', () => {
    assertNoAnsi(renderPlainDoctor(createDoctorViewModel()))
  })

  it('no line exceeds 80 columns', () => {
    assertNoLineExceeds80(renderPlainDoctor(createDoctorViewModel()))
  })

  it('handles empty checks/reviews safely', () => {
    const vm: DoctorViewModel = {
      ...createDoctorViewModel(),
      checks: [],
      reviews: [],
      evidence: [],
    }
    const out = renderPlainDoctor(vm)
    expect(out).toContain('PR Doctor -- #42')
    assertNoLineExceeds80(out)
  })

  it('renders compressed summary', () => {
    const vm: DoctorViewModel = {
      ...createDoctorViewModel(),
      compressed: true,
    }
    const out = renderPlainDoctor(vm)
    expect(out).toContain('Compressed Summary:')
    expect(out).toContain('Can merge? YES')
  })

  it('renders profile sync gate', () => {
    const vm: DoctorViewModel = {
      ...createDoctorViewModel(),
      profileSyncGate: { passed: false, detail: 'Profile paths touched but no sync PR' },
    }
    const out = renderPlainDoctor(vm)
    expect(out).toContain('Profile Sync Gate:')
    expect(out).toContain('[FAIL] Profile paths touched but no sync PR')
  })
})

// --- PR Queue ---

describe('renderPlainPrQueue', () => {
  it('contains expected markers', () => {
    const vm = createPrQueueViewModel()
    const out = renderPlainPrQueue(vm)
    expect(out).toContain('PR Queue')
    expect(out).toContain('Total: 2')
    expect(out).toContain('[READY] #127')
    expect(out).toContain('[BLOCKED] #130')
  })

  it('has no box-drawing characters', () => {
    assertNoBoxDrawing(renderPlainPrQueue(createPrQueueViewModel()))
  })

  it('has no ANSI escape sequences', () => {
    assertNoAnsi(renderPlainPrQueue(createPrQueueViewModel()))
  })

  it('no line exceeds 80 columns', () => {
    assertNoLineExceeds80(renderPlainPrQueue(createPrQueueViewModel()))
  })

  it('handles empty queue safely', () => {
    const vm: PrQueueViewModel = {
      title: 'PR Queue',
      totalPRs: 0,
      readyCount: 0,
      blockedCount: 0,
      pendingCount: 0,
      items: [],
    }
    const out = renderPlainPrQueue(vm)
    expect(out).toContain('No open PRs.')
    assertNoLineExceeds80(out)
  })

  it('renders workflow gate details', () => {
    const out = renderPlainPrQueue(createPrQueueViewModel())
    expect(out).toContain('Workflow Gate: [FAIL]')
    expect(out).toContain('[FAIL] Coverage')
  })
})

// --- Profile ---

describe('renderPlainProfile', () => {
  it('contains expected markers', () => {
    const vm = createProfileViewModel()
    const out = renderPlainProfile(vm)
    expect(out).toContain('Organization Profile')
    expect(out).toContain('Sync Status: [SYNCED]')
    expect(out).toContain('Mode: manual')
    expect(out).toContain('Sync Details:')
    expect(out).toContain('Validation:')
    expect(out).toContain('Actions:')
    expect(out).toContain('Guided Flow:')
    expect(out).toContain('Check Results:')
    expect(out).toContain('[PASS] Source repository')
  })

  it('renders guided flow at check step', () => {
    const vm: ProfileViewModel = {
      ...createProfileViewModel(),
      syncStatus: 'never',
      guidedStep: 'check',
      checkGroups: [
        { key: 'source', label: 'Source', status: 'warn', detail: 'No commits yet' },
      ],
    }
    const out = renderPlainProfile(vm)
    expect(out).toContain('[>]1.Check')
    expect(out).toContain('[ ]2.Preview')
    expect(out).toContain('[WARN] Source: No commits yet')
    assertNoLineExceeds80(out)
  })

  it('has no box-drawing characters', () => {
    assertNoBoxDrawing(renderPlainProfile(createProfileViewModel()))
  })

  it('has no ANSI escape sequences', () => {
    assertNoAnsi(renderPlainProfile(createProfileViewModel()))
  })

  it('no line exceeds 80 columns', () => {
    assertNoLineExceeds80(renderPlainProfile(createProfileViewModel()))
  })

  it('handles minimal data safely', () => {
    const vm: ProfileViewModel = {
      title: 'Organization Profile',
      targetRepo: 'org/repo',
      targetPath: 'profile/README.md',
      marker: 'latest',
      syncStatus: 'never',
      markerStatus: 'unknown',
      posts: [],
      validationSummary: { total: 0, published: 0, failed: 0 },
      mode: 'manual',
      actions: [],
    }
    const out = renderPlainProfile(vm)
    expect(out).toContain('Sync Status: [NEVER]')
    assertNoLineExceeds80(out)
  })

  it('renders failure details', () => {
    const vm: ProfileViewModel = {
      ...createProfileViewModel(),
      syncStatus: 'failed',
      failureDetails: {
        reason: 'Target marker not found',
        nextAction: 'Run openslack collaboration workflow profile-sync check',
      },
    }
    const out = renderPlainProfile(vm)
    expect(out).toContain('FAILURE DETAILS:')
    expect(out).toContain('Target marker not found')
    expect(out).toContain('Run openslack collaboration workflow profile-sync check')
  })
})

// --- Workflow Lifecycle ---

describe('renderPlainWorkflowLifecycle', () => {
  it('contains expected markers', () => {
    const vm = createWorkflowLifecycleViewModel()
    const out = renderPlainWorkflowLifecycle(vm)
    expect(out).toContain('Workflow Lifecycle')
    expect(out).toContain('Workflow: test-workflow')
    expect(out).toContain('Current Run:')
    expect(out).toContain('Canonical Stages:')
    expect(out).toContain('Stages:')
  })

  it('has no box-drawing characters', () => {
    assertNoBoxDrawing(renderPlainWorkflowLifecycle(createWorkflowLifecycleViewModel()))
  })

  it('has no ANSI escape sequences', () => {
    assertNoAnsi(renderPlainWorkflowLifecycle(createWorkflowLifecycleViewModel()))
  })

  it('no line exceeds 80 columns', () => {
    assertNoLineExceeds80(renderPlainWorkflowLifecycle(createWorkflowLifecycleViewModel()))
  })

  it('handles empty stages safely', () => {
    const vm: WorkflowLifecycleViewModel = {
      ...createWorkflowLifecycleViewModel(),
      stages: [],
      phaseIssues: [],
    }
    const out = renderPlainWorkflowLifecycle(vm)
    expect(out).toContain('Workflow Lifecycle')
    assertNoLineExceeds80(out)
  })

  it('renders status summary', () => {
    const vm: WorkflowLifecycleViewModel = {
      ...createWorkflowLifecycleViewModel(),
      statusSummary: 'Blocked at review stage, owner: team-lead',
    }
    const out = renderPlainWorkflowLifecycle(vm)
    expect(out).toContain('Status: Blocked at review stage, owner: team-lead')
    assertNoLineExceeds80(out)
  })

  it('renders blocked gate items', () => {
    const vm: WorkflowLifecycleViewModel = {
      ...createWorkflowLifecycleViewModel(),
      blockedGateItems: [
        { gate: 'Coverage', detail: 'Below 80% threshold', action: 'Add tests for new modules' },
        { gate: 'Review', detail: 'No CODEOWNER approval', action: 'Request review from team-lead' },
      ],
    }
    const out = renderPlainWorkflowLifecycle(vm)
    expect(out).toContain('Blocked Gates:')
    expect(out).toContain('[FAIL] Coverage: Below 80% threshold')
    expect(out).toContain('Fix: Add tests for new modules')
    expect(out).toContain('[FAIL] Review: No CODEOWNER approval')
    assertNoLineExceeds80(out)
  })

  it('renders stage owner in model without crashing plain-render', () => {
    const vm: WorkflowLifecycleViewModel = {
      ...createWorkflowLifecycleViewModel(),
      stages: [
        { name: 'review', label: 'Review', status: 'in-progress', icon: 'running', detail: 'Awaiting approval', owner: 'team-lead' },
        { name: 'run', label: 'Run', status: 'pending', icon: 'clock', detail: 'Not started' },
      ],
    }
    const out = renderPlainWorkflowLifecycle(vm)
    // plain-render does not show owner, but must not crash
    expect(out).toContain('Workflow Lifecycle')
    assertNoLineExceeds80(out)
  })
})

// --- Workflow Lifecycle Mapper ---

describe('mapWorkflowLifecycleToViewModel', () => {
  it('maps stage owner through sanitize', () => {
    const vm = mapWorkflowLifecycleToViewModel({
      stages: [
        { name: 'review', label: 'Review', status: 'in-progress', icon: 'running', detail: 'Awaiting approval', owner: 'team-lead\x1B[31m' },
      ],
      phaseIssues: [],
    })
    expect(vm.stages[0].owner).toBe('team-lead')
  })

  it('omits owner when not provided', () => {
    const vm = mapWorkflowLifecycleToViewModel({
      stages: [
        { name: 'run', label: 'Run', status: 'pending', icon: 'clock', detail: 'Not started' },
      ],
      phaseIssues: [],
    })
    expect(vm.stages[0].owner).toBeUndefined()
  })
})

// --- Workflow Workbench ---

describe('renderPlainWorkflowWorkbench', () => {
  it('contains expected markers', () => {
    const vm = createWorkflowWorkbenchViewModel()
    const out = renderPlainWorkflowWorkbench(vm)
    expect(out).toContain('Workflow Workbench')
    expect(out).toContain('Total: 2  YAML: 1  JS: 1')
    expect(out).toContain('Workflow Home Actions:')
    expect(out).toContain('Start a workflow')
    expect(out).toContain('Watch running workflows')
    expect(out).toContain('Handle paused workflow approvals')
    expect(out).toContain('Save/share workflow')
    expect(out).toContain('Publish workflow to GitHub Issues')
    expect(out).toContain('Pattern Start:')
    expect(out).toContain('test-workflow')
    expect(out).toContain('deploy-workflow')
  })

  it('has no box-drawing characters', () => {
    assertNoBoxDrawing(renderPlainWorkflowWorkbench(createWorkflowWorkbenchViewModel()))
  })

  it('has no ANSI escape sequences', () => {
    assertNoAnsi(renderPlainWorkflowWorkbench(createWorkflowWorkbenchViewModel()))
  })

  it('no line exceeds 80 columns', () => {
    assertNoLineExceeds80(renderPlainWorkflowWorkbench(createWorkflowWorkbenchViewModel()))
  })

  it('handles empty gallery safely', () => {
    const vm: WorkflowGalleryViewModel = {
      workflows: [],
      summary: { total: 0, yaml: 0, js: 0 },
    }
    const out = renderPlainWorkflowWorkbench(vm)
    expect(out).toContain('No workflows found.')
    assertNoLineExceeds80(out)
  })
})

// --- Dashboard ---

describe('renderPlainDashboard', () => {
  it('contains expected markers', () => {
    const vm = createDashboardViewModel()
    const out = renderPlainDashboard(vm)
    expect(out).toContain('OpenSlack Team Dashboard')
    expect(out).toContain('Blockers:')
    expect(out).toContain('Open Handoffs:')
    expect(out).toContain('Active Decisions:')
    expect(out).toContain('Recent Activity:')
    expect(out).toContain('PR #130')
  })

  it('has no box-drawing characters', () => {
    assertNoBoxDrawing(renderPlainDashboard(createDashboardViewModel()))
  })

  it('has no ANSI escape sequences', () => {
    assertNoAnsi(renderPlainDashboard(createDashboardViewModel()))
  })

  it('no line exceeds 80 columns', () => {
    assertNoLineExceeds80(renderPlainDashboard(createDashboardViewModel()))
  })

  it('handles empty data safely', () => {
    const vm: DashboardViewModel = {
      title: 'OpenSlack Team Dashboard',
      generatedAt: '2026-05-31T12:00:00Z',
      summary: { blockers: 0, handoffs: 0, decisions: 0 },
      blockers: [],
      handoffs: [],
      decisions: [],
      recentActivity: [],
    }
    const out = renderPlainDashboard(vm)
    expect(out).toContain('Blockers: 0')
    assertNoLineExceeds80(out)
  })

  it('preserves CJK in blocker summaries', () => {
    const vm: DashboardViewModel = {
      ...createDashboardViewModel(),
      blockers: [
        {
          object: 'プロジェクト #99',
          summary: '검사 실패: 에러 발생',
          severity: 'high',
        },
      ],
    }
    const out = renderPlainDashboard(vm)
    expect(out).toContain('プロジェクト #99')
    expect(out).toContain('검사 실패: 에러 발생')
    assertNoLineExceeds80(out)
  })
})

// --- Activity ---

describe('renderPlainActivity', () => {
  it('contains expected markers', () => {
    const vm = createActivityViewModel()
    const out = renderPlainActivity(vm)
    expect(out).toContain('Activity Feed')
    expect(out).toContain('Period: 24h')
    expect(out).toContain('Total events: 4')
    expect(out).toContain('Today:')
    expect(out).toContain('pr.merged')
    expect(out).toContain('PR #127 merged')
    expect(out).toContain('agent-a')
  })

  it('has no box-drawing characters', () => {
    assertNoBoxDrawing(renderPlainActivity(createActivityViewModel()))
  })

  it('has no ANSI escape sequences', () => {
    assertNoAnsi(renderPlainActivity(createActivityViewModel()))
  })

  it('no line exceeds 80 columns', () => {
    assertNoLineExceeds80(renderPlainActivity(createActivityViewModel()))
  })

  it('handles empty data safely', () => {
    const vm: ActivityViewModel = {
      title: 'Activity Feed',
      periodHours: 24,
      totalEvents: 0,
      events: [],
      today: [],
      yesterday: [],
      older: [],
    }
    const out = renderPlainActivity(vm)
    expect(out).toContain('No events in this period.')
    assertNoLineExceeds80(out)
  })

  it('preserves CJK in event summaries', () => {
    const vm: ActivityViewModel = {
      ...createActivityViewModel(),
      today: [
        { time: '12:00', type: 'pr.merged', summary: 'PR #127 承認完了: マージ済み', actor: '에이전트', objectKind: 'pr', objectId: '127' },
      ],
    }
    const out = renderPlainActivity(vm)
    expect(out).toContain('承認完了: マージ済み')
    expect(out).toContain('에이전트')
    assertNoLineExceeds80(out)
  })

  it('renders events with next action', () => {
    const vm: ActivityViewModel = {
      ...createActivityViewModel(),
      today: [
        { time: '10:00', type: 'approval.requested', summary: 'PR needs review', actor: 'agent-a', objectKind: 'pr', objectId: '130', nextAction: 'Review and approve' },
      ],
    }
    const out = renderPlainActivity(vm)
    expect(out).toContain('Next: Review and approve')
    assertNoLineExceeds80(out)
  })
})

// --- Decision List ---

describe('renderPlainDecisionList', () => {
  it('contains expected markers', () => {
    const vm = createDecisionListViewModel()
    const out = renderPlainDecisionList(vm)
    expect(out).toContain('Decisions')
    expect(out).toContain('Total: 2  Active: 1')
    expect(out).toContain('[ACTIVE] Adopt new branching strategy')
    expect(out).toContain('Decision: Approved')
  })

  it('has no box-drawing characters', () => {
    assertNoBoxDrawing(renderPlainDecisionList(createDecisionListViewModel()))
  })

  it('has no ANSI escape sequences', () => {
    assertNoAnsi(renderPlainDecisionList(createDecisionListViewModel()))
  })

  it('no line exceeds 80 columns', () => {
    assertNoLineExceeds80(renderPlainDecisionList(createDecisionListViewModel()))
  })

  it('handles empty list safely', () => {
    const vm: DecisionListViewModel = {
      title: 'Decisions',
      totalCount: 0,
      activeCount: 0,
      items: [],
    }
    const out = renderPlainDecisionList(vm)
    expect(out).toContain('No decisions recorded.')
    assertNoLineExceeds80(out)
  })

  it('preserves CJK in topic names', () => {
    const vm: DecisionListViewModel = {
      ...createDecisionListViewModel(),
      items: [
        { id: 'd-001', topic: '배포 전략 변경', decision: '승인됨', status: 'active', decidedBy: '리더', age: '1d' },
      ],
    }
    const out = renderPlainDecisionList(vm)
    expect(out).toContain('배포 전략 변경')
    expect(out).toContain('승인됨')
    assertNoLineExceeds80(out)
  })
})

// --- Decision Detail ---

describe('renderPlainDecisionDetail', () => {
  it('contains expected markers', () => {
    const vm = createDecisionDetailViewModel()
    const out = renderPlainDecisionDetail(vm)
    expect(out).toContain('Decision: Adopt new branching strategy')
    expect(out).toContain('Status: active')
    expect(out).toContain('Rationale:')
    expect(out).toContain('Alternatives:')
    expect(out).toContain('Consequences:')
    expect(out).toContain('Tags: branching, process')
  })

  it('has no box-drawing characters', () => {
    assertNoBoxDrawing(renderPlainDecisionDetail(createDecisionDetailViewModel()))
  })

  it('has no ANSI escape sequences', () => {
    assertNoAnsi(renderPlainDecisionDetail(createDecisionDetailViewModel()))
  })

  it('no line exceeds 80 columns', () => {
    assertNoLineExceeds80(renderPlainDecisionDetail(createDecisionDetailViewModel()))
  })

  it('handles minimal data safely', () => {
    const vm: DecisionDetailViewModel = {
      id: 'd-001',
      topic: 'Minimal decision',
      decision: 'Pending',
      rationale: '',
      alternatives: [],
      consequences: [],
      decidedBy: 'unknown',
      createdAt: '2026-06-01T00:00:00Z',
      status: 'active',
      tags: [],
    }
    const out = renderPlainDecisionDetail(vm)
    expect(out).toContain('Decision: Minimal decision')
    assertNoLineExceeds80(out)
  })

  it('renders superseded info', () => {
    const vm: DecisionDetailViewModel = {
      ...createDecisionDetailViewModel(),
      supersededBy: 'd-003',
      supersededAt: '2026-06-01T12:00:00Z',
    }
    const out = renderPlainDecisionDetail(vm)
    expect(out).toContain('Superseded by: d-003')
    expect(out).toContain('Superseded at: 2026-06-01T12:00:00Z')
  })
})

// --- Digest ---

describe('renderPlainDigest', () => {
  it('contains expected markers', () => {
    const vm = createDigestViewModel()
    const out = renderPlainDigest(vm)
    expect(out).toContain('OpenSlack Digest')
    expect(out).toContain('Period: 24h')
    expect(out).toContain('Total events: 5')
    expect(out).toContain('[PASS] Completed')
    expect(out).toContain('[FAIL] Blocked')
    expect(out).toContain('Recommended Next:')
  })

  it('has no box-drawing characters', () => {
    assertNoBoxDrawing(renderPlainDigest(createDigestViewModel()))
  })

  it('has no ANSI escape sequences', () => {
    assertNoAnsi(renderPlainDigest(createDigestViewModel()))
  })

  it('no line exceeds 80 columns', () => {
    assertNoLineExceeds80(renderPlainDigest(createDigestViewModel()))
  })

  it('handles empty digest safely', () => {
    const vm: DigestViewModel = {
      title: 'OpenSlack Digest',
      periodHours: 24,
      totalEvents: 0,
      groups: [],
      recommendedNext: [],
    }
    const out = renderPlainDigest(vm)
    expect(out).toContain('No events in this period.')
    assertNoLineExceeds80(out)
  })

  it('preserves CJK in group events', () => {
    const vm: DigestViewModel = {
      ...createDigestViewModel(),
      groups: [
        {
          label: '완료됨',
          count: 1,
          status: 'pass',
          events: [
            { time: '12:00', type: 'pr.merged', summary: 'PR 承認完了', objectKind: 'pr', objectId: '127' },
          ],
        },
      ],
    }
    const out = renderPlainDigest(vm)
    expect(out).toContain('완료됨')
    expect(out).toContain('承認完了')
    assertNoLineExceeds80(out)
  })
})

// --- Handoff List ---

describe('renderPlainHandoffList', () => {
  it('contains expected markers', () => {
    const vm = createHandoffListViewModel()
    const out = renderPlainHandoffList(vm)
    expect(out).toContain('Handoffs')
    expect(out).toContain('Total: 2  Open: 1')
    expect(out).toContain('[OPEN] agent-a -> agent-b')
    expect(out).toContain('[CLOSED]')
    expect(out).toContain('Ref: pr:130')
  })

  it('has no box-drawing characters', () => {
    assertNoBoxDrawing(renderPlainHandoffList(createHandoffListViewModel()))
  })

  it('has no ANSI escape sequences', () => {
    assertNoAnsi(renderPlainHandoffList(createHandoffListViewModel()))
  })

  it('no line exceeds 80 columns', () => {
    assertNoLineExceeds80(renderPlainHandoffList(createHandoffListViewModel()))
  })

  it('handles empty list safely', () => {
    const vm: HandoffListViewModel = {
      title: 'Handoffs',
      totalCount: 0,
      openCount: 0,
      items: [],
    }
    const out = renderPlainHandoffList(vm)
    expect(out).toContain('No handoffs.')
    assertNoLineExceeds80(out)
  })

  it('preserves CJK in context', () => {
    const vm: HandoffListViewModel = {
      ...createHandoffListViewModel(),
      items: [
        { id: 'h-001', from: '에이전트A', to: '에이전트B', status: 'open', context: 'PR 검토 계속: 시스템 확인 필요', age: '2h', ref: 'pr:130' },
      ],
    }
    const out = renderPlainHandoffList(vm)
    expect(out).toContain('에이전트A')
    expect(out).toContain('PR 검토 계속: 시스템 확인 필요')
    assertNoLineExceeds80(out)
  })
})

// --- Handoff Detail ---

describe('renderPlainHandoffDetail', () => {
  it('contains expected markers', () => {
    const vm = createHandoffDetailViewModel()
    const out = renderPlainHandoffDetail(vm)
    expect(out).toContain('Handoff: h-001')
    expect(out).toContain('Status: open')
    expect(out).toContain('From: agent-a  To: agent-b')
    expect(out).toContain('Context:')
    expect(out).toContain('Next Steps:')
    expect(out).toContain('Can accept: yes')
  })

  it('has no box-drawing characters', () => {
    assertNoBoxDrawing(renderPlainHandoffDetail(createHandoffDetailViewModel()))
  })

  it('has no ANSI escape sequences', () => {
    assertNoAnsi(renderPlainHandoffDetail(createHandoffDetailViewModel()))
  })

  it('no line exceeds 80 columns', () => {
    assertNoLineExceeds80(renderPlainHandoffDetail(createHandoffDetailViewModel()))
  })

  it('handles minimal data safely', () => {
    const vm: HandoffDetailViewModel = {
      id: 'h-001',
      status: 'closed',
      from: 'agent-a',
      to: 'agent-b',
      createdAt: '2026-05-31T10:00:00Z',
      closedAt: '2026-05-31T12:00:00Z',
      context: 'Done',
      nextSteps: [],
      canAccept: false,
      canClose: false,
    }
    const out = renderPlainHandoffDetail(vm)
    expect(out).toContain('Handoff: h-001')
    expect(out).toContain('Can accept: no')
    assertNoLineExceeds80(out)
  })

  it('renders notes and refs', () => {
    const vm: HandoffDetailViewModel = {
      ...createHandoffDetailViewModel(),
      notes: 'Additional context for handoff',
      issueRef: 'issue:119',
      prRef: 'pr:130',
    }
    const out = renderPlainHandoffDetail(vm)
    expect(out).toContain('Notes:')
    expect(out).toContain('Additional context for handoff')
    expect(out).toContain('Issue: issue:119')
    expect(out).toContain('PR: pr:130')
  })
})

// --- Issues / PRs ---

describe('renderPlainIssuesPr', () => {
  it('contains expected markers', () => {
    const vm = createIssuesPrViewModel()
    const out = renderPlainIssuesPr(vm)
    expect(out).toContain('Pull Requests')
    expect(out).toContain('Issues:')
    expect(out).toContain('[CLAIMED] #119')
    expect(out).toContain('[READY] #120')
    expect(out).toContain('[READY] #127')
    expect(out).toContain('[BLOCKED] #130')
  })

  it('has no box-drawing characters', () => {
    assertNoBoxDrawing(renderPlainIssuesPr(createIssuesPrViewModel()))
  })

  it('has no ANSI escape sequences', () => {
    assertNoAnsi(renderPlainIssuesPr(createIssuesPrViewModel()))
  })

  it('no line exceeds 80 columns', () => {
    assertNoLineExceeds80(renderPlainIssuesPr(createIssuesPrViewModel()))
  })

  it('handles empty data safely', () => {
    const vm: IssuesPrViewModel = {
      tab: 'issues',
      issues: [],
      prs: [],
      summary: {
        issues: { total: 0, ready: 0, claimed: 0, blocked: 0 },
        prs: { total: 0, ready: 0, blocked: 0, pending: 0 },
      },
    }
    const out = renderPlainIssuesPr(vm)
    expect(out).toContain('No issues.')
    expect(out).toContain('No pull requests.')
    assertNoLineExceeds80(out)
  })

  it('renders issue labels', () => {
    const out = renderPlainIssuesPr(createIssuesPrViewModel())
    expect(out).toContain('[bug, priority:high]')
    expect(out).toContain('[enhancement]')
  })

  it('renders PR blocker and next action', () => {
    const out = renderPlainIssuesPr(createIssuesPrViewModel())
    expect(out).toContain('CI checks failing')
    expect(out).toContain('Next: Fix test failures')
  })
})

// --- Setup ---

describe('renderPlainSetup', () => {
  it('contains expected markers', () => {
    const vm = createSetupViewModel()
    const out = renderPlainSetup(vm)
    expect(out).toContain('OpenSlack Setup Report')
    expect(out).toContain('[WARN] almost ready')
    expect(out).toContain('Checks: 2/4 passed')
    expect(out).toContain('Fixable (1):')
    expect(out).toContain('[WARN] Create required labels')
    expect(out).toContain('Needs Action (1):')
    expect(out).toContain('[FAIL] Enable branch protection')
    expect(out).toContain('Passed (2):')
  })

  it('has no box-drawing characters', () => {
    assertNoBoxDrawing(renderPlainSetup(createSetupViewModel()))
  })

  it('has no ANSI escape sequences', () => {
    assertNoAnsi(renderPlainSetup(createSetupViewModel()))
  })

  it('no line exceeds 80 columns', () => {
    assertNoLineExceeds80(renderPlainSetup(createSetupViewModel()))
  })

  it('handles fully ready setup safely', () => {
    const vm: SetupViewModel = {
      readiness: 'ready',
      root: '/home/user/project',
      totalChecks: 3,
      passedChecks: 3,
      fixable: [],
      needsAction: [],
      ok: [
        { id: 'repo', title: 'Repository accessible', status: 'PASS', detail: 'Connected', nextAction: '', command: '' },
        { id: 'git', title: 'Git available', status: 'PASS', detail: 'Git 2.40+', nextAction: '', command: '' },
        { id: 'cli', title: 'CLI installed', status: 'PASS', detail: 'v0.1', nextAction: '', command: '' },
      ],
    }
    const out = renderPlainSetup(vm)
    expect(out).toContain('[PASS] ready')
    expect(out).toContain('OpenSlack is fully set up.')
    assertNoLineExceeds80(out)
  })

  it('handles needs-setup-help readiness', () => {
    const vm: SetupViewModel = {
      readiness: 'needs setup help',
      root: '/home/user/project',
      totalChecks: 2,
      passedChecks: 0,
      fixable: [],
      needsAction: [
        { id: 'auth', title: 'GitHub authentication', status: 'FAIL', detail: 'No token found', nextAction: 'Configure token', command: '' },
      ],
      ok: [],
    }
    const out = renderPlainSetup(vm)
    expect(out).toContain('[FAIL] needs setup help')
    expect(out).toContain('[FAIL] GitHub authentication')
    assertNoLineExceeds80(out)
  })
})

// --- Status ---

describe('renderPlainStatus', () => {
  it('contains expected markers', () => {
    const vm = createStatusViewModel()
    const out = renderPlainStatus(vm)
    expect(out).toContain('OpenSlack Status')
    expect(out).toContain('Version: v0.1 Developer Preview')
    expect(out).toContain('Commit: abc1234')
    expect(out).toContain('Modules (5):')
    expect(out).toContain('GitHub:')
    expect(out).toContain('Test Suite: 526 tests across 45 files')
    expect(out).toContain('Recommended Next Steps:')
    expect(out).toContain('Needs Attention:')
    expect(out).toContain('Next: Review PR #130')
  })

  it('has no box-drawing characters', () => {
    assertNoBoxDrawing(renderPlainStatus(createStatusViewModel()))
  })

  it('has no ANSI escape sequences', () => {
    assertNoAnsi(renderPlainStatus(createStatusViewModel()))
  })

  it('no line exceeds 80 columns', () => {
    assertNoLineExceeds80(renderPlainStatus(createStatusViewModel()))
  })

  it('handles empty data safely', () => {
    const vm: StatusViewModel = {
      title: 'OpenSlack Status',
      version: 'v0.1',
      commit: 'abc123',
      commitSubject: 'Initial commit',
      modules: [],
      gitHub: { available: false, tasksReady: 0, tasksClaimed: 0, tasksBlocked: 0, prsOpen: 0, prsBlocked: 0, prsReady: 0 },
      testSuite: { totalTests: 0, totalFiles: 0 },
      recommendations: [],
      attentionItems: [],
      nextAction: 'Run openslack setup',
    }
    const out = renderPlainStatus(vm)
    expect(out).toContain('unavailable')
    expect(out).toContain('All clear')
    assertNoLineExceeds80(out)
  })

  it('preserves CJK in attention items', () => {
    const vm: StatusViewModel = {
      ...createStatusViewModel(),
      attentionItems: [
        { type: 'PR', description: 'PR #130 テスト失敗: 修正必要', action: 'テストを修正', priority: 'high' },
      ],
    }
    const out = renderPlainStatus(vm)
    expect(out).toContain('テスト失敗: 修正必要')
    expect(out).toContain('テストを修正')
    assertNoLineExceeds80(out)
  })
})

// --- Shell ---

describe('renderPlainShell', () => {
  it('renders all sections when data is provided', () => {
    const data = createShellViewData()
    const out = renderPlainShell(data)
    expect(out).toContain('OpenSlack Team Dashboard')
    expect(out).toContain('OpenSlack Status')
    expect(out).toContain('PR Queue')
    expect(out).toContain('Organization Profile')
  })

  it('has no box-drawing characters', () => {
    assertNoBoxDrawing(renderPlainShell(createShellViewData()))
  })

  it('has no ANSI escape sequences', () => {
    assertNoAnsi(renderPlainShell(createShellViewData()))
  })

  it('no line exceeds 80 columns', () => {
    assertNoLineExceeds80(renderPlainShell(createShellViewData()))
  })

  it('handles empty shell data', () => {
    const out = renderPlainShell({})
    expect(out).toContain('OpenSlack Shell')
    expect(out).toContain('No views loaded.')
    assertNoLineExceeds80(out)
  })

  it('renders partial shell data', () => {
    const out = renderPlainShell({ dashboard: createDashboardViewModel() })
    expect(out).toContain('OpenSlack Team Dashboard')
    expect(out).not.toContain('OpenSlack Status')
    assertNoLineExceeds80(out)
  })
})

// --- Workflow Preview ---

describe('renderPlainWorkflowPreview', () => {
  it('contains expected markers', () => {
    const vm = createWorkflowPreviewViewModel()
    const out = renderPlainWorkflowPreview(vm)
    expect(out).toContain('Workflow: Test Workflow')
    expect(out).toContain('Template: test-workflow')
    expect(out).toContain('Steps: 2  Phases: 2')
    expect(out).toContain('Side effects: yes')
    expect(out).toContain('Phase: Setup')
    expect(out).toContain('Phase: Execute')
    expect(out).toContain('Run setup')
    expect(out).toContain('Execute task')
  })

  it('has no box-drawing characters', () => {
    assertNoBoxDrawing(renderPlainWorkflowPreview(createWorkflowPreviewViewModel()))
  })

  it('has no ANSI escape sequences', () => {
    assertNoAnsi(renderPlainWorkflowPreview(createWorkflowPreviewViewModel()))
  })

  it('no line exceeds 80 columns', () => {
    assertNoLineExceeds80(renderPlainWorkflowPreview(createWorkflowPreviewViewModel()))
  })

  it('handles empty steps safely', () => {
    const vm: WorkflowPreviewViewModel = {
      templateId: 'empty',
      name: 'Empty Workflow',
      correlationId: 'corr-000',
      steps: [],
      phases: [],
      phaseCount: 0,
      stepCount: 0,
      hasSideEffects: false,
      requiresConfirmation: false,
      errors: [],
      hasErrors: false,
    }
    const out = renderPlainWorkflowPreview(vm)
    expect(out).toContain('No steps in this workflow.')
    assertNoLineExceeds80(out)
  })

  it('renders errors', () => {
    const vm: WorkflowPreviewViewModel = {
      ...createWorkflowPreviewViewModel(),
      errors: ['Step 3 has invalid action', 'Missing required field: phase'],
      hasErrors: true,
    }
    const out = renderPlainWorkflowPreview(vm)
    expect(out).toContain('Errors:')
    expect(out).toContain('[FAIL] Step 3 has invalid action')
    expect(out).toContain('[FAIL] Missing required field: phase')
  })

  it('renders step flags correctly', () => {
    const out = renderPlainWorkflowPreview(createWorkflowPreviewViewModel())
    expect(out).toContain('read-only')
    expect(out).toContain('side-effect')
  })
})

// --- renderPlain dispatch ---

describe('renderPlain dispatch', () => {
  it('dispatches to correct renderer', () => {
    expect(renderPlain('home', createHomeViewModel())).toContain('OpenSlack Home')
    expect(renderPlain('doctor', createDoctorViewModel())).toContain('PR Doctor -- #42')
    expect(renderPlain('pr-queue', createPrQueueViewModel())).toContain('PR Queue')
    expect(renderPlain('profile', createProfileViewModel())).toContain('Organization Profile')
    expect(renderPlain('workflow-lifecycle', createWorkflowLifecycleViewModel())).toContain('Workflow Lifecycle')
    expect(renderPlain('workflow-workbench', createWorkflowWorkbenchViewModel())).toContain('Workflow Workbench')
    expect(renderPlain('dashboard', createDashboardViewModel())).toContain('OpenSlack Team Dashboard')
    expect(renderPlain('activity', createActivityViewModel())).toContain('Activity Feed')
    expect(renderPlain('decision-list', createDecisionListViewModel())).toContain('Decisions')
    expect(renderPlain('decision-detail', createDecisionDetailViewModel())).toContain('Decision: Adopt new branching strategy')
    expect(renderPlain('digest', createDigestViewModel())).toContain('OpenSlack Digest')
    expect(renderPlain('handoff-list', createHandoffListViewModel())).toContain('Handoffs')
    expect(renderPlain('handoff-detail', createHandoffDetailViewModel())).toContain('Handoff: h-001')
    expect(renderPlain('issues-pr', createIssuesPrViewModel())).toContain('Pull Requests')
    expect(renderPlain('setup', createSetupViewModel())).toContain('OpenSlack Setup Report')
    expect(renderPlain('status', createStatusViewModel())).toContain('OpenSlack Status')
    expect(renderPlain('shell', createShellViewData())).toContain('OpenSlack Team Dashboard')
    expect(renderPlain('workflow-preview', createWorkflowPreviewViewModel())).toContain('Workflow: Test Workflow')
  })

  it('returns fallback for unknown view', () => {
    expect(renderPlain('unknown', {})).toContain('Plain rendering not available')
  })

  it('passes custom width through to renderers', () => {
    const out = renderPlain('home', createHomeViewModel(), 40)
    assertNoLineExceeds(out, 40)
  })
})

describe('custom width rendering', () => {
  it('keeps core renderers within 40 columns', () => {
    const outputs = [
      renderPlainHome(createHomeViewModel(), 40),
      renderPlainDoctor(createDoctorViewModel(), 40),
      renderPlainPrQueue(createPrQueueViewModel(), 40),
      renderPlainProfile(createProfileViewModel(), 40),
      renderPlainWorkflowLifecycle(createWorkflowLifecycleViewModel(), 40),
      renderPlainWorkflowWorkbench(createWorkflowWorkbenchViewModel(), 40),
      renderPlainDashboard(createDashboardViewModel(), 40),
      renderPlainActivity(createActivityViewModel(), 40),
      renderPlainDecisionList(createDecisionListViewModel(), 40),
      renderPlainDecisionDetail(createDecisionDetailViewModel(), 40),
      renderPlainDigest(createDigestViewModel(), 40),
      renderPlainHandoffList(createHandoffListViewModel(), 40),
      renderPlainHandoffDetail(createHandoffDetailViewModel(), 40),
      renderPlainIssuesPr(createIssuesPrViewModel(), 40),
      renderPlainSetup(createSetupViewModel(), 40),
      renderPlainStatus(createStatusViewModel(), 40),
      renderPlainShell(createShellViewData(), 40),
      renderPlainWorkflowPreview(createWorkflowPreviewViewModel(), 40),
    ]

    for (const out of outputs) {
      assertNoLineExceeds(out, 40)
    }
  })

  it('wraps long URLs within the requested width', () => {
    const vm: HomeViewModel = {
      ...createHomeViewModel(),
      attentionItems: [
        {
          label: 'PR Review Required',
          detail: 'https://github.com/Negentropy-Laby/OpenSlack/pull/130/files#diff-abc123def456ghi789jkl012',
          route: 'approvals',
          colorTheme: 'warning',
        },
      ],
      allClear: false,
    }

    assertNoLineExceeds(renderPlainHome(vm, 40), 40)
  })

  it('wraps next recommended action within the requested width', () => {
    const vm: HomeViewModel = {
      ...createHomeViewModel(),
      nextRecommendedAction: {
        label: 'Approve profile sync PR https://github.com/Negentropy-Laby/OpenSlack/pull/130/files#diff-abc123def456',
        reason: 'Validation is waiting at https://github.com/Negentropy-Laby/OpenSlack/actions/runs/26736208952/job/78789924481',
        route: 'approvals',
        urgency: 'governance',
        priority: 0,
      },
    }

    assertNoLineExceeds(renderPlainHome(vm, 40), 40)
  })
})

// --- CJK preservation across all renderers ---

describe('CJK preservation across all renderers', () => {
  it('preserves CJK in home view', () => {
    const vm: HomeViewModel = {
      ...createHomeViewModel(),
      attentionItems: [
        { label: '使用者設定', detail: '設定を確認', route: 'status', colorTheme: 'info' },
      ],
      allClear: false,
    }
    expect(renderPlainHome(vm)).toContain('使用者設定')
  })

  it('preserves CJK in doctor view', () => {
    const vm: DoctorViewModel = {
      ...createDoctorViewModel(),
      title: 'PR: セキュリティ修正',
      reason: 'すべてのゲートが通過しました',
    }
    expect(renderPlainDoctor(vm)).toContain('セキュリティ修正')
    expect(renderPlainDoctor(vm)).toContain('すべてのゲートが通過しました')
  })

  it('preserves CJK in PR queue view', () => {
    const vm: PrQueueViewModel = {
      ...createPrQueueViewModel(),
      items: [{
        ...createPrQueueViewModel().items[0]!,
        title: '배포 워크플로우 수정',
      }],
    }
    expect(renderPlainPrQueue(vm)).toContain('배포 워크플로우 수정')
  })

  it('preserves CJK in profile view', () => {
    const vm: ProfileViewModel = {
      ...createProfileViewModel(),
      targetRepo: '내-조직/프로필',
    }
    expect(renderPlainProfile(vm)).toContain('내-조직/프로필')
  })

  it('preserves CJK in workflow lifecycle view', () => {
    const vm: WorkflowLifecycleViewModel = {
      ...createWorkflowLifecycleViewModel(),
      workflowName: '검사-워크플로우',
    }
    expect(renderPlainWorkflowLifecycle(vm)).toContain('검사-워크플로우')
  })

  it('preserves CJK in dashboard view', () => {
    const vm: DashboardViewModel = {
      ...createDashboardViewModel(),
      decisions: [
        { id: 'd-002', topic: 'デプロイ戦略の変更', status: 'active', decidedBy: 'リーダー' },
      ],
    }
    expect(renderPlainDashboard(vm)).toContain('デプロイ戦略の変更')
  })

  it('preserves CJK in activity view', () => {
    const vm: ActivityViewModel = {
      ...createActivityViewModel(),
      today: [
        { time: '12:00', type: 'pr.merged', summary: 'PR 承認完了: マージ', actor: '에이전트', objectKind: 'pr', objectId: '127' },
      ],
    }
    expect(renderPlainActivity(vm)).toContain('承認完了: マージ')
  })

  it('preserves CJK in decision list view', () => {
    const vm: DecisionListViewModel = {
      ...createDecisionListViewModel(),
      items: [
        { id: 'd-003', topic: '배포 전략 변경', decision: '승인', status: 'active', decidedBy: '리더', age: '1d' },
      ],
    }
    expect(renderPlainDecisionList(vm)).toContain('배포 전략 변경')
  })

  it('preserves CJK in decision detail view', () => {
    const vm: DecisionDetailViewModel = {
      ...createDecisionDetailViewModel(),
      topic: 'デプロイ戦略',
      rationale: '安全性を重視',
    }
    expect(renderPlainDecisionDetail(vm)).toContain('デプロイ戦略')
    expect(renderPlainDecisionDetail(vm)).toContain('安全性を重視')
  })

  it('preserves CJK in digest view', () => {
    const vm: DigestViewModel = {
      ...createDigestViewModel(),
      groups: [{
        label: '완료',
        count: 1,
        status: 'pass',
        events: [{ time: '12:00', type: 'pr.merged', summary: 'マージ完了', objectKind: 'pr', objectId: '127' }],
      }],
    }
    expect(renderPlainDigest(vm)).toContain('マージ完了')
  })

  it('preserves CJK in handoff list view', () => {
    const vm: HandoffListViewModel = {
      ...createHandoffListViewModel(),
      items: [
        { id: 'h-003', from: '에이전트A', to: '에이전트B', status: 'open', context: 'PR 검토 중', age: '1h', ref: 'pr:130' },
      ],
    }
    expect(renderPlainHandoffList(vm)).toContain('PR 검토 중')
  })

  it('preserves CJK in handoff detail view', () => {
    const vm: HandoffDetailViewModel = {
      ...createHandoffDetailViewModel(),
      context: 'PR 검토 계속: 시스템 확인',
      notes: '追加メモ',
    }
    expect(renderPlainHandoffDetail(vm)).toContain('PR 검토 계속: 시스템 확인')
    expect(renderPlainHandoffDetail(vm)).toContain('追加メモ')
  })

  it('preserves CJK in issues/PRs view', () => {
    const vm: IssuesPrViewModel = {
      ...createIssuesPrViewModel(),
      issues: [
        { number: 99, title: '인증 흐름 수정', status: 'ready', labels: ['버그'] },
      ],
    }
    expect(renderPlainIssuesPr(vm)).toContain('인증 흐름 수정')
  })

  it('preserves CJK in setup view', () => {
    const vm: SetupViewModel = {
      ...createSetupViewModel(),
      fixable: [
        { id: 'labels', title: '레이블 생성 필요', status: 'WARN', detail: '라벨 누락', nextAction: '실행', command: 'openslack setup labels' },
      ],
    }
    expect(renderPlainSetup(vm)).toContain('레이블 생성 필요')
  })

  it('preserves CJK in status view', () => {
    const vm: StatusViewModel = {
      ...createStatusViewModel(),
      commitSubject: '認証フロー修正: マージ完了',
    }
    expect(renderPlainStatus(vm)).toContain('認証フロー修正: マージ完了')
  })

  it('preserves CJK in workflow preview view', () => {
    const vm: WorkflowPreviewViewModel = {
      ...createWorkflowPreviewViewModel(),
      name: '배포 워크플로우 v2',
      steps: [
        { phase: 'build', type: 'action', title: '빌드 실행', actionId: 'build', sideEffects: false, requiresConfirmation: false, requiredRole: '' },
      ],
      phases: ['build'],
    }
    expect(renderPlainWorkflowPreview(vm)).toContain('배포 워크플로우 v2')
    expect(renderPlainWorkflowPreview(vm)).toContain('빌드 실행')
  })
})

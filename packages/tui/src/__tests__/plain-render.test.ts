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
  renderPlain,
} from '../plain-render.js'

import {
  createHomeViewModel,
  createDoctorViewModel,
  createPrQueueViewModel,
  createProfileViewModel,
  createWorkflowLifecycleViewModel,
  createWorkflowWorkbenchViewModel,
  createDashboardViewModel,
} from './helpers/view-model-factories.js'

import type { HomeViewModel } from '../view-models/home.js'
import type { DoctorViewModel } from '../view-models/doctor.js'
import type { PrQueueViewModel } from '../view-models/pr-queue.js'
import type { ProfileViewModel } from '../view-models/profile.js'
import type { WorkflowLifecycleViewModel } from '../view-models/workflow-lifecycle.js'
import type { WorkflowGalleryViewModel } from '../view-models/workflow-gallery.js'
import type { DashboardViewModel } from '../view-models/dashboard.js'

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
  const lines = output.split('\n')
  for (const line of lines) {
    const visualWidth = stringWidth(line)
    expect(visualWidth, `Line exceeds 80 columns (${visualWidth}): "${line}"`).toBeLessThanOrEqual(80)
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
})

// --- Workflow Workbench ---

describe('renderPlainWorkflowWorkbench', () => {
  it('contains expected markers', () => {
    const vm = createWorkflowWorkbenchViewModel()
    const out = renderPlainWorkflowWorkbench(vm)
    expect(out).toContain('Workflow Workbench')
    expect(out).toContain('Total: 2  YAML: 1  JS: 1')
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
  })

  it('returns fallback for unknown view', () => {
    expect(renderPlain('unknown', {})).toContain('Plain rendering not available')
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
})

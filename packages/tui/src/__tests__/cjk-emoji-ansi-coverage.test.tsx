/**
 * cjk-emoji-ansi-coverage.test.tsx -- CJK/emoji/ANSI coverage tests across all 7 TUI views.
 *
 * Tests that all 7 key views render correctly with:
 * - CJK labels (Chinese, Japanese, Korean)
 * - Emoji in titles, PR names, workflow names, status text
 * - Long URLs that exceed container width
 * - ANSI escape sequences in external strings (must be stripped)
 * - Mixed ASCII + CJK + emoji on the same line
 *
 * For each test:
 * 1. Create a view model with problematic input
 * 2. Render at 100 columns
 * 3. Assert no line exceeds column width
 * 4. Assert no raw ANSI escape sequences appear in output
 * 5. Assert content is still readable (key markers present)
 */
import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from '@openslack/tui'
import { NavigationProvider } from '../navigation/context.js'
import stripAnsi from 'strip-ansi'

import HomeView from '../views/HomeView.js'
import DoctorView from '../views/DoctorView.js'
import PrQueueView from '../views/PrQueueView.js'
import ProfileView from '../views/ProfileView.js'
import WorkflowLifecycleView from '../views/WorkflowLifecycleView.js'
import WorkflowWorkbenchView from '../views/WorkflowWorkbenchView.js'
import DashboardView from '../views/DashboardView.js'

import type { HomeViewModel } from '../view-models/home.js'
import type { DoctorViewModel } from '../view-models/doctor.js'
import type { PrQueueViewModel } from '../view-models/pr-queue.js'
import type { ProfileViewModel } from '../view-models/profile.js'
import type { WorkflowLifecycleViewModel } from '../view-models/workflow-lifecycle.js'
import type { WorkflowGalleryViewModel } from '../view-models/workflow-gallery.js'
import type { DashboardViewModel } from '../view-models/dashboard.js'

import { assertNoLineExceedsWidth } from './helpers/render-at-columns.js'

import { Writable } from 'stream'

// -- Test helpers --

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

async function renderAt(element: React.ReactElement, cols = 100): Promise<string> {
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

/** Assert that the output does not contain raw ESC (0x1b) after stripping Ink colors. */
function assertNoAnsiInOutput(output: string): void {
  const stripped = stripAnsi(output)
  if (stripped.includes('\x1b')) {
    throw new Error('Output contains unsanitized ANSI escape sequences after stripping Ink colors')
  }
}

// -- Problematic input strings --

const CJK_CHINESE_LABEL = '检查系统状态'
const CJK_JAPANESE_LABEL = 'テスト実行中'
const CJK_KOREAN_LABEL = '시스템 상태 확인'
const EMOJI_TITLE = '🚀 feat: 新機能を追加 🎉'
const LONG_URL = 'https://github.com/Negentropy-Laby/OpenSlack/pull/127/checks?check_suite_id=1234567890&step=build'
const ANSI_COLORED = '\x1b[31mRed Text\x1b[0m Normal'
const ANSI_BOLD = '\x1b[1mBold Title\x1b[0m'
const OSC_HYPERLINK = '\x1b]8;;https://example.com\x07Click here\x1b]8;;\x07'
const MIXED_CONTENT = '\x1b[32m✅ 你好世界 🎉\x1b[0m — テスト完了'
const CJK_WITH_ANSI = '\x1b[33m⚠️ 警告：检查失败\x1b[0m'

// -- View model factories with problematic input --

function createCjkHomeViewModel(): HomeViewModel {
  return {
    attentionItems: [
      { label: `3 待处理 ${CJK_CHINESE_LABEL}`, detail: `${ANSI_COLORED} - ${CJK_JAPANESE_LABEL}`, route: 'dashboard', colorTheme: 'warning' },
      { label: `⚠️ ${CJK_KOREAN_LABEL}`, detail: LONG_URL, route: 'status', colorTheme: 'warning' },
    ],
    allClear: false,
    navItems: [
      { label: CJK_CHINESE_LABEL, key: 'dashboard', shortcut: '7' },
      { label: 'ワークフロー', key: 'workflows', shortcut: '8' },
      { label: '대시보드', key: 'status', shortcut: '9' },
    ],
    tasks: [
      { key: 'see-attention', label: `查看需要关注的事项 ${CJK_CHINESE_LABEL}`, route: 'dashboard', description: `${CJK_JAPANESE_LABEL} — ${CJK_KOREAN_LABEL}`, shortcut: '1', attentionBadge: '3' },
      { key: 'start-work', label: '作業を開始 🛠️', route: 'workflows', description: `${ANSI_BOLD} and ${EMOJI_TITLE}`, shortcut: '2' },
      { key: 'review-prs', label: `PR 검토 및 병합 🔍`, route: 'pr-queue', description: `${OSC_HYPERLINK} for PR review`, shortcut: '3' },
    ],
    systemStatus: MIXED_CONTENT,
  }
}

function createCjkDoctorViewModel(): DoctorViewModel {
  return {
    prNumber: 42,
    title: `${ANSI_COLORED} ${EMOJI_TITLE} ${CJK_CHINESE_LABEL}`,
    author: `${CJK_JAPANESE_LABEL}-bot`,
    state: 'open',
    draft: false,
    riskZone: 'yellow',
    mergeable: true,
    decision: 'READY_TO_MERGE',
    reason: `${CJK_KOREAN_LABEL} — ${ANSI_BOLD}`,
    recommendation: `${EMOJI_TITLE} — 모든 게이트가 통과했습니다`,
    gates: [
      { name: `${CJK_CHINESE_LABEL} Draft`, status: 'PASS', detail: `${CJK_JAPANESE_LABEL} Ready` },
      { name: 'State', status: 'PASS', detail: `${ANSI_COLORED} Open` },
      { name: 'Merge', status: 'PASS', detail: 'No conflicts' },
      { name: `${CJK_KOREAN_LABEL} Checks`, status: 'WARN', detail: LONG_URL },
      { name: 'Approvals', status: 'PASS', detail: MIXED_CONTENT },
      { name: 'Risk', status: 'PASS', detail: `Zone: ${CJK_WITH_ANSI}` },
    ],
    checks: [
      { name: `ci/${CJK_CHINESE_LABEL}`, status: 'PASS', conclusion: `${ANSI_BOLD} success` },
      { name: `ci/${CJK_JAPANESE_LABEL}`, status: 'WARN', conclusion: 'pending' },
      { name: `ci/${CJK_KOREAN_LABEL}`, status: 'PASS', conclusion: 'success' },
    ],
    reviews: [
      { user: `${CJK_CHINESE_LABEL}-reviewer`, state: 'APPROVED', valid: true },
      { user: `${ANSI_COLORED}-user`, state: 'APPROVED', valid: true },
    ],
    evidence: [
      `${EMOJI_TITLE} — evidence`,
      LONG_URL,
      CJK_WITH_ANSI,
    ],
    compressed: false,
    profileSyncGate: {
      passed: true,
      detail: `${CJK_KOREAN_LABEL} — ${ANSI_COLORED} sync ok`,
    },
  }
}

function createCjkPrQueueViewModel(): PrQueueViewModel {
  return {
    title: 'PR Queue',
    totalPRs: 2,
    readyCount: 1,
    blockedCount: 1,
    pendingCount: 0,
    items: [
      {
        prNumber: 127,
        title: `${ANSI_COLORED} ${EMOJI_TITLE} ${CJK_CHINESE_LABEL}`,
        author: `${CJK_JAPANESE_LABEL}-bot`,
        decision: 'READY_TO_MERGE',
        blockerCategory: 'none',
        owner: `${CJK_KOREAN_LABEL}-lead`,
        canMerge: true,
        riskZone: 'green',
        nextAction: MIXED_CONTENT,
        rerunCommand: `openslack pr doctor 127 ${ANSI_BOLD}`,
        workflowGate: { touched: false, criteria: [], overall: 'N/A' },
      },
      {
        prNumber: 130,
        title: `${CJK_WITH_ANSI} — ${LONG_URL}`,
        author: `${OSC_HYPERLINK}-user`,
        decision: 'BLOCKED',
        blockerCategory: 'checks',
        owner: `${CJK_CHINESE_LABEL}-lead`,
        canMerge: false,
        riskZone: 'yellow',
        nextAction: `${CJK_KOREAN_LABEL}: wait for CI`,
        rerunCommand: `openslack pr doctor 130 ${ANSI_COLORED}`,
        workflowGate: {
          touched: true,
          criteria: [{ name: `${CJK_JAPANESE_LABEL} Coverage`, passed: false }],
          overall: 'FAIL',
        },
      },
    ],
  }
}

function createCjkProfileViewModel(): ProfileViewModel {
  return {
    title: `${CJK_CHINESE_LABEL} — Organization Profile`,
    targetRepo: `Negentropy-Laby/${CJK_JAPANESE_LABEL}`,
    targetPath: `profile/${CJK_KOREAN_LABEL}/README.md`,
    marker: `${ANSI_BOLD}-marker`,
    syncStatus: 'synced',
    lastSyncDate: '2026-05-30T12:00:00Z',
    markerStatus: 'present',
    posts: [
      {
        title: `${ANSI_COLORED} ${EMOJI_TITLE} ${CJK_CHINESE_LABEL}`,
        date: '2026-05-30',
        summary: `${CJK_JAPANESE_LABEL} — ${CJK_KOREAN_LABEL} — ${MIXED_CONTENT}`,
        sourcePath: `posts/${CJK_WITH_ANSI}.md`,
        url: LONG_URL,
      },
      {
        title: `${OSC_HYPERLINK} — ${CJK_KOREAN_LABEL} post`,
        date: '2026-05-29',
        summary: LONG_URL,
        sourcePath: 'posts/2026-05-29.md',
        url: `${ANSI_COLORED}${LONG_URL}`,
      },
    ],
    validationSummary: {
      total: 2,
      published: 2,
      failed: 0,
    },
    syncDetails: {
      sourceCommit: `${ANSI_BOLD}abc1234`,
      sourceDate: '2026-05-30T10:00:00Z',
      targetHash: `${CJK_CHINESE_LABEL}-hash`,
      lastSync: {
        timestamp: '2026-05-30',
        result: 'success',
      },
      mode: 'manual',
    },
    mode: 'manual',
    actions: [
      { id: 'check', key: 'c', label: `检查 ${CJK_CHINESE_LABEL}`, description: `${CJK_JAPANESE_LABEL} check`, risk: 'low' },
      { id: 'preview', key: 'p', label: `プレビュー 🔍`, description: `${ANSI_COLORED} preview`, risk: 'low' },
    ],
  }
}

function createCjkWorkflowLifecycleViewModel(): WorkflowLifecycleViewModel {
  return {
    workflowName: `${ANSI_BOLD} ${CJK_CHINESE_LABEL}-workflow`,
    workflowHash: `${CJK_JAPANESE_LABEL}hash123`,
    trustLevel: `${ANSI_COLORED}trusted`,
    risk: `${CJK_KOREAN_LABEL}-medium`,
    sourcePath: `.openslack/workflows/${EMOJI_TITLE}`,
    stages: [
      { name: 'proposal', label: `${CJK_CHINESE_LABEL} Proposal`, status: 'complete', icon: 'check', issueNumber: 120, detail: `${ANSI_BOLD} ${CJK_JAPANESE_LABEL} accepted` },
      { name: 'review', label: `${CJK_KOREAN_LABEL} Review 🔍`, status: 'complete', icon: 'check', issueNumber: 121, detail: LONG_URL },
      { name: 'run', label: `${EMOJI_TITLE} Run`, status: 'in-progress', icon: 'running', detail: MIXED_CONTENT },
      { name: 'pr', label: `${CJK_WITH_ANSI} PR`, status: 'pending', icon: 'clock', detail: `${ANSI_COLORED} not created` },
      { name: 'merged', label: `${CJK_CHINESE_LABEL} Merged 🎉`, status: 'pending', icon: 'clock', detail: 'Not merged yet' },
    ],
    phaseIssues: [
      { phase: `${ANSI_BOLD}proposal`, issueNumber: 120, status: `${CJK_JAPANESE_LABEL}-closed` },
    ],
    currentRun: {
      runId: `${ANSI_COLORED}run-001`,
      status: `${CJK_KOREAN_LABEL}-running`,
      startedAt: '2026-05-31T10:00:00Z',
      phaseIndex: 2,
    },
    prNumber: undefined,
    prStatus: undefined,
    nextAction: `${MIXED_CONTENT} — wait for completion`,
    subIssueMode: 'native',
    dependencyMode: 'native',
    fallbackReasons: [CJK_WITH_ANSI, LONG_URL],
  }
}

function createCjkWorkflowWorkbenchViewModel(): WorkflowGalleryViewModel {
  return {
    workflows: [
      {
        name: `${ANSI_BOLD} ${CJK_CHINESE_LABEL}-workflow`,
        description: `${EMOJI_TITLE} — ${CJK_JAPANESE_LABEL} description ${LONG_URL}`,
        format: 'yaml',
        trustLevel: `${ANSI_COLORED}trusted`,
        risk: `${CJK_KOREAN_LABEL}-low`,
        phases: 3,
        lastRunStatus: `${CJK_WITH_ANSI}-success`,
      },
      {
        name: `${CJK_KOREAN_LABEL}-deploy 🔧`,
        description: `${OSC_HYPERLINK} — ${MIXED_CONTENT}`,
        format: 'openslack-native',
        trustLevel: 'untrusted',
        risk: `${ANSI_BOLD}medium`,
        phases: 5,
      },
    ],
    summary: {
      total: 2,
      yaml: 1,
      js: 1,
    },
  }
}

function createCjkDashboardViewModel(): DashboardViewModel {
  return {
    title: `${CJK_CHINESE_LABEL} — Team Dashboard`,
    generatedAt: '2026-05-31T12:00:00Z',
    summary: {
      blockers: 1,
      handoffs: 1,
      decisions: 1,
    },
    blockers: [
      { object: `${ANSI_BOLD} PR #130 ${CJK_JAPANESE_LABEL}`, summary: `${CJK_KOREAN_LABEL}: ${EMOJI_TITLE}`, owner: `${ANSI_COLORED}-lead`, nextAction: LONG_URL, severity: `${CJK_WITH_ANSI}-high` },
    ],
    handoffs: [
      { id: `${ANSI_BOLD}-h-001`, from: `${CJK_CHINESE_LABEL}-agent`, to: `${CJK_JAPANESE_LABEL}-agent`, status: 'open', context: MIXED_CONTENT, age: '2h' },
    ],
    decisions: [
      { id: `${ANSI_COLORED}-d-001`, topic: `${CJK_KOREAN_LABEL}: ${EMOJI_TITLE}`, status: 'active', decidedBy: `${OSC_HYPERLINK}-lead` },
    ],
    recentActivity: [
      { time: '12:00 PM', type: 'pr.merged', summary: `${ANSI_BOLD} ${CJK_CHINESE_LABEL} PR #127 merged ${EMOJI_TITLE}`, actor: `${CJK_JAPANESE_LABEL}-agent` },
      { time: '11:30 AM', type: 'task.completed', summary: LONG_URL, actor: `${CJK_KOREAN_LABEL}-agent` },
      { time: '11:00 AM', type: 'check.failed', summary: `${CJK_WITH_ANSI} — ${MIXED_CONTENT}`, actor: `${ANSI_COLORED}-bot` },
    ],
  }
}

// -- Tests --

const COLS = 100

describe('CJK/emoji/ANSI coverage - HomeView', () => {
  it('renders CJK labels without exceeding column width', async () => {
    const model = createCjkHomeViewModel()
    const output = await renderAt(
      withNav(React.createElement(HomeView, { model })),
      COLS,
    )
    assertNoLineExceedsWidth(output, COLS)
    assertNoAnsiInOutput(output)
    expect(output).toContain('OpenSlack')
  })

  it('renders emoji in titles without exceeding column width', async () => {
    const model = createCjkHomeViewModel()
    const output = await renderAt(
      withNav(React.createElement(HomeView, { model })),
      COLS,
    )
    assertNoLineExceedsWidth(output, COLS)
    const stripped = stripAnsi(output)
    expect(stripped).toContain('🛠️')
    expect(stripped).toContain('🔍')
  })

  it('strips ANSI from external strings in output', async () => {
    const model = createCjkHomeViewModel()
    const output = await renderAt(
      withNav(React.createElement(HomeView, { model })),
      COLS,
    )
    assertNoAnsiInOutput(output)
    expect(stripAnsi(output)).not.toContain('\x1b[31m')
    expect(stripAnsi(output)).not.toContain('\x1b[0m')
  })

  it('handles mixed CJK + emoji + ASCII on same line', async () => {
    const model = createCjkHomeViewModel()
    const output = await renderAt(
      withNav(React.createElement(HomeView, { model })),
      COLS,
    )
    assertNoLineExceedsWidth(output, COLS)
    const stripped = stripAnsi(output)
    expect(stripped).toContain('检查')
    expect(stripped).toContain('テスト')
    expect(stripped).toContain('시스템')
  })
})

describe('CJK/emoji/ANSI coverage - DoctorView', () => {
  it('renders CJK labels and long URLs without exceeding column width', async () => {
    const model = createCjkDoctorViewModel()
    const output = await renderAt(
      React.createElement(DoctorView, { model }),
      COLS,
    )
    assertNoLineExceedsWidth(output, COLS)
    assertNoAnsiInOutput(output)
    expect(output).toContain('Doctor Report')
    expect(output).toContain('#42')
  })

  it('renders emoji in PR title and gate details', async () => {
    const model = createCjkDoctorViewModel()
    const output = await renderAt(
      React.createElement(DoctorView, { model }),
      COLS,
    )
    assertNoLineExceedsWidth(output, COLS)
    expect(stripAnsi(output)).toContain('🚀')
    expect(stripAnsi(output)).toContain('🎉')
  })

  it('strips ANSI from PR title, gates, and evidence', async () => {
    const model = createCjkDoctorViewModel()
    const output = await renderAt(
      React.createElement(DoctorView, { model }),
      COLS,
    )
    assertNoAnsiInOutput(output)
    expect(stripAnsi(output)).not.toContain('\x1b[31m')
    expect(stripAnsi(output)).not.toContain('\x1b[1m')
  })

  it('renders profile sync gate with CJK content', async () => {
    const model = createCjkDoctorViewModel()
    const output = await renderAt(
      React.createElement(DoctorView, { model }),
      COLS,
    )
    assertNoLineExceedsWidth(output, COLS)
    assertNoAnsiInOutput(output)
    expect(output).toContain('Profile Sync Gate')
  })
})

describe('CJK/emoji/ANSI coverage - PrQueueView', () => {
  it('renders PR titles with CJK, emoji, and long URLs within width', async () => {
    const model = createCjkPrQueueViewModel()
    const output = await renderAt(
      React.createElement(PrQueueView, { model }),
      COLS,
    )
    assertNoLineExceedsWidth(output, COLS)
    assertNoAnsiInOutput(output)
    expect(output).toContain('PR Queue')
    expect(output).toContain('#127')
    expect(output).toContain('#130')
  })

  it('strips ANSI from PR titles, actions, and commands', async () => {
    const model = createCjkPrQueueViewModel()
    const output = await renderAt(
      React.createElement(PrQueueView, { model }),
      COLS,
    )
    assertNoAnsiInOutput(output)
    expect(stripAnsi(output)).not.toContain('\x1b[31m')
    expect(stripAnsi(output)).not.toContain('\x1b[1m')
  })

  it('renders workflow gate criteria with CJK labels', async () => {
    const model = createCjkPrQueueViewModel()
    const output = await renderAt(
      React.createElement(PrQueueView, { model }),
      COLS,
    )
    assertNoLineExceedsWidth(output, COLS)
    const stripped = stripAnsi(output)
    expect(stripped).toContain('テスト')
  })
})

describe('CJK/emoji/ANSI coverage - ProfileView', () => {
  it('renders posts with CJK titles, emoji, and long URLs within width', async () => {
    const model = createCjkProfileViewModel()
    const output = await renderAt(
      React.createElement(ProfileView, { model }),
      COLS,
    )
    assertNoLineExceedsWidth(output, COLS)
    assertNoAnsiInOutput(output)
    expect(output).toContain('Organization Profile')
  })

  it('strips ANSI from sync details and post URLs', async () => {
    const model = createCjkProfileViewModel()
    const output = await renderAt(
      React.createElement(ProfileView, { model }),
      COLS,
    )
    assertNoAnsiInOutput(output)
    expect(stripAnsi(output)).not.toContain('\x1b[')
  })

  it('renders CJK action labels within width', async () => {
    const model = createCjkProfileViewModel()
    const output = await renderAt(
      React.createElement(ProfileView, { model }),
      COLS,
    )
    assertNoLineExceedsWidth(output, COLS)
    const stripped = stripAnsi(output)
    expect(stripped).toContain('检查')
    expect(stripped).toContain('プレビュー')
  })
})

describe('CJK/emoji/ANSI coverage - WorkflowLifecycleView', () => {
  it('renders stages with CJK labels and emoji within width', async () => {
    const model = createCjkWorkflowLifecycleViewModel()
    const output = await renderAt(
      withNav(React.createElement(WorkflowLifecycleView, { model })),
      COLS,
    )
    assertNoLineExceedsWidth(output, COLS)
    assertNoAnsiInOutput(output)
    expect(output).toContain('Lifecycle')
  })

  it('strips ANSI from workflow name, trust level, and stage details', async () => {
    const model = createCjkWorkflowLifecycleViewModel()
    const output = await renderAt(
      withNav(React.createElement(WorkflowLifecycleView, { model })),
      COLS,
    )
    assertNoAnsiInOutput(output)
    expect(stripAnsi(output)).not.toContain('\x1b[')
  })

  it('renders mixed content in stage details within width', async () => {
    const model = createCjkWorkflowLifecycleViewModel()
    const output = await renderAt(
      withNav(React.createElement(WorkflowLifecycleView, { model })),
      COLS,
    )
    assertNoLineExceedsWidth(output, COLS)
    const stripped = stripAnsi(output)
    expect(stripped).toContain('Proposal')
    expect(stripped).toContain('Review')
  })
})

describe('CJK/emoji/ANSI coverage - WorkflowWorkbenchView', () => {
  it('renders workflow names with CJK, emoji, and long URLs within width', async () => {
    const model = createCjkWorkflowWorkbenchViewModel()
    const output = await renderAt(
      withNav(React.createElement(WorkflowWorkbenchView, { galleryModel: model })),
      COLS,
    )
    assertNoLineExceedsWidth(output, COLS)
    assertNoAnsiInOutput(output)
    expect(output).toContain('Workflow Gallery')
    expect(output).toContain('2 workflows')
  })

  it('strips ANSI from descriptions and trust levels', async () => {
    const model = createCjkWorkflowWorkbenchViewModel()
    const output = await renderAt(
      withNav(React.createElement(WorkflowWorkbenchView, { galleryModel: model })),
      COLS,
    )
    assertNoAnsiInOutput(output)
    expect(stripAnsi(output)).not.toContain('\x1b[')
  })

  it('renders emoji in workflow names within width', async () => {
    const model = createCjkWorkflowWorkbenchViewModel()
    const output = await renderAt(
      withNav(React.createElement(WorkflowWorkbenchView, { galleryModel: model })),
      COLS,
    )
    assertNoLineExceedsWidth(output, COLS)
    expect(stripAnsi(output)).toContain('🔧')
  })
})

describe('CJK/emoji/ANSI coverage - DashboardView', () => {
  it('renders blockers with CJK, emoji, and long URLs within width', async () => {
    const model = createCjkDashboardViewModel()
    const output = await renderAt(
      React.createElement(DashboardView, { model }),
      COLS,
    )
    assertNoLineExceedsWidth(output, COLS)
    assertNoAnsiInOutput(output)
    expect(output).toContain('Team Dashboard')
    expect(output).toContain('Blockers: 1')
  })

  it('strips ANSI from activity summaries, handoffs, and decisions', async () => {
    const model = createCjkDashboardViewModel()
    const output = await renderAt(
      React.createElement(DashboardView, { model }),
      COLS,
    )
    assertNoAnsiInOutput(output)
    expect(stripAnsi(output)).not.toContain('\x1b[')
  })

  it('renders recent activity with mixed CJK + emoji + ANSI content', async () => {
    const model = createCjkDashboardViewModel()
    const output = await renderAt(
      React.createElement(DashboardView, { model }),
      COLS,
    )
    assertNoLineExceedsWidth(output, COLS)
    const stripped = stripAnsi(output)
    expect(stripped).toContain('检查')
    expect(stripped).toContain('テスト')
    expect(stripped).toContain('🚀')
  })

  it('renders handoff context with CJK content within width', async () => {
    const model = createCjkDashboardViewModel()
    const output = await renderAt(
      React.createElement(DashboardView, { model }),
      COLS,
    )
    assertNoLineExceedsWidth(output, COLS)
    expect(output).toContain('Handoffs: 1')
  })
})

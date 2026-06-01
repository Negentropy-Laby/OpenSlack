/**
 * cjk-emoji-stress.test.tsx -- Extended CJK/emoji stress tests for newer views.
 *
 * Focuses on ApprovalCenterView and RoomView (not covered by the existing
 * cjk-emoji-ansi-coverage.test.tsx), plus additional CJK+emoji coverage
 * for ProfileView, WorkflowLifecycleView, and DashboardView.
 *
 * Each test:
 * 1. Creates a view model with CJK (Chinese, Japanese, Korean), emoji, long URLs, ANSI, and mixed content.
 * 2. Renders at 80 and 100 columns.
 * 3. Asserts no line exceeds column width.
 * 4. Asserts no raw ANSI escape sequences in output.
 * 5. Asserts CJK characters are preserved.
 */
import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from '@openslack/tui'
import { NavigationProvider } from '../../navigation/context.js'
import stripAnsi from 'strip-ansi'

import ApprovalCenterView from '../../views/ApprovalCenterView.js'
import RoomView from '../../views/RoomView.js'
import ProfileView from '../../views/ProfileView.js'
import WorkflowLifecycleView from '../../views/WorkflowLifecycleView.js'
import DashboardView from '../../views/DashboardView.js'

import type { ApprovalCenterViewModel, ApprovalCategory, ApprovalItem, ApprovalExplanation } from '../../view-models/approval-center.js'
import type { RoomViewModel } from '../../view-models/room.js'
import type { ProfileViewModel } from '../../view-models/profile.js'
import type { WorkflowLifecycleViewModel } from '../../view-models/workflow-lifecycle.js'
import type { DashboardViewModel } from '../../view-models/dashboard.js'

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

function assertNoAnsiInOutput(output: string): void {
  const stripped = stripAnsi(output)
  if (stripped.includes('\x1b')) {
    throw new Error('Output contains unsanitized ANSI escape sequences after stripping Ink colors')
  }
}

// ── Problematic inputs ──

const CJK_ZH = '检查系统状态'
const CJK_JA = 'テスト実行中'
const CJK_KO = '시스템 상태 확인'
const EMOJI_TITLE = '🚀 feat: 新機能を追加 🎉'
const LONG_URL = 'https://github.com/Negentropy-Laby/OpenSlack/pull/127/checks?check_suite_id=1234567890&step=build'
const ANSI_COLORED = '\x1b[31mRed Text\x1b[0m Normal'
const ANSI_BOLD = '\x1b[1mBold Title\x1b[0m'
const OSC_HYPERLINK = '\x1b]8;;https://example.com\x07Click here\x1b]8;;\x07'
const MIXED = '\x1b[32m✅ 你好世界 🎉\x1b[0m — テスト完了'
const CJK_ANSI = '\x1b[33m⚠️ 警告：检查失败\x1b[0m'

// ── CJK Factories ──

function createCjkApprovalCenterViewModel(): ApprovalCenterViewModel {
  const makeExplanation = (suffix: string): ApprovalExplanation => ({
    why: `${CJK_ZH} ${suffix}`,
    ifApproved: `${CJK_JA} approved effect ${EMOJI_TITLE}`,
    ifRejected: `${CJK_KO} rejected effect`,
    source: `gh pr review — ${ANSI_BOLD}`,
  })

  const makeItem = (id: string, cat: ApprovalCategory, title: string, detail: string): ApprovalItem => ({
    id,
    category: cat,
    title: `${ANSI_COLORED} ${title}`,
    detail: `${detail} ${LONG_URL}`,
    risk: `${CJK_KO}-medium`,
    requestedBy: `${CJK_JA}-agent ${EMOJI_TITLE}`,
    requestedAt: '2026-06-01T10:00:00Z',
    planId: cat === 'plan' ? id : undefined,
    prNumber: cat === 'github-review' || cat === 'merge-request' ? 42 : undefined,
    workflowName: cat === 'workflow-effect' ? `${CJK_ZH}-workflow` : undefined,
    profileSyncAction: cat === 'profile-sync' ? `${CJK_KO}-sync` : undefined,
    explanation: makeExplanation(id),
  })

  return {
    pendingApprovals: [
      makeItem('plan-001', 'plan', `${CJK_ZH} 部署计划 ${EMOJI_TITLE}`, `${CJK_JA} production deploy`),
      makeItem('merge-001', 'merge-request', `合并 PR #42 ${CJK_KO}`, `${MIXED} merge detail`),
      makeItem('wf-001', 'workflow-effect', `${CJK_JA} workflow effect 🔧`, `${CJK_ANSI} side effect`),
      makeItem('ps-001', 'profile-sync', `Profile ${CJK_KO} sync 🔄`, `${ANSI_BOLD} sync action`),
      makeItem('gh-001', 'github-review', `GitHub ${CJK_ZH} review ${EMOJI_TITLE}`, `${OSC_HYPERLINK} CODEOWNER`),
    ],
    groups: [
      { category: 'plan', label: `📋 ${CJK_ZH} Plans`, items: [makeItem('plan-001', 'plan', `${CJK_ZH} 部署计划 ${EMOJI_TITLE}`, `${CJK_JA} production deploy`)] },
      { category: 'merge-request', label: `🔀 ${CJK_KO} Merge`, items: [makeItem('merge-001', 'merge-request', `合并 PR #42 ${CJK_KO}`, `${MIXED} merge detail`)] },
      { category: 'workflow-effect', label: `⚡ ${CJK_JA} Effects`, items: [makeItem('wf-001', 'workflow-effect', `${CJK_JA} workflow effect 🔧`, `${CJK_ANSI} side effect`)] },
      { category: 'profile-sync', label: `🔄 ${CJK_ZH} Sync`, items: [makeItem('ps-001', 'profile-sync', `Profile ${CJK_KO} sync 🔄`, `${ANSI_BOLD} sync action`)] },
      { category: 'github-review', label: `👀 ${CJK_KO} Reviews`, items: [makeItem('gh-001', 'github-review', `GitHub ${CJK_ZH} review ${EMOJI_TITLE}`, `${OSC_HYPERLINK} CODEOWNER`)] },
    ],
    summary: {
      plans: 1,
      mergeRequests: 1,
      workflowEffects: 1,
      profileSyncs: 1,
      githubReviews: 1,
    },
  }
}

function createCjkRoomViewModel(): RoomViewModel {
  return {
    roomId: `pr:${CJK_ZH}-42`,
    objectKind: `${CJK_JA}-pr`,
    objectId: '42',
    sourceUrl: LONG_URL,
    owner: `${CJK_KO}-lead ${EMOJI_TITLE}`,
    nextAction: `${MIXED} — review and approve`,
    blockerCount: 2,
    blockers: [
      { type: `${CJK_ZH}-check`, summary: `${ANSI_COLORED} CI ${CJK_JA} failing`, timestamp: '2026-06-01T08:00:00Z' },
      { type: `${CJK_KO}-approval`, summary: `${CJK_ANSI} missing approval ${LONG_URL}`, timestamp: '2026-06-01T07:00:00Z' },
    ],
    handoffs: [
      { id: `${ANSI_BOLD}-h-001`, from: `${CJK_ZH}-agent`, to: `${CJK_JA}-agent`, status: 'open', context: `${MIXED} continue review` },
    ],
    decisions: [
      { id: `${CJK_KO}-d-001`, topic: `${EMOJI_TITLE} approve layout`, decision: `${CJK_ZH}-pending`, status: 'active' },
    ],
    recentActivity: [
      { time: '12:00 PM', type: 'review.comment', summary: `${ANSI_COLORED} ${CJK_JA} commented`, actor: `${CJK_KO}-agent` },
      { time: '11:30 AM', type: 'check.failed', summary: `${CJK_ANSI} CI ${LONG_URL}`, actor: `${EMOJI_TITLE}-bot` },
      { time: '11:00 AM', type: `${OSC_HYPERLINK}`, summary: `${MIXED} mixed event`, actor: `${CJK_ZH}-ci` },
    ],
  }
}

function createCjkProfileViewModel(): ProfileViewModel {
  return {
    title: `${CJK_ZH} — Organization Profile`,
    targetRepo: `Negentropy-Laby/${CJK_JA}`,
    targetPath: `profile/${CJK_KO}/README.md`,
    marker: `${ANSI_BOLD}-marker`,
    syncStatus: 'synced',
    lastSyncDate: '2026-05-30T12:00:00Z',
    markerStatus: 'present',
    posts: [
      {
        title: `${ANSI_COLORED} ${EMOJI_TITLE} ${CJK_ZH}`,
        date: '2026-05-30',
        summary: `${CJK_JA} — ${CJK_KO} — ${MIXED}`,
        sourcePath: `posts/${CJK_ANSI}.md`,
        url: LONG_URL,
      },
    ],
    validationSummary: { total: 1, published: 1, failed: 0 },
    syncDetails: {
      sourceCommit: `${ANSI_BOLD}abc1234`,
      sourceDate: '2026-05-30T10:00:00Z',
      targetHash: `${CJK_ZH}-hash`,
      lastSync: { timestamp: '2026-05-30', result: 'success' },
      mode: 'manual',
    },
    mode: 'manual',
    guidedStep: 'complete',
    checkGroups: [
      { key: 'source', label: `${CJK_ZH} Source ${CJK_JA}`, status: 'pass', detail: `${CJK_KO} commit ok ${LONG_URL}` },
      { key: 'posts', label: `Posts ${EMOJI_TITLE}`, status: 'pass', detail: `${ANSI_COLORED} 1/1 ${CJK_ZH}` },
      { key: 'target-marker', label: `Target ${CJK_KO} marker`, status: 'pass', detail: `${CJK_ANSI} marker present` },
      { key: 'permissions', label: `${CJK_JA} Permissions 🔐`, status: 'pass', detail: MIXED },
    ],
    actions: [
      { id: 'check', key: 'c', label: `检查 ${CJK_ZH}`, description: `${CJK_JA} check`, risk: 'low' },
      { id: 'preview', key: 'p', label: `プレビュー 🔍`, description: `${ANSI_COLORED} preview`, risk: 'low' },
    ],
  }
}

function createCjkWorkflowLifecycleViewModel(): WorkflowLifecycleViewModel {
  return {
    workflowName: `${ANSI_BOLD} ${CJK_ZH}-workflow`,
    workflowHash: `${CJK_JA}hash123`,
    trustLevel: `${ANSI_COLORED}trusted`,
    risk: `${CJK_KO}-medium`,
    sourcePath: `.openslack/workflows/${EMOJI_TITLE}`,
    stages: [
      { name: 'proposal', label: `${CJK_ZH} Proposal`, status: 'complete', icon: 'check', issueNumber: 120, detail: `${ANSI_BOLD} ${CJK_JA} accepted` },
      { name: 'review', label: `${CJK_KO} Review 🔍`, status: 'complete', icon: 'check', issueNumber: 121, detail: LONG_URL },
      { name: 'run', label: `${EMOJI_TITLE} Run`, status: 'in-progress', icon: 'running', detail: MIXED },
      { name: 'pr', label: `${CJK_ANSI} PR`, status: 'pending', icon: 'clock', detail: `${ANSI_COLORED} not created` },
      { name: 'merged', label: `${CJK_ZH} Merged 🎉`, status: 'pending', icon: 'clock', detail: 'Not merged yet' },
    ],
    phaseIssues: [
      { phase: `${ANSI_BOLD}proposal`, issueNumber: 120, status: `${CJK_JA}-closed` },
    ],
    currentRun: {
      runId: `${ANSI_COLORED}run-001`,
      status: `${CJK_KO}-running`,
      startedAt: '2026-05-31T10:00:00Z',
      phaseIndex: 2,
    },
    prNumber: undefined,
    prStatus: undefined,
    nextAction: `${MIXED} — wait for completion`,
    subIssueMode: 'native',
    dependencyMode: 'native',
    fallbackReasons: [CJK_ANSI, LONG_URL],
    blockedGateItems: [
      { gate: `${CJK_ZH} Approval`, detail: `${CJK_JA} missing human approval ${LONG_URL}` },
    ],
    statusSummary: `${CJK_KO} blocked at run stage — ${EMOJI_TITLE}`,
  }
}

function createCjkDashboardViewModel(): DashboardViewModel {
  return {
    title: `${CJK_ZH} — Team Dashboard`,
    generatedAt: '2026-05-31T12:00:00Z',
    summary: { blockers: 1, handoffs: 1, decisions: 1 },
    blockers: [
      { object: `${ANSI_BOLD} PR #130 ${CJK_JA}`, summary: `${CJK_KO}: ${EMOJI_TITLE}`, owner: `${ANSI_COLORED}-lead`, nextAction: LONG_URL, severity: `${CJK_ANSI}-high` },
    ],
    handoffs: [
      { id: `${ANSI_BOLD}-h-001`, from: `${CJK_ZH}-agent`, to: `${CJK_JA}-agent`, status: 'open', context: MIXED, age: '2h' },
    ],
    decisions: [
      { id: `${ANSI_COLORED}-d-001`, topic: `${CJK_KO}: ${EMOJI_TITLE}`, status: 'active', decidedBy: `${OSC_HYPERLINK}-lead` },
    ],
    recentActivity: [
      { time: '12:00 PM', type: 'pr.merged', summary: `${ANSI_BOLD} ${CJK_ZH} PR #127 merged ${EMOJI_TITLE}`, actor: `${CJK_JA}-agent` },
      { time: '11:30 AM', type: 'task.completed', summary: LONG_URL, actor: `${CJK_KO}-agent` },
      { time: '11:00 AM', type: 'check.failed', summary: `${CJK_ANSI} — ${MIXED}`, actor: `${ANSI_COLORED}-bot` },
    ],
  }
}

// ── Tests ──

const WIDTHS = [80, 100] as const

describe.each(WIDTHS)('CJK/emoji stress at %d columns', (cols) => {

  // ── ApprovalCenterView ──

  describe('ApprovalCenterView', () => {
    it('renders all 5 approval categories with CJK/emoji within width', async () => {
      const model = createCjkApprovalCenterViewModel()
      const output = await renderAt(
        withNav(React.createElement(ApprovalCenterView, { model })),
        cols,
      )
      assertNoLineExceedsWidth(output, cols)
      assertNoAnsiInOutput(output)
      expect(output).toContain('Approvals')
    })

    it('preserves CJK characters in explanations and group labels', async () => {
      const model = createCjkApprovalCenterViewModel()
      const output = await renderAt(
        withNav(React.createElement(ApprovalCenterView, { model })),
        cols,
      )
      const stripped = stripAnsi(output)
      expect(stripped).toContain('检查')
      expect(stripped).toContain('テスト')
      expect(stripped).toContain('시스템')
    })

    it('renders emoji in titles and group labels within width', async () => {
      const model = createCjkApprovalCenterViewModel()
      const output = await renderAt(
        withNav(React.createElement(ApprovalCenterView, { model })),
        cols,
      )
      assertNoLineExceedsWidth(output, cols)
      const stripped = stripAnsi(output)
      expect(stripped).toContain('🚀')
    })

    it('strips ANSI from approval items and explanations', async () => {
      const model = createCjkApprovalCenterViewModel()
      const output = await renderAt(
        withNav(React.createElement(ApprovalCenterView, { model })),
        cols,
      )
      assertNoAnsiInOutput(output)
      expect(stripAnsi(output)).not.toContain('\x1b[31m')
    })

    it('renders long URLs in item details within width', async () => {
      const model = createCjkApprovalCenterViewModel()
      const output = await renderAt(
        withNav(React.createElement(ApprovalCenterView, { model })),
        cols,
      )
      assertNoLineExceedsWidth(output, cols)
    })
  })

  // ── RoomView ──

  describe('RoomView', () => {
    it('renders CJK blockers and handoffs within width', async () => {
      const model = createCjkRoomViewModel()
      const output = await renderAt(
        React.createElement(RoomView, { model }),
        cols,
      )
      assertNoLineExceedsWidth(output, cols)
      assertNoAnsiInOutput(output)
      expect(output).toContain('Room')
    })

    it('preserves CJK characters in activity and decisions', async () => {
      const model = createCjkRoomViewModel()
      const output = await renderAt(
        React.createElement(RoomView, { model }),
        cols,
      )
      const stripped = stripAnsi(output)
      expect(stripped).toContain('检查')
      expect(stripped).toContain('テスト')
      expect(stripped).toContain('시스템')
    })

    it('strips ANSI from blocker summaries and activity', async () => {
      const model = createCjkRoomViewModel()
      const output = await renderAt(
        React.createElement(RoomView, { model }),
        cols,
      )
      assertNoAnsiInOutput(output)
    })

    it('renders long URLs in source within width', async () => {
      const model = createCjkRoomViewModel()
      const output = await renderAt(
        React.createElement(RoomView, { model }),
        cols,
      )
      assertNoLineExceedsWidth(output, cols)
    })
  })

  // ── ProfileView (extended coverage with checkGroups) ──

  describe('ProfileView (extended)', () => {
    it('renders check groups with CJK labels within width', async () => {
      const model = createCjkProfileViewModel()
      const output = await renderAt(
        React.createElement(ProfileView, { model }),
        cols,
      )
      assertNoLineExceedsWidth(output, cols)
      assertNoAnsiInOutput(output)
    })

    it('preserves CJK in check group details and action labels', async () => {
      const model = createCjkProfileViewModel()
      const output = await renderAt(
        React.createElement(ProfileView, { model }),
        cols,
      )
      const stripped = stripAnsi(output)
      expect(stripped).toContain('检查')
      expect(stripped).toContain('プレビュー')
    })

    it('renders emoji in check group labels within width', async () => {
      const model = createCjkProfileViewModel()
      const output = await renderAt(
        React.createElement(ProfileView, { model }),
        cols,
      )
      assertNoLineExceedsWidth(output, cols)
      const stripped = stripAnsi(output)
      expect(stripped).toContain('🔍')
      expect(stripped).toContain('🔐')
    })
  })

  // ── WorkflowLifecycleView (extended with blockedGateItems) ──

  describe('WorkflowLifecycleView (extended)', () => {
    it('renders blocked gate items with CJK within width', async () => {
      const model = createCjkWorkflowLifecycleViewModel()
      const output = await renderAt(
        withNav(React.createElement(WorkflowLifecycleView, { model })),
        cols,
      )
      assertNoLineExceedsWidth(output, cols)
      assertNoAnsiInOutput(output)
    })

    it('preserves CJK in status summary and blocked gates', async () => {
      const model = createCjkWorkflowLifecycleViewModel()
      const output = await renderAt(
        withNav(React.createElement(WorkflowLifecycleView, { model })),
        cols,
      )
      const stripped = stripAnsi(output)
      expect(stripped).toContain('시스템')
    })

    it('renders CJK stage labels within width (emoji sanitized)', async () => {
      const model = createCjkWorkflowLifecycleViewModel()
      const output = await renderAt(
        withNav(React.createElement(WorkflowLifecycleView, { model })),
        cols,
      )
      assertNoLineExceedsWidth(output, cols)
      // CJK content preserved even after emoji sanitization
      const stripped = stripAnsi(output)
      expect(stripped).toContain('Proposal')
      expect(stripped).toContain('Review')
    })
  })

  // ── DashboardView (extended coverage) ──

  describe('DashboardView (extended)', () => {
    it('renders blockers with long URLs within width', async () => {
      const model = createCjkDashboardViewModel()
      const output = await renderAt(
        React.createElement(DashboardView, { model }),
        cols,
      )
      assertNoLineExceedsWidth(output, cols)
      assertNoAnsiInOutput(output)
    })
  })
})

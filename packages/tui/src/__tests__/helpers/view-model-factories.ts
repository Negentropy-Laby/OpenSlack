/**
 * view-model-factories.ts -- Minimal valid view model factories for column snapshot tests.
 *
 * Each factory returns a fully populated, valid view model for its corresponding view.
 * These are intentionally minimal -- they contain enough data to render meaningful output
 * without relying on real production data.
 */
import type { HomeViewModel } from '../../view-models/home.js'
import type { DoctorViewModel } from '../../view-models/doctor.js'
import type { PrQueueViewModel } from '../../view-models/pr-queue.js'
import type { ProfileViewModel } from '../../view-models/profile.js'
import type { WorkflowLifecycleViewModel } from '../../view-models/workflow-lifecycle.js'
import type { WorkflowGalleryViewModel } from '../../view-models/workflow-gallery.js'
import type { DashboardViewModel } from '../../view-models/dashboard.js'

export function createHomeViewModel(): HomeViewModel {
  return {
    attentionItems: [],
    allClear: true,
    navItems: [
      { label: 'Dashboard', key: 'dashboard', shortcut: '7' },
      { label: 'Status', key: 'status', shortcut: '8' },
      { label: 'Activity', key: 'activity', shortcut: '9' },
      { label: 'Digest', key: 'digest', shortcut: '0' },
      { label: 'Workflows', key: 'workflows', shortcut: 'p' },
      { label: 'Profile', key: 'profile', shortcut: 'r' },
    ],
    tasks: [
      { key: 'see-attention', label: 'See what needs attention', route: 'dashboard', description: 'View items needing immediate action', shortcut: '1' },
      { key: 'start-work', label: 'Start or continue work', route: 'workflows', description: 'Create tasks, claim issues, and work in isolated branches', shortcut: '2' },
      { key: 'run-workflow', label: 'Run or check a workflow', route: 'workflows', description: 'Browse, execute, and inspect workflow runs', shortcut: '3' },
      { key: 'review-prs', label: 'Review and merge PRs', route: 'pr-queue', description: 'Check open PRs, run doctor, and merge when ready', shortcut: '4' },
      { key: 'approve-pending', label: 'Approve pending items', route: 'approvals', description: 'Approve plans, merge requests, and workflow effects', shortcut: '5' },
      { key: 'maintain-profile', label: 'Maintain organization profile', route: 'profile', description: 'Check, preview, and sync your organization profile', shortcut: '6' },
    ],
    systemStatus: 'ready',
    nextRecommendedAction: undefined,
  }
}

export function createHomeViewModelWithAction(): HomeViewModel {
  return {
    ...createHomeViewModel(),
    nextRecommendedAction: {
      label: 'Approve pending plan: deploy to production',
      reason: '1 plan awaiting approval, risk: medium',
      route: 'approvals',
      urgency: 'governance' as const,
      priority: 1,
    },
  }
}

export function createDoctorViewModel(): DoctorViewModel {
  return {
    prNumber: 42,
    title: 'Test PR for column snapshot',
    author: 'test-bot',
    state: 'open',
    draft: false,
    riskZone: 'green',
    mergeable: true,
    decision: 'READY_TO_MERGE',
    reason: 'All gates passed',
    recommendation: 'Safe to merge',
    gates: [
      { name: 'Draft', status: 'PASS', detail: 'Ready for review' },
      { name: 'State', status: 'PASS', detail: 'Open' },
      { name: 'Merge', status: 'PASS', detail: 'No merge conflicts' },
      { name: 'Checks', status: 'PASS', detail: 'All 3 passed' },
      { name: 'Approvals', status: 'PASS', detail: '1 valid approval(s)' },
      { name: 'Risk', status: 'PASS', detail: 'Zone: GREEN' },
    ],
    checks: [
      { name: 'ci/lint', status: 'PASS', conclusion: 'success' },
      { name: 'ci/test', status: 'PASS', conclusion: 'success' },
      { name: 'ci/build', status: 'PASS', conclusion: 'success' },
    ],
    reviews: [
      { user: 'human-reviewer', state: 'APPROVED', valid: true },
    ],
    evidence: ['PR authored by bot identity', 'CODEOWNER approval verified'],
    compressed: false,
  }
}

export function createPrQueueViewModel(): PrQueueViewModel {
  return {
    title: 'PR Queue',
    totalPRs: 2,
    readyCount: 1,
    blockedCount: 1,
    pendingCount: 0,
    items: [
      {
        prNumber: 127,
        title: 'Fix auth flow edge case',
        author: 'test-bot',
        decision: 'READY_TO_MERGE',
        blockerCategory: 'none',
        owner: 'team-lead',
        canMerge: true,
        riskZone: 'green',
        nextAction: 'Merge when approved',
        rerunCommand: 'openslack pr doctor 127',
        workflowGate: { touched: false, criteria: [], overall: 'N/A' },
      },
      {
        prNumber: 130,
        title: 'Add new dashboard metrics',
        author: 'test-bot',
        decision: 'BLOCKED',
        blockerCategory: 'checks',
        owner: 'team-lead',
        canMerge: false,
        riskZone: 'yellow',
        nextAction: 'Wait for CI to pass',
        rerunCommand: 'openslack pr doctor 130',
        workflowGate: { touched: true, criteria: [{ name: 'Coverage', passed: false }], overall: 'FAIL' },
      },
    ],
  }
}

export function createProfileViewModel(): ProfileViewModel {
  return {
    title: 'Organization Profile',
    targetRepo: 'Negentropy-Laby/.github',
    targetPath: 'profile/README.md',
    marker: 'latest-insights',
    syncStatus: 'synced',
    lastSyncDate: '2026-05-30T12:00:00Z',
    markerStatus: 'present',
    posts: [
      {
        title: 'May 2026 Status Update',
        date: '2026-05-30',
        summary: 'System stable, 526 tests passing across 5 modules.',
        sourcePath: 'posts/2026-05-30-status.md',
        url: 'https://github.com/example/post',
      },
    ],
    validationSummary: {
      total: 1,
      published: 1,
      failed: 0,
    },
    syncDetails: {
      sourceCommit: 'abc1234',
      sourceDate: '2026-05-30T10:00:00Z',
      targetHash: 'present',
      lastSync: {
        timestamp: '2026-05-30',
        result: 'success',
      },
      mode: 'manual',
    },
    mode: 'manual',
    actions: [
      { id: 'check', key: 'c', label: 'Check', description: 'Check sync readiness', risk: 'low' },
      { id: 'preview', key: 'p', label: 'Preview', description: 'Preview diff patch', risk: 'low' },
      { id: 'dryrun', key: 'd', label: 'Dry-run', description: 'Simulate sync run', risk: 'low' },
      { id: 'create-pr', key: 'r', label: 'Create PR', description: 'Run profile sync and create PR', risk: 'medium' },
      { id: 'open-pr', key: 'o', label: 'Open PR', description: 'Open pending PR in browser', risk: 'low' },
      { id: 'failure-issue', key: 'i', label: 'Failure Issue', description: 'Create failure issue', risk: 'low' },
    ],
  }
}

export function createWorkflowLifecycleViewModel(): WorkflowLifecycleViewModel {
  return {
    workflowName: 'test-workflow',
    workflowHash: 'abc123def456',
    trustLevel: 'trusted',
    risk: 'medium',
    sourcePath: '.openslack/workflows/test-workflow',
    stages: [
      { name: 'proposal', label: 'Proposal', status: 'complete', icon: 'check', issueNumber: 120, detail: 'Proposal accepted' },
      { name: 'review', label: 'Review', status: 'complete', icon: 'check', issueNumber: 121, detail: 'Review passed' },
      { name: 'run', label: 'Run', status: 'in-progress', icon: 'running', detail: 'Currently executing' },
      { name: 'pr', label: 'PR', status: 'pending', icon: 'clock', detail: 'PR not created yet' },
      { name: 'merged', label: 'Merged', status: 'pending', icon: 'clock', detail: 'Not merged yet' },
    ],
    phaseIssues: [
      { phase: 'proposal', issueNumber: 120, status: 'closed' },
      { phase: 'review', issueNumber: 121, status: 'closed' },
    ],
    currentRun: {
      runId: 'run-001',
      status: 'running',
      startedAt: '2026-05-31T10:00:00Z',
      phaseIndex: 2,
    },
    prNumber: undefined,
    prStatus: undefined,
    nextAction: 'Wait for run to complete',
    subIssueMode: 'native',
    dependencyMode: 'native',
    fallbackReasons: [],
  }
}

export function createWorkflowWorkbenchViewModel(): WorkflowGalleryViewModel {
  return {
    workflows: [
      {
        name: 'test-workflow',
        description: 'A test workflow for column snapshots',
        format: 'yaml',
        trustLevel: 'trusted',
        risk: 'low',
        phases: 3,
        lastRunStatus: 'success',
      },
      {
        name: 'deploy-workflow',
        description: 'Deployment workflow with review gates',
        format: 'openslack-native',
        trustLevel: 'untrusted',
        risk: 'medium',
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

export function createDashboardViewModel(): DashboardViewModel {
  return {
    title: 'OpenSlack Team Dashboard',
    generatedAt: '2026-05-31T12:00:00Z',
    summary: {
      blockers: 1,
      handoffs: 1,
      decisions: 1,
    },
    blockers: [
      { object: 'PR #130', summary: 'CI checks failing', owner: 'team-lead', nextAction: 'Fix test failures', severity: 'high' },
    ],
    handoffs: [
      { id: 'h-001', from: 'agent-a', to: 'agent-b', status: 'open', context: 'Continue PR review', age: '2h' },
    ],
    decisions: [
      { id: 'd-001', topic: 'Adopt new branching strategy', status: 'active', decidedBy: 'team-lead' },
    ],
    recentActivity: [
      { time: '12:00 PM', type: 'pr.merged', summary: 'PR #127 merged', actor: 'agent-a' },
      { time: '11:30 AM', type: 'task.completed', summary: 'Issue #119 closed', actor: 'agent-b' },
    ],
  }
}

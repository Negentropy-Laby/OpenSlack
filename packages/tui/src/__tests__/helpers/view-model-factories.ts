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
import type { ApprovalCenterViewModel, ApprovalCategory } from '../../view-models/approval-center.js'
import type { RoomViewModel } from '../../view-models/room.js'
import type { ActivityViewModel } from '../../view-models/activity.js'
import type { DecisionListViewModel, DecisionDetailViewModel } from '../../view-models/decision.js'
import type { DigestViewModel } from '../../view-models/digest.js'
import type { HandoffListViewModel, HandoffDetailViewModel } from '../../view-models/handoff.js'
import type { IssuesPrViewModel } from '../../view-models/issues-pr.js'
import type { SetupViewModel } from '../../view-models/setup.js'
import type { StatusViewModel } from '../../view-models/status.js'
import type { WorkflowPreviewViewModel } from '../../view-models/workflow-preview.js'
import type { ShellViewData } from '../../views/render-shell.js'

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
      { key: 'run-workflow', label: 'Start a workflow', route: 'workflows', description: 'Generate from prompt, choose a pattern, or run a saved workflow', shortcut: '3' },
      { key: 'watch-workflows', label: 'Watch running workflows', route: 'workflow-runs', description: 'Inspect run, phase, agent, transcript, controls, and budget evidence', shortcut: 'w' },
      { key: 'approve-workflows', label: 'Handle paused workflow approvals', route: 'approvals', description: 'Approve or reject workflow effects and budget pauses', shortcut: 'a' },
      { key: 'save-share-workflow', label: 'Save/share workflow', route: 'workflows', description: 'Save runs to project, user, or Claude project targets', shortcut: 's' },
      { key: 'publish-workflow', label: 'Publish workflow to GitHub Issues', route: 'workflows', description: 'Create proposal, review, or phase tracking issues', shortcut: 'g' },
      { key: 'review-prs', label: 'Review and merge PRs', route: 'pr-queue', description: 'Check open PRs, run doctor, and merge when ready', shortcut: '4' },
      { key: 'approve-pending', label: 'Approve pending items', route: 'approvals', description: 'Approve plans, merge requests, and workflow effects', shortcut: '5' },
      { key: 'maintain-profile', label: 'Maintain organization profile', route: 'profile', description: 'Check, preview, and sync your organization profile', shortcut: '6' },
      { key: 'view-conversations', label: 'View active conversations', route: 'conversations', description: 'Browse agent conversation threads and messages', shortcut: 'c' },
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
    guidedStep: 'complete',
    checkGroups: [
      { key: 'source', label: 'Source repository', status: 'pass', detail: 'Commit abc1234 (2026-05-30)' },
      { key: 'posts', label: 'Posts', status: 'pass', detail: '1/1 published, 0 failed' },
      { key: 'target-marker', label: 'Target marker', status: 'pass', detail: 'Marker present in target' },
      { key: 'permissions', label: 'Permissions', status: 'pass', detail: 'All checks passed' },
    ],
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
      { phase: 'proposal', issueNumber: 120, status: 'closed', trackingMode: 'native' },
      { phase: 'review', issueNumber: 121, status: 'closed', trackingMode: 'native' },
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
    blockedGateItems: [],
    statusSummary: 'At run stage, waiting for execution to complete',
    parentIssueNumber: 42,
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
    patterns: [
      {
        id: 'fanout-synthesize',
        name: 'Fanout synthesize',
        description: 'Split broad research across agents and synthesize results',
      },
      {
        id: 'tournament',
        name: 'Tournament',
        description: 'Compare alternatives and choose a winner',
      },
    ],
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

export function createApprovalCenterViewModel(): ApprovalCenterViewModel {
  const groups: ApprovalCenterViewModel['groups'] = [
    {
      category: 'plan' as ApprovalCategory,
      label: 'Operator Plans',
      items: [
        {
          id: 'plan-001',
          category: 'plan' as ApprovalCategory,
          title: 'Deploy to production',
          detail: 'Plan to deploy v0.1-rc to production cluster',
          risk: 'medium',
          requestedBy: 'agent-ops',
          requestedAt: '2026-06-01T10:00:00Z',
          planId: 'plan-001',
          explanation: {
            why: 'Production deployment requires human confirmation',
            ifApproved: 'Agent will execute deployment steps',
            ifRejected: 'Deployment halted, agent notified',
            source: 'openslack plan confirm plan-001',
          },
        },
      ],
    },
    {
      category: 'merge-request' as ApprovalCategory,
      label: 'Merge Requests',
      items: [
        {
          id: 'merge-001',
          category: 'merge-request' as ApprovalCategory,
          title: 'Merge PR #42: Fix auth flow',
          detail: 'PRMS doctor: READY_TO_MERGE. All gates passed.',
          risk: 'green',
          requestedBy: 'agent-merge',
          requestedAt: '2026-06-01T09:00:00Z',
          prNumber: 42,
          explanation: {
            why: 'Merge after human approval per constitutional constraint #4',
            ifApproved: 'Merge Steward will merge after re-running PRMS doctor',
            ifRejected: 'PR remains open, no merge performed',
            source: 'gh pr review 42 --approve',
          },
        },
      ],
    },
    {
      category: 'github-review' as ApprovalCategory,
      label: 'GitHub Reviews Required',
      items: [
        {
          id: 'gh-review-001',
          category: 'github-review' as ApprovalCategory,
          title: 'PR #55: Layout Primitives migration',
          detail: 'CODEOWNER review required for packages/tui/src/layout/',
          risk: 'red',
          requestedBy: 'agent-operator',
          requestedAt: '2026-06-01T08:00:00Z',
          prNumber: 55,
          explanation: {
            why: 'Red Zone path requires human CODEOWNER approval',
            ifApproved: 'PR can proceed to merge after other gates pass',
            ifRejected: 'PR blocked until approval from valid CODEOWNER',
            source: 'gh pr review 55 --approve',
          },
        },
      ],
    },
  ]

  return {
    pendingApprovals: groups.flatMap((g) => g.items),
    groups,
    summary: {
      plans: 1,
      mergeRequests: 1,
      workflowEffects: 0,
      profileSyncs: 0,
      githubReviews: 1,
    },
  }
}

export function createRoomViewModel(): RoomViewModel {
  return {
    roomId: 'pr:42',
    objectKind: 'pr',
    objectId: '42',
    sourceUrl: 'https://github.com/Negentropy-Laby/OpenSlack/pull/42',
    owner: 'team-lead',
    nextAction: 'Review and approve',
    blockerCount: 1,
    blockers: [
      { type: 'check', summary: 'CI test suite failing on Node 18', timestamp: '2026-06-01T08:00:00Z' },
    ],
    handoffs: [
      { id: 'h-001', from: 'agent-a', to: 'agent-b', status: 'open', context: 'Continue review after CI fix' },
    ],
    decisions: [
      { id: 'd-001', topic: 'Approve layout changes', decision: 'pending', status: 'active' },
    ],
    recentActivity: [
      { time: '12:00 PM', type: 'review.comment', summary: 'Commented on layout width calculation', actor: 'agent-a' },
      { time: '11:30 AM', type: 'check.failed', summary: 'CI test failed: width exceeds 80 cols', actor: 'ci-bot' },
    ],
  }
}

export function createActivityViewModel(): ActivityViewModel {
  return {
    title: 'Activity Feed',
    periodHours: 24,
    totalEvents: 4,
    events: [
      { time: '12:00', type: 'pr.merged', summary: 'PR #127 merged', actor: 'agent-a', objectKind: 'pr', objectId: '127' },
      { time: '11:30', type: 'check.failed', summary: 'CI check failed on PR #130', actor: 'ci-bot', objectKind: 'pr', objectId: '130' },
      { time: '11:00', type: 'task.completed', summary: 'Issue #119 closed', actor: 'agent-b', objectKind: 'issue', objectId: '119' },
      { time: '10:00', type: 'handoff.created', summary: 'Handoff h-001 created', actor: 'agent-a', objectKind: 'handoff', objectId: 'h-001' },
    ],
    today: [
      { time: '12:00', type: 'pr.merged', summary: 'PR #127 merged', actor: 'agent-a', objectKind: 'pr', objectId: '127' },
      { time: '11:30', type: 'check.failed', summary: 'CI check failed on PR #130', actor: 'ci-bot', objectKind: 'pr', objectId: '130' },
      { time: '11:00', type: 'task.completed', summary: 'Issue #119 closed', actor: 'agent-b', objectKind: 'issue', objectId: '119' },
      { time: '10:00', type: 'handoff.created', summary: 'Handoff h-001 created', actor: 'agent-a', objectKind: 'handoff', objectId: 'h-001' },
    ],
    yesterday: [],
    older: [],
  }
}

export function createDecisionListViewModel(): DecisionListViewModel {
  return {
    title: 'Decisions',
    totalCount: 2,
    activeCount: 1,
    items: [
      { id: 'd-001', topic: 'Adopt new branching strategy', decision: 'Approved', status: 'active', decidedBy: 'team-lead', age: '2d' },
      { id: 'd-002', topic: 'Use YAML workflow format', decision: 'Approved', status: 'superseded', decidedBy: 'dev-lead', age: '7d' },
    ],
  }
}

export function createDecisionDetailViewModel(): DecisionDetailViewModel {
  return {
    id: 'd-001',
    topic: 'Adopt new branching strategy',
    decision: 'Approved',
    rationale: 'Current strategy causes frequent merge conflicts',
    alternatives: ['Keep current strategy', 'Use trunk-based development'],
    consequences: ['Requires team training', 'Simpler release process'],
    decidedBy: 'team-lead',
    createdAt: '2026-05-29T10:00:00Z',
    status: 'active',
    tags: ['branching', 'process'],
  }
}

export function createDigestViewModel(): DigestViewModel {
  return {
    title: 'OpenSlack Digest',
    periodHours: 24,
    totalEvents: 5,
    groups: [
      {
        label: 'Completed',
        count: 2,
        status: 'pass',
        events: [
          { time: '12:00', type: 'pr.merged', summary: 'PR #127 merged', objectKind: 'pr', objectId: '127' },
          { time: '11:30', type: 'task.completed', summary: 'Issue #119 closed', objectKind: 'issue', objectId: '119' },
        ],
      },
      {
        label: 'Blocked',
        count: 1,
        status: 'fail',
        events: [
          { time: '11:00', type: 'check.failed', summary: 'CI check failed on PR #130', objectKind: 'pr', objectId: '130' },
        ],
      },
      {
        label: 'Agent Activity',
        count: 2,
        status: 'info',
        events: [
          { time: '10:30', type: 'handoff.created', summary: 'Handoff h-001 created', objectKind: 'handoff', objectId: 'h-001' },
          { time: '10:00', type: 'approval.requested', summary: 'PR #130 needs review', objectKind: 'pr', objectId: '130' },
        ],
      },
    ],
    recommendedNext: [
      { objectKind: 'pr', objectId: '130', action: 'Review and approve PR #130' },
    ],
  }
}

export function createHandoffListViewModel(): HandoffListViewModel {
  return {
    title: 'Handoffs',
    totalCount: 2,
    openCount: 1,
    items: [
      { id: 'h-001', from: 'agent-a', to: 'agent-b', status: 'open', context: 'Continue PR review after CI fix', age: '2h', ref: 'pr:130' },
      { id: 'h-002', from: 'agent-b', to: 'agent-a', status: 'closed', context: 'Initial investigation done', age: '5d', ref: 'issue:119' },
    ],
  }
}

export function createHandoffDetailViewModel(): HandoffDetailViewModel {
  return {
    id: 'h-001',
    status: 'open',
    from: 'agent-a',
    to: 'agent-b',
    createdAt: '2026-05-31T10:00:00Z',
    context: 'Continue PR review after CI fix',
    nextSteps: ['Fix failing tests', 'Re-run CI', 'Submit for review'],
    notes: 'PR #130 has a flaky test in the auth module. Check the CI logs before re-running.',
    canAccept: true,
    canClose: true,
  }
}

export function createIssuesPrViewModel(): IssuesPrViewModel {
  return {
    tab: 'prs',
    issues: [
      { number: 119, title: 'Fix auth flow edge case', status: 'claimed', assignee: 'agent-a', labels: ['bug', 'priority:high'] },
      { number: 120, title: 'Add workflow validation', status: 'ready', labels: ['enhancement'] },
    ],
    prs: [
      { number: 127, title: 'Fix auth flow edge case', status: 'ready', author: 'test-bot', riskZone: 'green', nextAction: 'Merge when approved' },
      { number: 130, title: 'Add new dashboard metrics', status: 'blocked', author: 'test-bot', riskZone: 'yellow', blocker: 'CI checks failing', nextAction: 'Fix test failures' },
    ],
    summary: {
      issues: { total: 2, ready: 1, claimed: 1, blocked: 0 },
      prs: { total: 2, ready: 1, blocked: 1, pending: 0 },
    },
  }
}

export function createSetupViewModel(): SetupViewModel {
  return {
    readiness: 'almost ready',
    root: '/home/user/project',
    totalChecks: 4,
    passedChecks: 2,
    fixable: [
      { id: 'labels', title: 'Create required labels', status: 'WARN', detail: 'Labels task:ready, task:claimed missing', nextAction: 'Run label setup command', command: 'openslack setup labels' },
    ],
    needsAction: [
      { id: 'branch-protection', title: 'Enable branch protection', status: 'FAIL', detail: 'Main branch is not protected', nextAction: 'Enable in GitHub settings', command: '' },
    ],
    ok: [
      { id: 'repo', title: 'Repository accessible', status: 'PASS', detail: 'Connected to GitHub', nextAction: '', command: '' },
      { id: 'git', title: 'Git available', status: 'PASS', detail: 'Git 2.40+', nextAction: '', command: '' },
    ],
  }
}

export function createStatusViewModel(): StatusViewModel {
  return {
    title: 'OpenSlack Status',
    version: 'v0.1 Developer Preview',
    commit: 'abc1234',
    commitSubject: 'Merge PR #127: Fix auth flow',
    modules: [
      { name: 'Self-Evolution Kernel', status: 'ACTIVE', tests: 120 },
      { name: 'GitHub Issues Task Loop', status: 'ACTIVE', tests: 85 },
      { name: 'Operator Interface', status: 'EARLY', tests: 42 },
      { name: 'PR Review & Merge Steward', status: 'ACTIVE', tests: 156 },
      { name: 'Collaboration Layer', status: 'ACTIVE', tests: 123 },
    ],
    gitHub: {
      available: true,
      tasksReady: 3,
      tasksClaimed: 2,
      tasksBlocked: 1,
      prsOpen: 4,
      prsBlocked: 1,
      prsReady: 2,
    },
    testSuite: {
      totalTests: 526,
      totalFiles: 45,
    },
    recommendations: [
      { title: 'Review PR #130', action: 'CI failing, needs attention', command: 'openslack pr doctor 130' },
    ],
    attentionItems: [
      { type: 'PR', description: 'PR #130 has failing checks', action: 'Fix test failures', priority: 'high' },
    ],
    nextAction: 'Review PR #130 and fix failing checks',
  }
}

export function createWorkflowPreviewViewModel(): WorkflowPreviewViewModel {
  return {
    templateId: 'test-workflow',
    name: 'Test Workflow',
    correlationId: 'corr-001',
    steps: [
      { phase: 'Setup', type: 'action', title: 'Run setup', actionId: 'setup', sideEffects: false, requiresConfirmation: false, requiredRole: '' },
      { phase: 'Execute', type: 'action', title: 'Execute task', actionId: 'execute', sideEffects: true, requiresConfirmation: false, requiredRole: '' },
    ],
    phases: ['Setup', 'Execute'],
    phaseCount: 2,
    stepCount: 2,
    hasSideEffects: true,
    requiresConfirmation: false,
    errors: [],
    hasErrors: false,
  }
}

export function createShellViewData(): ShellViewData {
  return {
    dashboard: createDashboardViewModel(),
    status: createStatusViewModel(),
    prQueue: createPrQueueViewModel(),
    profile: createProfileViewModel(),
  }
}

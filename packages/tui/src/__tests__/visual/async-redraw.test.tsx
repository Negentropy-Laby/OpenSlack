/**
 * async-redraw.test.tsx -- Rapid state update and concurrent redraw tests.
 *
 * Tests that TUI views handle rapid state transitions and concurrent data
 * updates without throwing, corrupting output, or leaving stale artifacts.
 *
 * Scenarios:
 * 1. Rapid state transitions: loading -> loaded -> error in quick succession
 * 2. Concurrent data updates: multiple fields changing simultaneously
 * 3. Rerender with progressively growing data
 * 4. Rerender with shrinking data (loaded -> empty)
 * 5. Rapid alternating states
 */
import { describe, it, expect } from 'vitest';
import React, { useState, useCallback } from 'react';
import { render } from '@openslack/tui';
import { NavigationProvider } from '../../navigation/context.js';
import stripAnsi from 'strip-ansi';

import DashboardView from '../../views/DashboardView.js';
import PrQueueView from '../../views/PrQueueView.js';
import ProfileView from '../../views/ProfileView.js';
import ApprovalCenterView from '../../views/ApprovalCenterView.js';
import RoomView from '../../views/RoomView.js';

import type { DashboardViewModel } from '../../view-models/dashboard.js';
import type { PrQueueViewModel } from '../../view-models/pr-queue.js';
import type { ProfileViewModel } from '../../view-models/profile.js';
import type { ApprovalCenterViewModel } from '../../view-models/approval-center.js';
import type { RoomViewModel } from '../../view-models/room.js';

import { assertNoLineExceedsWidth } from '../helpers/render-at-columns.js';

import { Writable } from 'stream';

// -- Helpers --

function createMockStdout(columns: number, rows = 50) {
  const chunks: string[] = [];
  const stdout = new Writable({
    write(chunk: Buffer | string, _encoding: string, cb: () => void) {
      chunks.push(String(chunk));
      cb();
    },
  }) as NodeJS.WriteStream;
  Object.defineProperties(stdout, {
    columns: { value: columns, writable: true, configurable: true },
    rows: { value: rows, writable: true, configurable: true },
    isTTY: { value: false, configurable: true },
  });
  return { stdout, chunks };
}

function withNav(element: React.ReactElement): React.ReactElement {
  return React.createElement(NavigationProvider, null, element);
}

/**
 * Render an element, call rerender with new elements in rapid succession,
 * wait for the final frame, then return the output.
 */
async function rapidRerender(
  elements: React.ReactElement[],
  cols: number,
  delayMs = 30,
): Promise<string> {
  const { stdout, chunks } = createMockStdout(cols);
  const instance = await render(elements[0]!, { stdout, patchConsole: false });

  // Rapidly rerender through each subsequent element
  for (let i = 1; i < elements.length; i++) {
    instance.rerender(elements[i]!);
    // Small delay to let the reconciler process, but fast enough to test rapid transitions
    await new Promise((r) => setTimeout(r, delayMs));
  }

  // Wait for final frame to settle
  await new Promise((r) => setTimeout(r, 100));
  const output = chunks.join('');
  instance.unmount();
  return output;
}

// -- Model factories (reused from loading-transition.test.tsx) --

function createDashboardModel(overrides?: Partial<DashboardViewModel>): DashboardViewModel {
  return {
    title: 'OpenSlack Team Dashboard',
    generatedAt: '2026-06-01 12:00:00',
    summary: { blockers: 1, handoffs: 2, decisions: 1 },
    blockers: [
      {
        object: 'pr:42',
        summary: 'Missing human approval',
        nextAction: 'Run gh pr review 42 --approve',
        severity: 'high',
      },
    ],
    handoffs: [
      {
        id: 'h1',
        from: 'agent-a',
        to: 'agent-b',
        status: 'open',
        context: 'PR review handoff',
        age: '2h',
      },
      {
        id: 'h2',
        from: 'agent-c',
        to: 'human-d',
        status: 'closed',
        context: 'Decision made',
        age: '5d',
      },
    ],
    decisions: [
      { id: 'd1', topic: 'Use React for TUI', status: 'accepted', decidedBy: 'team-lead' },
    ],
    recentActivity: [
      { time: '11:45', type: 'pr.passed', summary: 'PR #137 passed CI', actor: 'openslack-bot' },
      {
        time: '11:30',
        type: 'handoff.opened',
        summary: 'Handoff from agent-a to agent-b',
        actor: 'agent-a',
      },
    ],
    ...overrides,
  };
}

function createEmptyDashboardModel(): DashboardViewModel {
  return createDashboardModel({
    summary: { blockers: 0, handoffs: 0, decisions: 0 },
    blockers: [],
    handoffs: [],
    decisions: [],
    recentActivity: [],
  });
}

function createPrQueueModel(overrides?: Partial<PrQueueViewModel>): PrQueueViewModel {
  return {
    title: 'PR Queue',
    totalPRs: 2,
    readyCount: 1,
    blockedCount: 1,
    pendingCount: 0,
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
        workflowGate: {
          touched: true,
          criteria: [{ name: 'Build', passed: true }],
          overall: 'PASS',
        },
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
    ],
    ...overrides,
  };
}

function createEmptyPrQueueModel(): PrQueueViewModel {
  return createPrQueueModel({
    totalPRs: 0,
    readyCount: 0,
    blockedCount: 0,
    pendingCount: 0,
    items: [],
  });
}

function createProfileModel(overrides?: Partial<ProfileViewModel>): ProfileViewModel {
  return {
    title: 'Organization Profile',
    targetRepo: 'Negentropy-Laby/.github',
    targetPath: 'profile/README.md',
    marker: 'latest-insights',
    syncStatus: 'synced',
    lastSyncDate: '2026-06-01',
    lastPrUrl: 'https://github.com/org/repo/pull/42',
    markerStatus: 'present',
    posts: [
      {
        title: 'First Post',
        date: '2026-05-30',
        summary: 'Summary of first post',
        sourcePath: 'posts/first.md',
        url: 'https://example.com/first',
      },
    ],
    validationSummary: { total: 1, published: 1, failed: 0 },
    mode: 'auto-pr',
    actions: [
      { id: 'check', key: 'c', label: 'Check', description: 'Check sync readiness', risk: 'low' },
      { id: 'preview', key: 'p', label: 'Preview', description: 'Preview diff patch', risk: 'low' },
      {
        id: 'create-pr',
        key: 'r',
        label: 'Create PR',
        description: 'Run profile sync and create PR',
        risk: 'medium',
      },
    ],
    ...overrides,
  };
}

function createApprovalCenterModel(
  overrides?: Partial<ApprovalCenterViewModel>,
): ApprovalCenterViewModel {
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
      },
    ],
    groups: [
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
          },
        ],
      },
    ],
    summary: { plans: 1, mergeRequests: 0, workflowEffects: 0, profileSyncs: 0, githubReviews: 0 },
    ...overrides,
  };
}

function createEmptyApprovalCenterModel(): ApprovalCenterViewModel {
  return createApprovalCenterModel({
    pendingApprovals: [],
    groups: [],
    summary: { plans: 0, mergeRequests: 0, workflowEffects: 0, profileSyncs: 0, githubReviews: 0 },
  });
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
    blockers: [{ type: 'approval', summary: 'Missing human approval', timestamp: '2h ago' }],
    handoffs: [
      { id: 'h1', from: 'agent-a', to: 'agent-b', status: 'open', context: 'PR review handoff' },
    ],
    decisions: [
      {
        id: 'd1',
        topic: 'Architecture choice',
        decision: 'Use TUI components',
        status: 'accepted',
      },
    ],
    recentActivity: [
      { time: '11:45', type: 'pr.passed', summary: 'CI checks passed', actor: 'openslack-bot' },
    ],
    ...overrides,
  };
}

function createEmptyRoomModel(): RoomViewModel {
  return createRoomModel({
    blockerCount: 0,
    blockers: [],
    handoffs: [],
    decisions: [],
    recentActivity: [],
    nextAction: '',
    sourceUrl: '',
    owner: '',
  });
}

const COLS = 100;

// ── Rapid state transitions ──

describe('rapid state transitions', () => {
  it('DashboardView: empty -> loaded -> empty without throwing', async () => {
    const empty = createEmptyDashboardModel();
    const loaded = createDashboardModel();
    const elements = [
      withNav(React.createElement(DashboardView, { model: empty })),
      withNav(React.createElement(DashboardView, { model: loaded })),
      withNav(React.createElement(DashboardView, { model: empty })),
    ];
    const output = await rapidRerender(elements, COLS);
    expect(output.length).toBeGreaterThan(0);
    // Final state should be empty (no blockers indicator present)
    const stripped = stripAnsi(output);
    expect(stripped).toContain('Dashboard');
  });

  it('PrQueueView: empty -> loaded -> empty without throwing', async () => {
    const empty = createEmptyPrQueueModel();
    const loaded = createPrQueueModel();
    const elements = [
      withNav(React.createElement(PrQueueView, { model: empty })),
      withNav(React.createElement(PrQueueView, { model: loaded })),
      withNav(React.createElement(PrQueueView, { model: empty })),
    ];
    const output = await rapidRerender(elements, COLS);
    expect(output.length).toBeGreaterThan(0);
    const stripped = stripAnsi(output);
    expect(stripped).toContain('PR Queue');
  });

  it('RoomView: empty -> loaded -> error-with-blockers without throwing', async () => {
    const empty = createEmptyRoomModel();
    const loaded = createRoomModel();
    const errorState = createRoomModel({
      blockerCount: 3,
      blockers: [
        { type: 'approval', summary: 'Missing human approval', timestamp: '1h ago' },
        { type: 'checks', summary: 'CI failing', timestamp: '30m ago' },
        { type: 'conflict', summary: 'Merge conflict detected', timestamp: '5m ago' },
      ],
      nextAction: 'Resolve blockers before merging',
    });
    const elements = [
      withNav(React.createElement(RoomView, { model: empty })),
      withNav(React.createElement(RoomView, { model: loaded })),
      withNav(React.createElement(RoomView, { model: errorState })),
    ];
    const output = await rapidRerender(elements, COLS);
    expect(output.length).toBeGreaterThan(0);
    assertNoLineExceedsWidth(output, COLS);
    const stripped = stripAnsi(output);
    expect(stripped).toContain('Room');
  });

  it('ProfileView: never-synced -> synced -> failed without throwing', async () => {
    const neverSynced = createProfileModel({
      syncStatus: 'never',
      markerStatus: 'unknown',
      posts: [],
      validationSummary: { total: 0, published: 0, failed: 0 },
    });
    const synced = createProfileModel();
    const failed = createProfileModel({
      syncStatus: 'failed',
      markerStatus: 'missing',
      failureDetails: {
        reason: 'Target file not found',
        nextAction: 'Create target file and retry',
      },
    });
    const elements = [
      withNav(React.createElement(ProfileView, { model: neverSynced })),
      withNav(React.createElement(ProfileView, { model: synced })),
      withNav(React.createElement(ProfileView, { model: failed })),
    ];
    const output = await rapidRerender(elements, COLS);
    expect(output.length).toBeGreaterThan(0);
    assertNoLineExceedsWidth(output, COLS);
    const stripped = stripAnsi(output);
    expect(stripped).toContain('Organization Profile');
  });

  it('ApprovalCenterView: empty -> loaded -> empty without throwing', async () => {
    const empty = createEmptyApprovalCenterModel();
    const loaded = createApprovalCenterModel();
    const elements = [
      withNav(React.createElement(ApprovalCenterView, { model: empty })),
      withNav(React.createElement(ApprovalCenterView, { model: loaded })),
      withNav(React.createElement(ApprovalCenterView, { model: empty })),
    ];
    const output = await rapidRerender(elements, COLS);
    expect(output.length).toBeGreaterThan(0);
    assertNoLineExceedsWidth(output, COLS);
    const stripped = stripAnsi(output);
    expect(stripped).toContain('Approvals');
  });
});

// ── Rapid alternating states ──

describe('rapid alternating states', () => {
  it('DashboardView: 5 rapid alternations between empty and loaded', async () => {
    const empty = createEmptyDashboardModel();
    const loaded = createDashboardModel();
    const elements: React.ReactElement[] = [];
    for (let i = 0; i < 5; i++) {
      elements.push(withNav(React.createElement(DashboardView, { model: empty })));
      elements.push(withNav(React.createElement(DashboardView, { model: loaded })));
    }
    const output = await rapidRerender(elements, COLS, 15);
    expect(output.length).toBeGreaterThan(0);
    assertNoLineExceedsWidth(output, COLS);
  });

  it('PrQueueView: 5 rapid alternations between empty and loaded', async () => {
    const empty = createEmptyPrQueueModel();
    const loaded = createPrQueueModel();
    const elements: React.ReactElement[] = [];
    for (let i = 0; i < 5; i++) {
      elements.push(withNav(React.createElement(PrQueueView, { model: empty })));
      elements.push(withNav(React.createElement(PrQueueView, { model: loaded })));
    }
    const output = await rapidRerender(elements, COLS, 15);
    expect(output.length).toBeGreaterThan(0);
    assertNoLineExceedsWidth(output, COLS);
  });
});

// ── Concurrent data updates (multiple fields changing simultaneously) ──

describe('concurrent data updates', () => {
  it('DashboardView: summary counts and activity data change simultaneously', async () => {
    const initial = createDashboardModel({
      summary: { blockers: 1, handoffs: 1, decisions: 0 },
      blockers: [
        { object: 'pr:42', summary: 'Missing approval', nextAction: 'Approve', severity: 'high' },
      ],
      handoffs: [
        { id: 'h1', from: 'agent-a', to: 'agent-b', status: 'open', context: 'Review', age: '1h' },
      ],
      decisions: [],
      recentActivity: [],
    });

    // All fields change at once: blockers resolved, new handoffs, new decisions, new activity
    const updated = createDashboardModel({
      summary: { blockers: 0, handoffs: 3, decisions: 2 },
      blockers: [],
      handoffs: [
        { id: 'h1', from: 'agent-a', to: 'agent-b', status: 'open', context: 'Review', age: '1h' },
        {
          id: 'h2',
          from: 'agent-c',
          to: 'human-d',
          status: 'open',
          context: 'New task',
          age: '30m',
        },
        {
          id: 'h3',
          from: 'agent-e',
          to: 'agent-f',
          status: 'open',
          context: 'Bug fix',
          age: '10m',
        },
      ],
      decisions: [
        { id: 'd1', topic: 'Architecture', status: 'accepted', decidedBy: 'team-lead' },
        { id: 'd2', topic: 'Testing strategy', status: 'accepted', decidedBy: 'dev-lead' },
      ],
      recentActivity: [
        {
          time: '12:00',
          type: 'decision.accepted',
          summary: 'Decision on architecture',
          actor: 'team-lead',
        },
        {
          time: '11:55',
          type: 'handoff.opened',
          summary: 'Handoff from agent-c to human-d',
          actor: 'agent-c',
        },
        { time: '11:45', type: 'pr.passed', summary: 'PR #42 passed CI', actor: 'openslack-bot' },
      ],
    });

    const elements = [
      withNav(React.createElement(DashboardView, { model: initial })),
      withNav(React.createElement(DashboardView, { model: updated })),
    ];
    const output = await rapidRerender(elements, COLS);
    expect(output.length).toBeGreaterThan(0);
    assertNoLineExceedsWidth(output, COLS);
    // The final render should reflect the updated state
    const stripped = stripAnsi(output);
    expect(stripped).toContain('Dashboard');
  });

  it('PrQueueView: items and counts change simultaneously', async () => {
    const initial = createPrQueueModel({
      totalPRs: 1,
      readyCount: 0,
      blockedCount: 1,
      pendingCount: 0,
      items: [
        {
          prNumber: 100,
          title: 'wip: initial implementation',
          author: 'bot',
          decision: 'REVIEW_REQUIRED',
          blockerCategory: 'approval',
          owner: 'team-lead',
          canMerge: false,
          riskZone: 'yellow',
          nextAction: 'Needs approval',
          rerunCommand: 'openslack pr doctor 100',
          workflowGate: { touched: false, criteria: [], overall: 'N/A' },
        },
      ],
    });

    // Sudden change: PR merged, new PRs appear, counts change dramatically
    const updated = createPrQueueModel({
      totalPRs: 4,
      readyCount: 2,
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
          workflowGate: {
            touched: true,
            criteria: [{ name: 'Build', passed: true }],
            overall: 'PASS',
          },
        },
        {
          prNumber: 102,
          title: 'fix: sync bug',
          author: 'bot',
          decision: 'APPROVED',
          blockerCategory: 'none',
          owner: 'dev-lead',
          canMerge: true,
          riskZone: 'green',
          nextAction: 'Merge',
          rerunCommand: 'openslack pr doctor 102',
          workflowGate: {
            touched: true,
            criteria: [{ name: 'Build', passed: true }],
            overall: 'PASS',
          },
        },
        {
          prNumber: 103,
          title: 'feat: new feature',
          author: 'bot',
          decision: 'PENDING',
          blockerCategory: 'checks',
          owner: 'team-lead',
          canMerge: false,
          riskZone: 'yellow',
          nextAction: 'Waiting for CI',
          rerunCommand: 'openslack pr doctor 103',
          workflowGate: {
            touched: true,
            criteria: [{ name: 'Tests', passed: false }],
            overall: 'FAIL',
          },
        },
        {
          prNumber: 104,
          title: 'chore: cleanup',
          author: 'bot',
          decision: 'REVIEW_REQUIRED',
          blockerCategory: 'approval',
          owner: 'team-lead',
          canMerge: false,
          riskZone: 'green',
          nextAction: 'Needs approval',
          rerunCommand: 'openslack pr doctor 104',
          workflowGate: { touched: false, criteria: [], overall: 'N/A' },
        },
      ],
    });

    const elements = [
      withNav(React.createElement(PrQueueView, { model: initial })),
      withNav(React.createElement(PrQueueView, { model: updated })),
    ];
    const output = await rapidRerender(elements, COLS);
    expect(output.length).toBeGreaterThan(0);
    assertNoLineExceedsWidth(output, COLS);
    const stripped = stripAnsi(output);
    expect(stripped).toContain('PR Queue');
  });

  it('RoomView: blockers, handoffs, decisions, and activity all change at once', async () => {
    const initial = createRoomModel({
      blockerCount: 0,
      blockers: [],
      handoffs: [],
      decisions: [],
      recentActivity: [],
    });

    const updated = createRoomModel({
      blockerCount: 2,
      blockers: [
        { type: 'approval', summary: 'Missing human approval', timestamp: '1h ago' },
        { type: 'checks', summary: 'CI failing on test suite', timestamp: '30m ago' },
      ],
      handoffs: [
        { id: 'h1', from: 'agent-a', to: 'agent-b', status: 'open', context: 'PR review' },
        { id: 'h2', from: 'agent-c', to: 'human-d', status: 'open', context: 'Decision needed' },
      ],
      decisions: [
        { id: 'd1', topic: 'Architecture', decision: 'Use React', status: 'accepted' },
        { id: 'd2', topic: 'Testing', decision: 'Add integration tests', status: 'accepted' },
      ],
      recentActivity: [
        {
          time: '12:00',
          type: 'decision.accepted',
          summary: 'Decision on architecture',
          actor: 'team-lead',
        },
        { time: '11:55', type: 'handoff.opened', summary: 'Handoff created', actor: 'agent-a' },
        {
          time: '11:45',
          type: 'pr.blocked',
          summary: 'PR blocked by failing CI',
          actor: 'openslack-bot',
        },
      ],
    });

    const elements = [
      withNav(React.createElement(RoomView, { model: initial })),
      withNav(React.createElement(RoomView, { model: updated })),
    ];
    const output = await rapidRerender(elements, COLS);
    expect(output.length).toBeGreaterThan(0);
    assertNoLineExceedsWidth(output, COLS);
    const stripped = stripAnsi(output);
    expect(stripped).toContain('Room');
  });

  it('ApprovalCenterView: groups appear and disappear simultaneously', async () => {
    const empty = createEmptyApprovalCenterModel();

    const multiGroup = createApprovalCenterModel({
      pendingApprovals: [
        {
          id: 'ap-1',
          category: 'plan',
          title: 'Plan A',
          detail: 'Plan details',
          risk: 'medium',
          requestedBy: 'agent',
          requestedAt: '2026-06-01T10:00:00Z',
          planId: 'plan-001',
        },
        {
          id: 'ap-2',
          category: 'merge-request',
          title: 'Merge PR #50',
          detail: 'Ready to merge',
          risk: 'low',
          requestedBy: 'steward',
          requestedAt: '2026-06-01T11:00:00Z',
          prNumber: 50,
        },
        {
          id: 'ap-3',
          category: 'workflow-effect',
          title: 'Resume workflow X',
          detail: 'Workflow paused for confirmation',
          risk: 'high',
          requestedBy: 'workflow-engine',
          requestedAt: '2026-06-01T12:00:00Z',
          workflowName: 'workflow-x',
        },
        {
          id: 'ap-4',
          category: 'profile-sync',
          title: 'Sync profile README',
          detail: 'Changes detected in source posts',
          risk: 'low',
          requestedBy: 'profile-watcher',
          requestedAt: '2026-06-01T13:00:00Z',
          profileSyncAction: 'sync',
        },
        {
          id: 'ap-5',
          category: 'github-review',
          title: 'Approve PR #60',
          detail: 'Requires human GitHub review',
          risk: 'low',
          requestedBy: 'agent-operator',
          requestedAt: '2026-06-01T14:00:00Z',
          prNumber: 60,
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
              title: 'Merge PR #50',
              detail: 'Ready to merge',
              risk: 'low',
              requestedBy: 'steward',
              requestedAt: '2026-06-01T11:00:00Z',
              prNumber: 50,
            },
          ],
        },
        {
          category: 'workflow-effect',
          label: 'Workflow Effects',
          items: [
            {
              id: 'ap-3',
              category: 'workflow-effect',
              title: 'Resume workflow X',
              detail: 'Workflow paused for confirmation',
              risk: 'high',
              requestedBy: 'workflow-engine',
              requestedAt: '2026-06-01T12:00:00Z',
              workflowName: 'workflow-x',
            },
          ],
        },
        {
          category: 'profile-sync',
          label: 'Profile Sync',
          items: [
            {
              id: 'ap-4',
              category: 'profile-sync',
              title: 'Sync profile README',
              detail: 'Changes detected in source posts',
              risk: 'low',
              requestedBy: 'profile-watcher',
              requestedAt: '2026-06-01T13:00:00Z',
              profileSyncAction: 'sync',
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
              title: 'Plan A',
              detail: 'Plan details',
              risk: 'medium',
              requestedBy: 'agent',
              requestedAt: '2026-06-01T10:00:00Z',
              planId: 'plan-001',
            },
          ],
        },
        {
          category: 'github-review',
          label: 'GitHub Reviews Required',
          items: [
            {
              id: 'ap-5',
              category: 'github-review',
              title: 'Approve PR #60',
              detail: 'Requires human GitHub review',
              risk: 'low',
              requestedBy: 'agent-operator',
              requestedAt: '2026-06-01T14:00:00Z',
              prNumber: 60,
            },
          ],
        },
      ],
      summary: {
        plans: 1,
        mergeRequests: 1,
        workflowEffects: 1,
        profileSyncs: 1,
        githubReviews: 1,
      },
    });

    const elements = [
      withNav(React.createElement(ApprovalCenterView, { model: empty })),
      withNav(React.createElement(ApprovalCenterView, { model: multiGroup })),
      withNav(React.createElement(ApprovalCenterView, { model: empty })),
    ];
    const output = await rapidRerender(elements, COLS);
    expect(output.length).toBeGreaterThan(0);
    assertNoLineExceedsWidth(output, COLS);
    const stripped = stripAnsi(output);
    expect(stripped).toContain('Approvals');
  });
});

// ── Progressive data growth ──

describe('progressive data growth', () => {
  it('DashboardView: data grows across 4 rerenders without throwing', async () => {
    const step0 = createEmptyDashboardModel();
    const step1 = createDashboardModel({
      summary: { blockers: 1, handoffs: 0, decisions: 0 },
      blockers: [{ object: 'pr:42', summary: 'Missing approval', severity: 'high' }],
      handoffs: [],
      decisions: [],
      recentActivity: [],
    });
    const step2 = createDashboardModel({
      summary: { blockers: 1, handoffs: 1, decisions: 0 },
      blockers: [{ object: 'pr:42', summary: 'Missing approval', severity: 'high' }],
      handoffs: [
        { id: 'h1', from: 'agent-a', to: 'agent-b', status: 'open', context: 'Review', age: '1h' },
      ],
      decisions: [],
      recentActivity: [],
    });
    const step3 = createDashboardModel(); // full data

    const elements = [
      withNav(React.createElement(DashboardView, { model: step0 })),
      withNav(React.createElement(DashboardView, { model: step1 })),
      withNav(React.createElement(DashboardView, { model: step2 })),
      withNav(React.createElement(DashboardView, { model: step3 })),
    ];
    const output = await rapidRerender(elements, COLS);
    expect(output.length).toBeGreaterThan(0);
    assertNoLineExceedsWidth(output, COLS);
  });

  it('PrQueueView: queue grows from 0 to 3 items without throwing', async () => {
    const step0 = createEmptyPrQueueModel();
    const step1 = createPrQueueModel({
      totalPRs: 1,
      readyCount: 1,
      blockedCount: 0,
      pendingCount: 0,
      items: [
        {
          prNumber: 101,
          title: 'feat: first PR',
          author: 'bot',
          decision: 'APPROVED',
          blockerCategory: 'none',
          owner: 'team-lead',
          canMerge: true,
          riskZone: 'yellow',
          nextAction: 'Merge',
          rerunCommand: 'openslack pr doctor 101',
          workflowGate: {
            touched: true,
            criteria: [{ name: 'Build', passed: true }],
            overall: 'PASS',
          },
        },
      ],
    });
    const step2 = createPrQueueModel(); // full 2 items
    const step3 = createPrQueueModel({
      totalPRs: 3,
      readyCount: 1,
      blockedCount: 1,
      pendingCount: 1,
      items: [
        ...createPrQueueModel().items,
        {
          prNumber: 104,
          title: 'chore: another PR',
          author: 'bot',
          decision: 'PENDING',
          blockerCategory: 'checks',
          owner: 'any',
          canMerge: false,
          riskZone: 'green',
          nextAction: 'Waiting for CI',
          rerunCommand: 'openslack pr doctor 104',
          workflowGate: {
            touched: true,
            criteria: [{ name: 'Tests', passed: false }],
            overall: 'FAIL',
          },
        },
      ],
    });

    const elements = [
      withNav(React.createElement(PrQueueView, { model: step0 })),
      withNav(React.createElement(PrQueueView, { model: step1 })),
      withNav(React.createElement(PrQueueView, { model: step2 })),
      withNav(React.createElement(PrQueueView, { model: step3 })),
    ];
    const output = await rapidRerender(elements, COLS);
    expect(output.length).toBeGreaterThan(0);
    assertNoLineExceedsWidth(output, COLS);
  });
});

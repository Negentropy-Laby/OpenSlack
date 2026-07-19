import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'stream';
import React from 'react';
import { render } from '@openslack/tui';
import stripAnsi from 'strip-ansi';
import HomeView, {
  executeConversationActionCard,
  resolveAskHistorySelection,
} from '../views/HomeView.js';
import { mapHomeToViewModel } from '../view-models/home.js';
import { NavigationProvider } from '../navigation/context.js';
import { TerminalSizeContext } from '../ink/components/TerminalSizeContext.js';

function createMockStdout(columns = 80, rows = 50) {
  const chunks: string[] = [];
  const stdout = new Writable({
    write(chunk, _, cb) {
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

describe('HomeView coordinate diagnostic', () => {
  it('keeps the default 80x24 home screen compact enough for stable terminal redraw', async () => {
    const rows = 24;
    const { stdout, chunks } = createMockStdout(80, rows);
    const model = mapHomeToViewModel({
      shellData: {
        approvals: {
          pendingApprovals: [
            {
              id: 'plan-1',
              category: 'plan',
              title: 'review all workflow approvals',
              risk: 'medium',
            },
          ],
          summary: { plans: 1, mergeRequests: 0, workflowEffects: 0, githubReviews: 0 },
        },
      },
    });
    const instance = await render(
      React.createElement(
        NavigationProvider,
        null,
        React.createElement(
          TerminalSizeContext.Provider,
          { value: { columns: 80, rows } },
          React.createElement(HomeView, { model }),
        ),
      ),
      { stdout, patchConsole: false },
    );
    await new Promise<void>((r) => setTimeout(r, 200));

    const output = stripAnsi(chunks.join(''));
    const visibleLines = output.split('\n').filter((line) => line.trim().length > 0);

    expect(output).toContain('Ask OpenSlack:');
    expect(output).toContain('Suggested shortcuts');
    expect(output).toContain('Maintain organization profile');
    expect(output).toContain('Next:');
    expect(output).not.toContain('Quick Navigation');
    expect(output).not.toContain('Create tasks, claim issues');
    expect(visibleLines.length).toBeLessThan(rows);

    instance.unmount();
  });

  it('resolves Ctrl+P as older history and Ctrl+N as newer history', () => {
    const history = ['second ask', 'first ask'];
    const newest = resolveAskHistorySelection(history, undefined, 'older');
    expect(newest).toEqual({ cursor: 0, value: 'second ask' });

    const older = resolveAskHistorySelection(history, newest?.cursor, 'older');
    expect(older).toEqual({ cursor: 1, value: 'first ask' });

    const newer = resolveAskHistorySelection(history, older?.cursor, 'newer');
    expect(newer).toEqual({ cursor: 0, value: 'second ask' });

    const currentInput = resolveAskHistorySelection(history, newer?.cursor, 'newer');
    expect(currentInput).toEqual({ cursor: undefined, value: '' });

    expect(resolveAskHistorySelection(history, undefined, 'newer')).toBeUndefined();
  });

  it('executes action cards safely and reports handler errors', async () => {
    const messages: string[] = [];
    const busyStates: boolean[] = [];
    const pushes: Array<{ view: string; params?: Record<string, unknown> }> = [];
    const recordWorkbenchAction = vi.fn(async () => ({ success: true, message: 'recorded' }));
    const startWorkflowFromPrompt = vi.fn(async () => ({ success: true, message: 'Draft ready.' }));
    const base = {
      threadId: 'CONV-test',
      actionHandlers: { recordWorkbenchAction, startWorkflowFromPrompt },
      push: (location: { view: string; params?: Record<string, unknown> }) => {
        pushes.push(location);
      },
      setAskMessage: (message: string) => {
        messages.push(message);
      },
      setAskBusy: (busy: boolean) => {
        busyStates.push(busy);
      },
    };

    await executeConversationActionCard({
      ...base,
      card: {
        id: 'status',
        label: 'Open Status',
        detail: 'Open status view.',
        kind: 'route',
        route: 'status',
        riskLevel: 'low',
        confirmationRequired: false,
      },
    });
    await executeConversationActionCard({
      ...base,
      card: {
        id: 'agent-run',
        label: 'Open Agent Run',
        detail: 'Inspect run.',
        kind: 'agent_run',
        route: 'agent-run-detail',
        routeParams: { runId: 'run-1' },
        riskLevel: 'low',
        confirmationRequired: false,
      },
    });
    await executeConversationActionCard({
      ...base,
      card: {
        id: 'workflow-draft',
        label: 'Generate Draft',
        detail: 'Generate a draft.',
        kind: 'workflow_draft',
        prompt: 'audit endpoints',
        riskLevel: 'low',
        confirmationRequired: false,
      },
    });
    await executeConversationActionCard({
      ...base,
      card: {
        id: 'command',
        label: 'Use CLI',
        detail: 'Fallback command.',
        kind: 'command',
        command: 'openslack status',
        riskLevel: 'none',
        confirmationRequired: false,
      },
    });

    expect(pushes).toEqual([
      { view: 'status', params: undefined },
      { view: 'agent-run-detail', params: { runId: 'run-1' } },
    ]);
    expect(startWorkflowFromPrompt).toHaveBeenCalledWith('audit endpoints');
    expect(messages).toEqual(
      expect.arrayContaining([
        'Opening Open Status.',
        'Opening Open Agent Run.',
        'Draft ready.',
        'Use: openslack status',
      ]),
    );
    expect(busyStates).toEqual([true, false]);

    const pushCountBeforeFailure = pushes.length;
    await executeConversationActionCard({
      ...base,
      actionHandlers: {
        recordWorkbenchAction: vi.fn(async () => {
          throw new Error('audit failed');
        }),
      },
      card: {
        id: 'bad-route',
        label: 'Bad Route',
        detail: 'Fails while recording.',
        kind: 'route',
        route: 'status',
        riskLevel: 'low',
        confirmationRequired: false,
      },
    });

    expect(messages.at(-1)).toBe('Action failed: audit failed');
    expect(pushes).toHaveLength(pushCountBeforeFailure);
  });

  it('renders with empty data and verifies grouped task layout', async () => {
    const { stdout, chunks } = createMockStdout(80, 50);
    const model = mapHomeToViewModel();
    const instance = await render(
      React.createElement(NavigationProvider, null, React.createElement(HomeView, { model })),
      { stdout, patchConsole: false },
    );
    await new Promise<void>((r) => setTimeout(r, 200));

    const output = chunks.join('');
    const lines = output.split('\n');
    const indexOfLine = (text: string) => lines.findIndex((line) => line.includes(text));

    // Header
    expect(lines[0]).toContain('OpenSlack');
    expect(lines[1]).toContain('─');

    // Section 1: Ask OpenSlack
    expect(lines[2]).toContain('Ask OpenSlack:');
    expect(output).toContain('What do you want OpenSlack to do?');

    const startHeader = indexOfLine('Start Work');
    expect(startHeader).toBeGreaterThan(indexOfLine('Suggested shortcuts'));
    expect(indexOfLine('Start or continue work')).toBeGreaterThan(startHeader);
    expect(indexOfLine('Start a workflow')).toBeGreaterThan(startHeader);
    expect(indexOfLine('Watch running workflows')).toBeGreaterThan(startHeader);
    expect(indexOfLine('Save/share run')).toBeGreaterThan(startHeader);
    expect(indexOfLine('Publish workflow to GitHub Issues')).toBeGreaterThan(startHeader);
    expect(output).toContain('Generate from prompt, choose a pattern, or run a saved workflow');
    expect(output).toContain('Inspect run, phase, agent, transcript');
    expect(output).toContain('Choose a workflow run, then save scripts');
    expect(output).toContain('Create proposal, review, or phase tracking issues');

    const reviewHeader = indexOfLine('Review Work');
    expect(reviewHeader).toBeGreaterThan(indexOfLine('Publish workflow to GitHub Issues'));
    expect(lines[reviewHeader + 1]).toContain('See what needs attention');
    expect(lines[reviewHeader + 2]).toContain('View items needing immediate action');
    expect(lines[reviewHeader + 3]).toContain('Review and merge PRs');
    expect(lines[reviewHeader + 4]).toContain('Check open PRs, run doctor, and merge when ready');
    expect(lines[reviewHeader + 5]).toContain('View active conversations');
    expect(lines[reviewHeader + 6]).toContain('Browse agent conversation threads and messages');

    const governHeader = indexOfLine('Govern Actions');
    expect(governHeader).toBeGreaterThan(reviewHeader);
    expect(lines[governHeader + 1]).toContain('Handle paused workflow approvals');
    expect(lines[governHeader + 2]).toContain(
      'Approve or reject workflow effects and budget pauses',
    );
    expect(lines[governHeader + 3]).toContain('Approve pending items');
    expect(lines[governHeader + 4]).toContain(
      'Approve plans, merge requests, and workflow effects',
    );

    const maintainHeader = indexOfLine('Maintain Profile');
    expect(maintainHeader).toBeGreaterThan(governHeader);
    expect(lines[maintainHeader + 1]).toContain('Maintain organization profile');
    expect(lines[maintainHeader + 2]).toContain(
      'Check, preview, and sync your organization profile',
    );

    const quickNavHeader = indexOfLine('Quick Navigation');
    expect(quickNavHeader).toBeGreaterThan(maintainHeader);

    // Section 2: Quick Navigation
    expect(lines[quickNavHeader]).toContain('Quick Navigation');
    // Nav items: Dashboard, Status, Activity, Digest, Workflows, Workflow Runs, Profile, Conversations
    expect(lines[quickNavHeader + 1]).toContain('Dashboard');
    expect(lines[quickNavHeader + 2]).toContain('Status');
    expect(lines[quickNavHeader + 3]).toContain('Activity');
    expect(lines[quickNavHeader + 4]).toContain('Digest');
    expect(lines[quickNavHeader + 5]).toContain('Workflows');
    expect(lines[quickNavHeader + 6]).toContain('Workflow Runs');
    expect(lines[quickNavHeader + 7]).toContain('Profile');
    expect(lines[quickNavHeader + 8]).toContain('Conversations');

    // Footer
    const footer = indexOfLine('Quit');
    expect(footer).toBeGreaterThan(quickNavHeader);
    expect(lines[footer]).toContain('Quit');

    instance.unmount();
  });

  it('renders with attention items and verifies badge on task row', async () => {
    const { stdout, chunks } = createMockStdout(80, 50);
    const model = mapHomeToViewModel({
      shellData: {
        approvals: {
          pendingApprovals: [{ id: '1', category: 'plan', title: 'Test Plan', risk: 'low' }],
          summary: { plans: 1, mergeRequests: 0, workflowEffects: 0, githubReviews: 0 },
        },
        prQueue: {
          totalPRs: 2,
          blockedCount: 1,
          readyCount: 1,
          items: [{ prNumber: 42, title: 'Fix bug', blockerCategory: 'checks', canMerge: false }],
        },
      },
    });
    const instance = await render(
      React.createElement(NavigationProvider, null, React.createElement(HomeView, { model })),
      { stdout, patchConsole: false },
    );
    await new Promise<void>((r) => setTimeout(r, 200));

    const output = chunks.join('');

    // Verify the output contains key structural elements
    expect(output).toContain('Ask OpenSlack:');
    expect(output).toContain('Suggested shortcuts');
    expect(output).toContain('See what needs attention');
    expect(output).toContain('Review and merge PRs');
    expect(output).toContain('Approve pending items');
    expect(output).toContain('Quick Navigation');

    // Verify attention badges are rendered
    // "See what needs attention" should have badge showing total attention items count
    expect(output).toContain('(2)'); // 1 approval + 1 PR = 2 attention items
    // "Review and merge PRs" should show open PR count
    expect(output).toContain('(2)'); // 2 open PRs
    // "Approve pending items" should show approval count
    expect(output).toContain('(1)'); // 1 pending approval

    instance.unmount();
  });

  it('renders workflow-first tasks with correct shortcuts', async () => {
    const { stdout, chunks } = createMockStdout(80, 50);
    const model = mapHomeToViewModel();
    const instance = await render(
      React.createElement(NavigationProvider, null, React.createElement(HomeView, { model })),
      { stdout, patchConsole: false },
    );
    await new Promise<void>((r) => setTimeout(r, 200));

    const output = chunks.join('');

    // Verify task labels are present
    expect(output).toContain('See what needs attention');
    expect(output).toContain('Start or continue work');
    expect(output).toContain('Start a workflow');
    expect(output).toContain('Watch running workflows');
    expect(output).toContain('Handle paused workflow approvals');
    expect(output).toContain('Save/share run');
    expect(output).toContain('Publish workflow to GitHub Issues');
    expect(output).toContain('Review and merge PRs');
    expect(output).toContain('Approve pending items');
    expect(output).toContain('Maintain organization profile');
    expect(output).toContain('View active conversations');

    // Verify shortcuts [1] through [6] plus workflow [w]/[a]/[s]/[g] and conversations [c].
    expect(output).toContain('[1]');
    expect(output).toContain('[2]');
    expect(output).toContain('[3]');
    expect(output).toContain('[w]');
    expect(output).toContain('[a]');
    expect(output).toContain('[s]');
    expect(output).toContain('[g]');
    expect(output).toContain('[4]');
    expect(output).toContain('[5]');
    expect(output).toContain('[6]');
    expect(output).toContain('[c]');

    instance.unmount();
  });

  it('renders nav items with correct shortcuts starting from 7', async () => {
    const { stdout, chunks } = createMockStdout(80, 50);
    const model = mapHomeToViewModel();
    const instance = await render(
      React.createElement(NavigationProvider, null, React.createElement(HomeView, { model })),
      { stdout, patchConsole: false },
    );
    await new Promise<void>((r) => setTimeout(r, 200));

    const output = chunks.join('');

    // Verify nav shortcuts [7], [8], [9], [0], [p], [w], [r], [c]
    expect(output).toContain('[7]');
    expect(output).toContain('[8]');
    expect(output).toContain('[9]');
    expect(output).toContain('[0]');
    expect(output).toContain('[p]');
    expect(output).toContain('[w]');
    expect(output).toContain('[r]');
    expect(output).toContain('[c]');

    // Verify nav labels
    expect(output).toContain('Dashboard');
    expect(output).toContain('Status');
    expect(output).toContain('Activity');
    expect(output).toContain('Digest');
    expect(output).toContain('Workflows');
    expect(output).toContain('Workflow Runs');
    expect(output).toContain('Profile');
    expect(output).toContain('Conversations');

    instance.unmount();
  });
});

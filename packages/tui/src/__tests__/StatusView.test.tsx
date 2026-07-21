import { describe, it, expect, afterEach } from 'vitest';
import { Writable } from 'stream';
import React from 'react';
import { render } from '@openslack/tui';
import { ThemeProvider } from '../design-system/ThemeProvider.js';
import StatusView from '../views/StatusView.js';
import type { StatusViewModel } from '../view-models/status.js';

function makeModel(overrides?: Partial<StatusViewModel>): StatusViewModel {
  return {
    title: 'OpenSlack Status',
    version: 'v0.2.0',
    mode: 'SOURCE_CHECKOUT',
    commit: 'abc1234',
    commitSubject: 'feat: add status TUI',
    modules: [statusModule('runtime', 100), statusModule('kernel', null), statusModule('tui', 50)],
    deferredWork: [],
    gitHub: {
      available: true,
      tasksReady: 3,
      tasksClaimed: 1,
      tasksBlocked: 0,
      prsOpen: 5,
      prsBlocked: 2,
      prsReady: 1,
    },
    testSuite: { totalTests: 526, totalFiles: 48 },
    recommendations: [
      { title: 'Review PR #42', action: 'Check the PR', command: 'openslack pr doctor 42' },
    ],
    attentionItems: [
      {
        type: 'pr',
        description: '2 PRs blocked',
        action: 'Check what is blocking',
        priority: 'medium',
      },
    ],
    nextAction: 'Review PR #42',
    ...overrides,
  };
}

function statusModule(name: string, tests: number | null) {
  return {
    name,
    lifecycle: 'ACTIVE',
    maturity: 'LOCAL_READY',
    operatorConfigured: false,
    externalBlockers: ['live_smoke_pending'],
    evidenceRefs: ['test:StatusView.test.tsx'],
    tests,
    components: [],
  };
}

describe('StatusView', () => {
  let instance: { unmount: () => void } | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  async function renderView(model: StatusViewModel): Promise<string> {
    const chunks: string[] = [];
    const stdout = new Writable({
      write(chunk, _, cb) {
        chunks.push(String(chunk));
        cb();
      },
    }) as NodeJS.WriteStream;
    Object.defineProperties(stdout, {
      columns: { value: 80, configurable: true },
      rows: { value: 24, configurable: true },
      isTTY: { value: false, configurable: true },
    });

    instance = await render(
      React.createElement(
        ThemeProvider,
        { mode: 'dark' },
        React.createElement(StatusView, { model }),
      ),
      { stdout, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 150));
    return chunks.join('');
  }

  it('renders header with title and version', async () => {
    const output = await renderView(makeModel());
    expect(output).toContain('OpenSlack Status');
    expect(output).toContain('v0.2.0');
  });

  it('renders commit information', async () => {
    const output = await renderView(makeModel());
    expect(output).toContain('abc1234');
    expect(output).toContain('feat: add status TUI');
  });

  it('renders modules section', async () => {
    const output = await renderView(makeModel());
    expect(output).toContain('runtime');
    expect(output).toContain('kernel');
    expect(output).toContain('tui');
    expect(output).toContain('Declared operator baseline');
    expect(output).toContain('External blockers');
    expect(output).toContain('Evidence');
  });

  it('renders GitHub section when available', async () => {
    const output = await renderView(makeModel());
    expect(output).toContain('Tasks ready');
    expect(output).toContain('PRs open');
    expect(output).toContain('PRs blocked');
  });

  it('renders GitHub unavailable message when not available', async () => {
    const output = await renderView(
      makeModel({
        gitHub: {
          available: false,
          tasksReady: 0,
          tasksClaimed: 0,
          tasksBlocked: 0,
          prsOpen: 0,
          prsBlocked: 0,
          prsReady: 0,
        },
      }),
    );
    expect(output).toContain('unavailable');
  });

  it('renders test suite information', async () => {
    const output = await renderView(makeModel());
    expect(output).toContain('526');
    expect(output).toContain('tests');
  });

  it('renders recommendations', async () => {
    const output = await renderView(makeModel());
    expect(output).toContain('Review PR #42');
  });

  it('renders attention items', async () => {
    const output = await renderView(makeModel());
    expect(output).toContain('2 PRs blocked');
    expect(output).toContain('MEDIUM');
  });

  it('renders "All clear" when no attention items', async () => {
    const output = await renderView(
      makeModel({
        attentionItems: [],
        nextAction: 'All clear',
      }),
    );
    expect(output).toContain('All clear');
  });

  it('renders next action', async () => {
    const output = await renderView(makeModel());
    expect(output).toContain('Next:');
    expect(output).toContain('Review PR #42');
  });

  it('renders keyboard shortcut hints', async () => {
    const output = await renderView(makeModel());
    expect(output).toContain('[q');
    expect(output).toContain('Esc]');
  });

  it('renders with empty data without crashing', async () => {
    const output = await renderView(
      makeModel({
        modules: [],
        gitHub: {
          available: false,
          tasksReady: 0,
          tasksClaimed: 0,
          tasksBlocked: 0,
          prsOpen: 0,
          prsBlocked: 0,
          prsReady: 0,
        },
        testSuite: { totalTests: 0, totalFiles: 0 },
        recommendations: [],
        attentionItems: [],
        nextAction: 'All clear',
      }),
    );
    expect(output).toContain('OpenSlack Status');
    expect(output).toContain('All clear');
  });

  it('renders multiple attention items with different priorities', async () => {
    const output = await renderView(
      makeModel({
        attentionItems: [
          { type: 'health', description: 'Doctor failed', action: 'Run doctor', priority: 'high' },
          { type: 'pr', description: '2 PRs blocked', action: 'Check', priority: 'medium' },
          { type: 'task', description: '3 tasks ready', action: 'Claim', priority: 'low' },
        ],
      }),
    );
    expect(output).toContain('HIGH');
    expect(output).toContain('MEDIUM');
    expect(output).toContain('LOW');
  });
});

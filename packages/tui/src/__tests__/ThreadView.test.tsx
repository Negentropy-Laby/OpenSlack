import { describe, it, expect, afterEach } from 'vitest';
import { Writable } from 'stream';
import React from 'react';
import { render } from '@openslack/tui';
import { ThemeProvider } from '../design-system/ThemeProvider.js';
import ThreadView from '../views/ThreadView.js';
import type { ThreadViewModel } from '../view-models/conversation.js';

function makeModel(overrides?: Partial<ThreadViewModel>): ThreadViewModel {
  return {
    id: 'THREAD-001',
    title: 'Test Thread',
    status: 'active',
    participants: [
      { id: 'user-1', displayName: 'Alice', kind: 'human' },
      { id: 'agent-1', displayName: 'Helper', kind: 'agent' },
    ],
    messages: [
      {
        id: 'MSG-001',
        kind: 'user_message',
        authorDisplay: 'You',
        timestamp: '12:00:00 PM',
        content: 'Hello world',
      },
      {
        id: 'MSG-002',
        kind: 'agent_response',
        authorDisplay: 'Helper',
        timestamp: '12:00:05 PM',
        content: 'Hi there!',
      },
      {
        id: 'MSG-003',
        kind: 'tool_event',
        authorDisplay: 'Helper',
        timestamp: '12:00:10 PM',
        content: 'read_file',
      },
      {
        id: 'MSG-004',
        kind: 'plan',
        authorDisplay: 'Helper',
        timestamp: '12:00:15 PM',
        content: '1. Read the file\n2. Fix the bug\n3. Run tests',
      },
      {
        id: 'MSG-005',
        kind: 'approval_request',
        authorDisplay: 'Helper',
        timestamp: '12:00:20 PM',
        content: 'Deploy to staging',
        metadata: { riskLevel: 'high' },
      },
      {
        id: 'MSG-006',
        kind: 'decision',
        authorDisplay: 'Alice',
        timestamp: '12:00:25 PM',
        content: 'Proceed with deployment',
        metadata: { decisionId: 'DEC-001' },
      },
      {
        id: 'MSG-007',
        kind: 'handoff',
        authorDisplay: 'Helper',
        timestamp: '12:00:30 PM',
        content: 'Handing off to reviewer',
        metadata: { handoffId: 'HO-001', toParticipant: 'reviewer' },
      },
    ],
    linkedObjects: [{ kind: 'issue', id: '42' }],
    ...overrides,
  };
}

describe('ThreadView', () => {
  let instance: { unmount: () => void } | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  async function renderView(model: ThreadViewModel): Promise<string> {
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
        React.createElement(ThreadView, { model }),
      ),
      { stdout, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 150));
    return chunks.join('');
  }

  it('renders thread title and status', async () => {
    const output = await renderView(makeModel());
    expect(output).toContain('Test Thread');
    expect(output).toContain('active');
  });

  it('renders messages for each kind', async () => {
    const output = await renderView(makeModel());
    expect(output).toContain('Hello world');
    expect(output).toContain('Hi there!');
    expect(output).toContain('read_file');
    expect(output).toContain('Plan');
    expect(output).toContain('Approval Request');
    expect(output).toContain('Decision');
    expect(output).toContain('Handoff');
  });

  it('renders participants panel', async () => {
    const output = await renderView(makeModel());
    expect(output).toContain('Participants');
    expect(output).toContain('Alice');
    expect(output).toContain('Helper');
  });

  it('renders empty thread without crashing', async () => {
    const output = await renderView(
      makeModel({
        participants: [],
        messages: [],
        linkedObjects: [],
      }),
    );
    expect(output).toContain('Test Thread');
    expect(output).toContain('No messages in this thread.');
  });

  it('renders next action when present', async () => {
    const output = await renderView(
      makeModel({
        nextAction: { owner: 'user-1', action: 'Review PR', command: 'gh pr review 42' },
      }),
    );
    expect(output).toContain('Next:');
    expect(output).toContain('Review PR');
    expect(output).toContain('Run: gh pr review 42');
  });
});

import { describe, it, expect } from 'vitest';
import {
  mapConversationListToViewModel,
  mapThreadToViewModel,
} from '../view-models/conversation.js';
import type {
  AgentConversationThread,
  AgentConversationMessage,
  AgentParticipant,
} from '@openslack/collaboration';

function makeParticipant(overrides?: Partial<AgentParticipant>): AgentParticipant {
  return {
    id: 'user-1',
    kind: 'human',
    displayName: 'Test User',
    ...overrides,
  };
}

function makeThread(overrides?: Partial<AgentConversationThread>): AgentConversationThread {
  return {
    id: 'THREAD-001',
    schema: 'openslack.agent_conversation_thread.v1',
    title: 'Test Thread',
    status: 'active',
    createdAt: new Date(Date.now() - 7200000).toISOString(),
    updatedAt: new Date(Date.now() - 60000).toISOString(),
    participants: [makeParticipant()],
    linkedObjects: [],
    memoryPolicy: 'project',
    ...overrides,
  };
}

function makeMessage(
  kind: AgentConversationMessage['kind'],
  overrides?: Record<string, unknown>,
): AgentConversationMessage {
  const base = {
    id: 'MSG-001',
    threadId: 'THREAD-001',
    timestamp: new Date().toISOString(),
    authorId: 'user-1',
  };

  switch (kind) {
    case 'user_message':
      return {
        ...base,
        kind: 'user_message',
        text: 'Hello world',
        ...overrides,
      } as AgentConversationMessage;
    case 'agent_response':
      return {
        ...base,
        kind: 'agent_response',
        text: 'Agent reply',
        ...overrides,
      } as AgentConversationMessage;
    case 'tool_event':
      return {
        ...base,
        kind: 'tool_event',
        toolName: 'read_file',
        ...overrides,
      } as AgentConversationMessage;
    case 'plan':
      return {
        ...base,
        kind: 'plan',
        planId: 'PLAN-001',
        steps: ['Step 1', 'Step 2'],
        ...overrides,
      } as AgentConversationMessage;
    case 'approval_request':
      return {
        ...base,
        kind: 'approval_request',
        targetAction: 'deploy',
        riskLevel: 'high',
        ...overrides,
      } as AgentConversationMessage;
    case 'decision':
      return {
        ...base,
        kind: 'decision',
        decisionId: 'DEC-001',
        summary: 'Decided to proceed',
        ...overrides,
      } as AgentConversationMessage;
    case 'handoff':
      return {
        ...base,
        kind: 'handoff',
        handoffId: 'HO-001',
        toParticipant: 'agent-2',
        summary: 'Handing off',
        ...overrides,
      } as AgentConversationMessage;
  }
}

describe('mapConversationListToViewModel', () => {
  it('maps threads correctly', () => {
    const threads = [
      makeThread({ updatedAt: new Date(Date.now() - 30000).toISOString() }),
      makeThread({
        id: 'THREAD-002',
        title: 'Second Thread',
        status: 'completed',
        updatedAt: new Date(Date.now() - 60000).toISOString(),
      }),
    ];
    const model = mapConversationListToViewModel(threads);

    expect(model.title).toBe('Conversations');
    expect(model.totalCount).toBe(2);
    expect(model.activeCount).toBe(1);
    expect(model.items).toHaveLength(2);
    expect(model.items[0].id).toBe('THREAD-001');
    expect(model.items[0].participantCount).toBe(1);
  });

  it('sorts threads by updatedAt descending', () => {
    const threads = [
      makeThread({ id: 'OLD', updatedAt: new Date(Date.now() - 100000).toISOString() }),
      makeThread({ id: 'NEW', updatedAt: new Date(Date.now() - 1000).toISOString() }),
    ];
    const model = mapConversationListToViewModel(threads);

    expect(model.items[0].id).toBe('NEW');
    expect(model.items[1].id).toBe('OLD');
  });

  it('truncates long titles', () => {
    const longTitle = 'A'.repeat(80);
    const threads = [makeThread({ title: longTitle })];
    const model = mapConversationListToViewModel(threads);

    expect(model.items[0].title.length).toBeLessThanOrEqual(60);
    expect(model.items[0].title).toContain('…');
  });

  it('preserves short titles without truncation', () => {
    const threads = [makeThread({ title: 'Short title' })];
    const model = mapConversationListToViewModel(threads);

    expect(model.items[0].title).toBe('Short title');
  });

  it('handles empty list', () => {
    const model = mapConversationListToViewModel([]);
    expect(model.totalCount).toBe(0);
    expect(model.activeCount).toBe(0);
    expect(model.items).toHaveLength(0);
  });

  it('formats last activity timestamp', () => {
    const threads = [makeThread({ updatedAt: new Date(Date.now() - 3600000).toISOString() })];
    const model = mapConversationListToViewModel(threads);
    expect(model.items[0].lastActivity).toBe('1h');
  });

  it('sanitizes escape sequences in titles', () => {
    const threads = [makeThread({ title: 'Bad\x1b[31m inject' })];
    const model = mapConversationListToViewModel(threads);
    expect(model.items[0].title).toBe('Bad inject');
  });
});

describe('mapThreadToViewModel', () => {
  it('maps all 7 message kinds', () => {
    const participants = [
      makeParticipant({ id: 'user-1', kind: 'human', displayName: 'You' }),
      makeParticipant({ id: 'agent-1', kind: 'agent', displayName: 'Helper' }),
    ];
    const thread = makeThread({ participants });
    const messages: AgentConversationMessage[] = [
      makeMessage('user_message'),
      makeMessage('agent_response', { authorId: 'agent-1' }),
      makeMessage('tool_event', { authorId: 'agent-1' }),
      makeMessage('plan', { authorId: 'agent-1' }),
      makeMessage('approval_request', { authorId: 'agent-1' }),
      makeMessage('decision', { authorId: 'agent-1' }),
      makeMessage('handoff', { authorId: 'agent-1' }),
    ];

    const model = mapThreadToViewModel(thread, messages);

    expect(model.messages).toHaveLength(7);
    expect(model.messages[0].kind).toBe('user_message');
    expect(model.messages[1].kind).toBe('agent_response');
    expect(model.messages[2].kind).toBe('tool_event');
    expect(model.messages[3].kind).toBe('plan');
    expect(model.messages[4].kind).toBe('approval_request');
    expect(model.messages[5].kind).toBe('decision');
    expect(model.messages[6].kind).toBe('handoff');
  });

  it('includes participants', () => {
    const participants = [
      makeParticipant({ id: 'user-1', kind: 'human', displayName: 'Alice' }),
      makeParticipant({ id: 'agent-1', kind: 'agent', displayName: 'Bot' }),
    ];
    const thread = makeThread({ participants });
    const model = mapThreadToViewModel(thread, []);

    expect(model.participants).toHaveLength(2);
    expect(model.participants[0].displayName).toBe('Alice');
    expect(model.participants[1].displayName).toBe('Bot');
  });

  it('includes linked objects', () => {
    const thread = makeThread({
      linkedObjects: [
        { kind: 'issue', id: '42' },
        { kind: 'pr', id: '99', url: 'https://github.com/org/repo/pull/99' },
      ],
    });
    const model = mapThreadToViewModel(thread, []);

    expect(model.linkedObjects).toHaveLength(2);
    expect(model.linkedObjects[0].kind).toBe('issue');
    expect(model.linkedObjects[1].id).toBe('99');
  });

  it('includes next action when present', () => {
    const thread = makeThread({
      nextAction: { owner: 'user-1', action: 'Review PR', command: 'gh pr review 42' },
    });
    const model = mapThreadToViewModel(thread, []);

    expect(model.nextAction).toBeDefined();
    expect(model.nextAction!.owner).toBe('user-1');
    expect(model.nextAction!.action).toBe('Review PR');
    expect(model.nextAction!.command).toBe('gh pr review 42');
  });

  it('resolves user_message author as "You"', () => {
    const thread = makeThread();
    const messages = [makeMessage('user_message')];
    const model = mapThreadToViewModel(thread, messages);

    expect(model.messages[0].authorDisplay).toBe('You');
  });

  it('resolves agent name from participants', () => {
    const participants = [
      makeParticipant({ id: 'agent-1', kind: 'agent', displayName: 'CodeHelper' }),
    ];
    const thread = makeThread({ participants });
    const messages = [makeMessage('agent_response', { authorId: 'agent-1' })];
    const model = mapThreadToViewModel(thread, messages);

    expect(model.messages[0].authorDisplay).toBe('CodeHelper');
  });

  it('sorts messages chronologically', () => {
    const thread = makeThread();
    const messages = [
      makeMessage('user_message', {
        id: 'MSG-2',
        timestamp: new Date(Date.now() - 1000).toISOString(),
      }),
      makeMessage('user_message', {
        id: 'MSG-1',
        timestamp: new Date(Date.now() - 2000).toISOString(),
      }),
    ];
    const model = mapThreadToViewModel(thread, messages);

    expect(model.messages[0].id).toBe('MSG-1');
    expect(model.messages[1].id).toBe('MSG-2');
  });

  it('sanitizes escape sequences in message content', () => {
    const thread = makeThread();
    const messages = [makeMessage('user_message', { text: 'Bad\x1b[31m inject' })];
    const model = mapThreadToViewModel(thread, messages);

    expect(model.messages[0].content).toBe('Bad inject');
  });

  // --- M4: Exhaustiveness guard test ---

  it('mapMessageToItem throws for unknown message kind', () => {
    const thread = makeThread();
    // Bypass TypeScript to simulate an unknown future message kind
    const unknownMsg = {
      id: 'MSG-UNKNOWN',
      threadId: 'THREAD-001',
      timestamp: new Date().toISOString(),
      authorId: 'user-1',
      kind: 'unknown_future_kind',
    } as unknown as AgentConversationMessage;
    const messages = [unknownMsg];

    expect(() => mapThreadToViewModel(thread, messages)).toThrow(/Unhandled message kind/);
  });
});

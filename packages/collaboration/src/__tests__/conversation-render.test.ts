import { describe, it, expect } from 'vitest';
import { renderThreadList, renderThread, renderMessage } from '../conversation-render.js';
import type {
  AgentConversationThread,
  AgentConversationMessage,
  AgentParticipant,
  ConversationLinkedObject,
} from '../conversation-types.js';

const now = new Date().toISOString();

const participant: AgentParticipant = {
  id: 'agent-1',
  kind: 'agent',
  provider: 'openslack',
  displayName: 'Claude',
  role: 'implementer',
};

const linkedObject: ConversationLinkedObject = {
  kind: 'pr',
  id: '42',
  url: 'https://github.com/org/repo/pull/42',
};

function makeThread(overrides: Partial<AgentConversationThread> = {}): AgentConversationThread {
  return {
    id: 'CONV-20260602-TEST1',
    schema: 'openslack.agent_conversation_thread.v1',
    title: 'Test Thread',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    participants: [participant],
    linkedObjects: [linkedObject],
    memoryPolicy: 'local',
    ...overrides,
  };
}

function makeMessage(
  overrides: Partial<AgentConversationMessage> & { kind: AgentConversationMessage['kind'] },
): AgentConversationMessage {
  return {
    id: 'MSG-20260602-TEST1',
    threadId: 'CONV-20260602-TEST1',
    timestamp: now,
    authorId: 'agent-1',
    ...overrides,
  } as AgentConversationMessage;
}

describe('conversation-render', () => {
  describe('renderThreadList', () => {
    it('renders empty list', () => {
      const output = renderThreadList([]);
      expect(output).toContain('No conversations found');
    });

    it('renders thread list with header', () => {
      const threads = [makeThread()];
      const output = renderThreadList(threads);
      expect(output).toContain('Conversations');
      expect(output).toContain('CONV-20260602-TEST1');
      expect(output).toContain('Test Thread');
    });

    it('renders status icon for open thread', () => {
      const threads = [makeThread({ status: 'open' })];
      const output = renderThreadList(threads);
      expect(output).toContain('○');
    });

    it('renders status icon for active thread', () => {
      const threads = [makeThread({ status: 'active' })];
      const output = renderThreadList(threads);
      expect(output).toContain('●');
    });

    it('renders status icon for paused thread', () => {
      const threads = [makeThread({ status: 'paused' })];
      const output = renderThreadList(threads);
      expect(output).toContain('◐');
    });

    it('renders status icon for completed thread', () => {
      const threads = [makeThread({ status: 'completed' })];
      const output = renderThreadList(threads);
      expect(output).toContain('◉');
    });

    it('renders linked objects', () => {
      const threads = [makeThread()];
      const output = renderThreadList(threads);
      expect(output).toContain('pr:42');
    });

    it('renders summary when present', () => {
      const threads = [makeThread({ summary: 'Working on the feature' })];
      const output = renderThreadList(threads);
      expect(output).toContain('Working on the feature');
    });

    it('renders nextAction when present', () => {
      const threads = [
        makeThread({
          nextAction: { owner: 'agent-1', action: 'Review PR', command: 'openslack pr doctor 42' },
        }),
      ];
      const output = renderThreadList(threads);
      expect(output).toContain('agent-1');
      expect(output).toContain('Review PR');
    });

    it('truncates long titles', () => {
      const longTitle = 'A'.repeat(80);
      const threads = [makeThread({ title: longTitle })];
      const output = renderThreadList(threads);
      expect(output).toContain('...');
    });
  });

  describe('renderThread', () => {
    it('renders thread metadata', () => {
      const thread = makeThread();
      const output = renderThread(thread, []);
      expect(output).toContain('Conversation: CONV-20260602-TEST1');
      expect(output).toContain('Test Thread');
      expect(output).toContain('active');
      expect(output).toContain('local');
    });

    it('renders participants', () => {
      const thread = makeThread();
      const output = renderThread(thread, []);
      expect(output).toContain('Participants');
      expect(output).toContain('Claude');
      expect(output).toContain('implementer');
      expect(output).toContain('openslack');
    });

    it('renders linked objects with url', () => {
      const thread = makeThread();
      const output = renderThread(thread, []);
      expect(output).toContain('Linked Objects');
      expect(output).toContain('pr:42');
      expect(output).toContain('https://github.com/org/repo/pull/42');
    });

    it('renders summary', () => {
      const thread = makeThread({ summary: 'Feature implementation' });
      const output = renderThread(thread, []);
      expect(output).toContain('Summary');
      expect(output).toContain('Feature implementation');
    });

    it('renders nextAction', () => {
      const thread = makeThread({ nextAction: { owner: 'human-1', action: 'Approve PR' } });
      const output = renderThread(thread, []);
      expect(output).toContain('Next Action');
      expect(output).toContain('human-1');
      expect(output).toContain('Approve PR');
    });

    it('renders nextAction with command', () => {
      const thread = makeThread({
        nextAction: { owner: 'agent-1', action: 'Run tests', command: 'bun test' },
      });
      const output = renderThread(thread, []);
      expect(output).toContain('Command: bun test');
    });

    it('renders messages', () => {
      const thread = makeThread();
      const messages: AgentConversationMessage[] = [
        makeMessage({ kind: 'user_message', text: 'Hello' }),
        makeMessage({ kind: 'agent_response', text: 'Hi there' }),
      ];
      const output = renderThread(thread, messages);
      expect(output).toContain('Messages (2)');
      expect(output).toContain('Hello');
      expect(output).toContain('Hi there');
    });
  });

  describe('renderMessage', () => {
    it('renders user_message', () => {
      const msg = makeMessage({ kind: 'user_message', text: 'Hello world' });
      const output = renderMessage(msg);
      expect(output).toContain('agent-1');
      expect(output).toContain('Hello world');
    });

    it('renders user_message with source', () => {
      const msg = makeMessage({
        kind: 'user_message',
        text: 'Hello',
        source: { kind: 'slack', ref: 'channel-1' },
      });
      const output = renderMessage(msg);
      expect(output).toContain('via slack');
    });

    it('renders agent_response', () => {
      const msg = makeMessage({ kind: 'agent_response', text: 'Response text' });
      const output = renderMessage(msg);
      expect(output).toContain('agent-1');
      expect(output).toContain('Response text');
    });

    it('renders agent_response with structured tag', () => {
      const msg = makeMessage({
        kind: 'agent_response',
        text: 'Data',
        structured: { type: 'json', value: 42 },
      });
      const output = renderMessage(msg);
      expect(output).toContain('(structured)');
    });

    it('renders tool_event', () => {
      const msg = makeMessage({ kind: 'tool_event', toolName: 'readFile' });
      const output = renderMessage(msg);
      expect(output).toContain('tool:readFile');
    });

    it('renders tool_event with output', () => {
      const msg = makeMessage({ kind: 'tool_event', toolName: 'bash', output: 'success' });
      const output = renderMessage(msg);
      expect(output).toContain('=> output');
    });

    it('renders plan', () => {
      const msg = makeMessage({ kind: 'plan', planId: 'PLAN-1', steps: ['Step one', 'Step two'] });
      const output = renderMessage(msg);
      expect(output).toContain('plan:PLAN-1');
      expect(output).toContain('1. Step one');
      expect(output).toContain('2. Step two');
    });

    it('renders approval_request', () => {
      const msg = makeMessage({
        kind: 'approval_request',
        targetAction: 'merge',
        riskLevel: 'high',
      });
      const output = renderMessage(msg);
      expect(output).toContain('approval_needed');
      expect(output).toContain('merge');
      expect(output).toContain('high');
    });

    it('renders decision', () => {
      const msg = makeMessage({ kind: 'decision', decisionId: 'DEC-1', summary: 'Use approach A' });
      const output = renderMessage(msg);
      expect(output).toContain('decision:DEC-1');
      expect(output).toContain('Use approach A');
    });

    it('renders handoff', () => {
      const msg = makeMessage({
        kind: 'handoff',
        handoffId: 'HO-1',
        toParticipant: 'agent-2',
        summary: 'Passing',
      });
      const output = renderMessage(msg);
      expect(output).toContain('handoff:HO-1');
      expect(output).toContain('agent-2');
      expect(output).toContain('Passing');
    });
  });
});

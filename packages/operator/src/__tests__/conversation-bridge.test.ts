import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createConversationStoreBinding,
  registerConversationStoreAdapter,
  resetConversationStoreAdapter,
  listConversationsForOperator,
  showConversationForOperator,
  sendConversationMessage,
} from '../conversation-bridge.js';
import type { ConversationDetailView, ConversationStoreAdapter } from '../conversation-bridge.js';

const mockListThreads = vi.fn();
const mockGetThread = vi.fn();
const mockAppendMessage = vi.fn();

const mockAdapter: ConversationStoreAdapter = {
  listThreads: (opts) =>
    mockListThreads(opts) as ReturnType<ConversationStoreAdapter['listThreads']>,
  getThread: (id) => mockGetThread(id) as ReturnType<ConversationStoreAdapter['getThread']>,
  appendMessage: (threadId, authorId, text) =>
    mockAppendMessage(threadId, authorId, text) as ReturnType<
      ConversationStoreAdapter['appendMessage']
    >,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetConversationStoreAdapter();
  registerConversationStoreAdapter(mockAdapter);
});

describe('conversation-bridge', () => {
  it('listConversationsForOperator returns threads', () => {
    mockListThreads.mockReturnValue([
      {
        id: 'CONV-001',
        title: 'Alpha',
        status: 'open',
        participantCount: 0,
        lastActivity: '2026-06-02T10:00:00Z',
      },
      {
        id: 'CONV-002',
        title: 'Beta',
        status: 'active',
        participantCount: 1,
        lastActivity: '2026-06-02T11:00:00Z',
      },
    ]);

    const result = listConversationsForOperator();

    expect(mockListThreads).toHaveBeenCalledWith(undefined);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('CONV-001');
    expect(result[0].participantCount).toBe(0);
    expect(result[1].id).toBe('CONV-002');
    expect(result[1].participantCount).toBe(1);
  });

  it('listConversationsForOperator passes status filter', () => {
    mockListThreads.mockImplementation((opts?: unknown) => {
      const o = opts as { status?: string } | undefined;
      if (o?.status === 'active') {
        return [
          {
            id: 'CONV-002',
            title: 'Beta',
            status: 'active',
            participantCount: 1,
            lastActivity: '2026-06-02T11:00:00Z',
          },
        ];
      }
      return [];
    });

    const result = listConversationsForOperator({ status: 'active' });

    expect(mockListThreads).toHaveBeenCalledWith({ status: 'active' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('CONV-002');
  });

  it('showConversationForOperator returns rendered thread', () => {
    mockGetThread.mockReturnValue({
      id: 'CONV-001',
      title: 'Test Thread',
      status: 'active',
      createdAt: '2026-06-02T10:00:00Z',
      updatedAt: '2026-06-02T11:00:00Z',
      participants: ['Alice'],
      linkedObjects: ['pr:42'],
      messages: ['[user] alice: Hello', '[agent] agent-1: Hi there'],
    });

    const result = showConversationForOperator('CONV-001');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('CONV-001');
    expect(result!.title).toBe('Test Thread');
    expect(result!.status).toBe('active');
    expect(result!.participants).toEqual(['Alice']);
    expect(result!.linkedObjects).toEqual(['pr:42']);
    expect(result!.messages).toHaveLength(2);
  });

  it('showConversationForOperator returns null for unknown thread', () => {
    mockGetThread.mockReturnValue(null);

    const result = showConversationForOperator('CONV-999');

    expect(result).toBeNull();
  });

  it('sendConversationMessage appends message', () => {
    mockAppendMessage.mockReturnValue({
      messageId: 'MSG-NEW',
      threadId: 'CONV-001',
    });

    const result = sendConversationMessage('CONV-001', 'Please review', 'operator');

    expect(mockAppendMessage).toHaveBeenCalledWith('CONV-001', 'operator', 'Please review');
    expect(result.messageId).toBe('MSG-NEW');
    expect(result.threadId).toBe('CONV-001');
  });

  // --- M8: Singleton guard tests ---

  it('throws when registering adapter twice without reset', () => {
    // Adapter is already registered in beforeEach
    expect(() => registerConversationStoreAdapter(mockAdapter)).toThrow(/already registered/);
  });

  it('resetConversationStoreAdapter allows re-registration', () => {
    resetConversationStoreAdapter();
    // Should not throw after reset
    expect(() => registerConversationStoreAdapter(mockAdapter)).not.toThrow();
  });

  it('resetConversationStoreAdapter throws outside test environment', () => {
    const origNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(() => resetConversationStoreAdapter()).toThrow(/only available in test/);
    } finally {
      process.env.NODE_ENV = origNodeEnv;
    }
  });
});

describe('instance-scoped conversation-store bindings', () => {
  it('keeps list, show, and send delegation isolated between bindings', () => {
    const firstList = vi.fn(() => [
      {
        id: 'FIRST',
        title: 'First',
        status: 'open',
        participantCount: 1,
        lastActivity: '2026-07-16T00:00:00Z',
      },
    ]);
    const secondList = vi.fn(() => [
      {
        id: 'SECOND',
        title: 'Second',
        status: 'active',
        participantCount: 2,
        lastActivity: '2026-07-16T01:00:00Z',
      },
    ]);
    const firstShow = vi.fn(() => null);
    const secondDetail: ConversationDetailView = {
      id: 'SECOND',
      title: 'Second',
      status: 'active',
      createdAt: '2026-07-16T00:00:00Z',
      updatedAt: '2026-07-16T01:00:00Z',
      participants: ['operator'],
      linkedObjects: [],
      messages: [],
    };
    const secondShow = vi.fn(() => secondDetail);
    const firstSend = vi.fn(() => ({ messageId: 'FIRST-MESSAGE', threadId: 'FIRST' }));
    const secondSend = vi.fn(() => ({ messageId: 'SECOND-MESSAGE', threadId: 'SECOND' }));
    const firstBinding = createConversationStoreBinding();
    const secondBinding = createConversationStoreBinding();

    expect('resetForTests' in firstBinding).toBe(false);

    firstBinding.bind({
      listThreads: firstList,
      getThread: firstShow,
      appendMessage: firstSend,
    });
    secondBinding.bind({
      listThreads: secondList,
      getThread: secondShow,
      appendMessage: secondSend,
    });

    expect(firstBinding.list({ status: 'open' })[0]?.id).toBe('FIRST');
    expect(secondBinding.list({ status: 'active' })[0]?.id).toBe('SECOND');
    expect(firstBinding.show('FIRST')).toBeNull();
    expect(secondBinding.show('SECOND')).toBe(secondDetail);
    expect(firstBinding.send('FIRST', 'one', 'operator')).toEqual({
      messageId: 'FIRST-MESSAGE',
      threadId: 'FIRST',
    });
    expect(secondBinding.send('SECOND', 'two', 'operator')).toEqual({
      messageId: 'SECOND-MESSAGE',
      threadId: 'SECOND',
    });
    expect(firstList).toHaveBeenCalledWith({ status: 'open' });
    expect(secondList).toHaveBeenCalledWith({ status: 'active' });
    expect(firstShow).toHaveBeenCalledWith('FIRST');
    expect(secondShow).toHaveBeenCalledWith('SECOND');
    expect(firstSend).toHaveBeenCalledWith('FIRST', 'operator', 'one');
    expect(secondSend).toHaveBeenCalledWith('SECOND', 'operator', 'two');
  });

  it('enforces bind-once per instance without affecting another binding', () => {
    const firstBinding = createConversationStoreBinding();
    const secondBinding = createConversationStoreBinding();
    const adapter: ConversationStoreAdapter = {
      listThreads: () => [],
      getThread: () => null,
      appendMessage: (threadId) => ({ messageId: 'message', threadId }),
    };

    firstBinding.bind(adapter);

    expect(() => firstBinding.bind(adapter)).toThrow(
      'Conversation store binding is already bound. Create a new binding for another adapter.',
    );
    expect(() => secondBinding.list()).toThrow(
      'Conversation store binding is not bound. Call bind(adapter) first.',
    );
    expect(() => secondBinding.bind(adapter)).not.toThrow();
    expect(secondBinding.list()).toEqual([]);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { conversationCommands } from '../commands/conversation.js';

const mockCreateThread = vi.fn();
const mockListThreads = vi.fn();
const mockGetThread = vi.fn();
const mockAppendMessage = vi.fn();
const mockArchiveThread = vi.fn();

vi.mock('@openslack/collaboration', () => ({
  createThread: (opts: unknown) => mockCreateThread(opts),
  listThreads: (opts?: unknown) => mockListThreads(opts),
  getThread: (id: string) => mockGetThread(id),
  appendMessage: (threadId: string, msg: unknown) => mockAppendMessage(threadId, msg),
  archiveThread: (id: string) => mockArchiveThread(id),
  renderMessage: (msg: { kind: string; authorId?: string; text?: string; [key: string]: unknown }) => {
    const ts = new Date((msg as { timestamp?: string }).timestamp || '').toLocaleString();
    switch (msg.kind) {
      case 'user_message':
        return `[user] ${msg.authorId} (${ts}): ${msg.text}`;
      case 'agent_response':
        return `[agent] ${msg.authorId} (${ts}): ${msg.text}`;
      case 'tool_event':
        return `[tool] ${(msg as { toolName?: string }).toolName}`;
      default:
        return `[${msg.kind}]`;
    }
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('conversation CLI commands', () => {
  it('conversation start creates thread and returns id', async () => {
    mockCreateThread.mockReturnValue({
      id: 'CONV-20260602-ABCD',
      title: 'Test Thread',
      status: 'open',
      schema: 'openslack.agent_conversation_thread.v1',
    });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });

    const cmd = conversationCommands();
    await cmd.parseAsync(['node', 'openslack conversation', 'start', '--title', 'Test Thread'], { from: 'node' });

    logSpy.mockRestore();

    expect(mockCreateThread).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Test Thread' }),
    );
    const output = logs.join('\n');
    expect(output).toContain('CONV-20260602-ABCD');
    expect(output).toContain('Test Thread');
  });

  it('conversation list returns formatted table', async () => {
    mockListThreads.mockReturnValue([
      { id: 'CONV-001', title: 'Alpha', status: 'open', participants: [], updatedAt: '2026-06-02T10:00:00Z' },
      { id: 'CONV-002', title: 'Beta', status: 'active', participants: [{ id: 'u1', displayName: 'User 1' }], updatedAt: '2026-06-02T11:00:00Z' },
    ]);

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });

    const cmd = conversationCommands();
    await cmd.parseAsync(['node', 'openslack conversation', 'list'], { from: 'node' });

    logSpy.mockRestore();

    const output = logs.join('\n');
    expect(output).toContain('CONV-001');
    expect(output).toContain('CONV-002');
    expect(output).toContain('Alpha');
  });

  it('conversation list with --status filter', async () => {
    mockListThreads.mockImplementation((opts?: unknown) => {
      const o = opts as { status?: string } | undefined;
      if (o?.status === 'active') {
        return [{ id: 'CONV-002', title: 'Beta', status: 'active', participants: [], updatedAt: '2026-06-02T11:00:00Z' }];
      }
      return [];
    });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });

    const cmd = conversationCommands();
    await cmd.parseAsync(['node', 'openslack conversation', 'list', '--status', 'active'], { from: 'node' });

    logSpy.mockRestore();

    expect(mockListThreads).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
    expect(logs.join('\n')).toContain('CONV-002');
  });

  it('conversation show renders thread with messages', async () => {
    mockGetThread.mockReturnValue({
      thread: {
        id: 'CONV-001',
        title: 'Test Thread',
        status: 'active',
        schema: 'openslack.agent_conversation_thread.v1',
        createdAt: '2026-06-02T10:00:00Z',
        updatedAt: '2026-06-02T11:00:00Z',
        participants: [{ id: 'u1', displayName: 'Alice' }],
        linkedObjects: [],
      },
      messages: [
        { kind: 'user_message', id: 'MSG-001', threadId: 'CONV-001', timestamp: '2026-06-02T10:05:00Z', authorId: 'alice', text: 'Hello' },
      ],
    });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });

    const cmd = conversationCommands();
    await cmd.parseAsync(['node', 'openslack conversation', 'show', 'CONV-001'], { from: 'node' });

    logSpy.mockRestore();

    const output = logs.join('\n');
    expect(output).toContain('Test Thread');
    expect(output).toContain('CONV-001');
    expect(output).toContain('Hello');
    expect(output).toContain('alice');
  });

  it('conversation show for unknown thread shows error', async () => {
    mockGetThread.mockReturnValue(null);

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    const cmd = conversationCommands();
    await expect(
      cmd.parseAsync(['node', 'openslack conversation', 'show', 'CONV-999'], { from: 'node' }),
    ).rejects.toThrow('process.exit');

    logSpy.mockRestore();
    exitSpy.mockRestore();

    expect(logs.join('\n')).toContain('not found');
  });

  it('conversation send appends user message', async () => {
    mockAppendMessage.mockReturnValue({
      kind: 'user_message',
      id: 'MSG-NEW',
      threadId: 'CONV-001',
      timestamp: new Date().toISOString(),
      authorId: 'cli-user',
      text: 'Hello world',
    });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });

    const cmd = conversationCommands();
    await cmd.parseAsync(['node', 'openslack conversation', 'send', 'CONV-001', 'Hello world'], { from: 'node' });

    logSpy.mockRestore();

    expect(mockAppendMessage).toHaveBeenCalledWith(
      'CONV-001',
      expect.objectContaining({
        kind: 'user_message',
        authorId: 'cli-user',
        text: 'Hello world',
      }),
    );
    const output = logs.join('\n');
    expect(output).toContain('MSG-NEW');
  });

  it('conversation summarize shows summary', async () => {
    mockGetThread.mockReturnValue({
      thread: {
        id: 'CONV-001',
        title: 'Test',
        status: 'active',
        summary: 'A test conversation about testing.',
        nextAction: { owner: 'alice', action: 'Review PR', command: 'gh pr review 42' },
        schema: 'openslack.agent_conversation_thread.v1',
        createdAt: '2026-06-02T10:00:00Z',
        updatedAt: '2026-06-02T11:00:00Z',
      },
      messages: [],
    });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });

    const cmd = conversationCommands();
    await cmd.parseAsync(['node', 'openslack conversation', 'summarize', 'CONV-001'], { from: 'node' });

    logSpy.mockRestore();

    const output = logs.join('\n');
    expect(output).toContain('A test conversation about testing.');
    expect(output).toContain('Review PR');
    expect(output).toContain('alice');
    expect(output).toContain('gh pr review 42');
  });

  it('conversation archive updates status', async () => {
    mockArchiveThread.mockReturnValue(true);

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });

    const cmd = conversationCommands();
    await cmd.parseAsync(['node', 'openslack conversation', 'archive', 'CONV-001'], { from: 'node' });

    logSpy.mockRestore();

    expect(mockArchiveThread).toHaveBeenCalledWith('CONV-001');
    const output = logs.join('\n');
    expect(output).toContain('archived');
  });

  it('conversation list shows empty message when no threads', async () => {
    mockListThreads.mockReturnValue([]);

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });

    const cmd = conversationCommands();
    await cmd.parseAsync(['node', 'openslack conversation', 'list'], { from: 'node' });

    logSpy.mockRestore();

    expect(logs.join('\n')).toContain('No conversation threads found');
  });

  // R2: CLI try/catch for validateThreadId throws

  it('show prints error for invalid thread ID format', async () => {
    mockGetThread.mockImplementation(() => {
      throw new Error('Invalid thread ID: "INVALID". Must match CONV-YYYYMMDD-XXXX format.');
    });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    const cmd = conversationCommands();
    await expect(
      cmd.parseAsync(['node', 'openslack conversation', 'show', 'INVALID'], { from: 'node' }),
    ).rejects.toThrow('process.exit');

    logSpy.mockRestore();
    exitSpy.mockRestore();

    const output = logs.join('\n');
    expect(output).toContain('Invalid thread ID');
    // Must NOT contain a stack trace
    expect(output).not.toContain('at ');
    expect(output).not.toContain('Error:');
  });

  it('send prints error for invalid thread ID', async () => {
    mockAppendMessage.mockImplementation(() => {
      throw new Error('Invalid thread ID: "INVALID". Must match CONV-YYYYMMDD-XXXX format.');
    });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    const cmd = conversationCommands();
    await expect(
      cmd.parseAsync(['node', 'openslack conversation', 'send', 'INVALID', 'Hello'], { from: 'node' }),
    ).rejects.toThrow('process.exit');

    logSpy.mockRestore();
    exitSpy.mockRestore();

    const output = logs.join('\n');
    expect(output).toContain('Invalid thread ID');
    expect(output).not.toContain('at ');
    expect(output).not.toContain('Error:');
  });

  it('archive prints error for invalid thread ID', async () => {
    mockArchiveThread.mockImplementation(() => {
      throw new Error('Invalid thread ID: "INVALID". Must match CONV-YYYYMMDD-XXXX format.');
    });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    const cmd = conversationCommands();
    await expect(
      cmd.parseAsync(['node', 'openslack conversation', 'archive', 'INVALID'], { from: 'node' }),
    ).rejects.toThrow('process.exit');

    logSpy.mockRestore();
    exitSpy.mockRestore();

    const output = logs.join('\n');
    expect(output).toContain('Invalid thread ID');
    expect(output).not.toContain('at ');
    expect(output).not.toContain('Error:');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createThread,
  listThreads,
  getThread,
  appendMessage,
  archiveThread,
  pruneExpiredThreads,
} from '../conversation-store.js';

describe('conversation-store', () => {
  let origCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'openslack-conv-test-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a thread with defaults', () => {
    const t = createThread({ title: 'Test Thread' });

    expect(t.id.startsWith('CONV-')).toBe(true);
    expect(t.schema).toBe('openslack.agent_conversation_thread.v1');
    expect(t.title).toBe('Test Thread');
    expect(t.status).toBe('open');
    expect(t.participants).toEqual([]);
    expect(t.linkedObjects).toEqual([]);
    expect(t.memoryPolicy).toBe('local');
    expect(t.createdAt).toBe(t.updatedAt);
  });

  it('creates a thread with options', () => {
    const t = createThread({
      title: 'Feature Work',
      participants: [
        { id: 'agent-1', kind: 'agent', displayName: 'Claude', role: 'implementer' },
      ],
      linkedObjects: [{ kind: 'issue', id: '42' }],
      memoryPolicy: 'project',
    });

    expect(t.participants).toHaveLength(1);
    expect(t.participants[0].id).toBe('agent-1');
    expect(t.linkedObjects).toHaveLength(1);
    expect(t.linkedObjects[0].kind).toBe('issue');
    expect(t.memoryPolicy).toBe('project');
  });

  it('persists thread.json to filesystem', () => {
    const t = createThread({ title: 'Persisted' });
    const threadPath = join(tmpDir, '.openslack.local', 'conversations', t.id, 'thread.json');

    expect(existsSync(threadPath)).toBe(true);
    const raw = readFileSync(threadPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe(t.id);
    expect(parsed.schema).toBe('openslack.agent_conversation_thread.v1');
  });

  it('lists threads sorted by updatedAt descending', async () => {
    const t1 = createThread({ title: 'First' });
    await new Promise((r) => setTimeout(r, 50));
    const t2 = createThread({ title: 'Second' });

    const list = listThreads();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(t2.id);
    expect(list[1].id).toBe(t1.id);
  });

  it('lists threads filtered by status', () => {
    createThread({ title: 'Open Thread' });
    const t2 = createThread({ title: 'To Archive' });
    archiveThread(t2.id);

    const openList = listThreads({ status: 'open' });
    const archivedList = listThreads({ status: 'archived' });

    expect(openList).toHaveLength(1);
    expect(archivedList).toHaveLength(1);
    expect(archivedList[0].status).toBe('archived');
  });

  it('returns empty list when no threads exist', () => {
    expect(listThreads()).toEqual([]);
  });

  it('gets a thread by id with messages', () => {
    const t = createThread({ title: 'With Messages' });
    appendMessage(t.id, { kind: 'user_message', threadId: t.id, authorId: 'user-1', text: 'Hello' });

    const result = getThread(t.id);
    expect(result).not.toBeNull();
    expect(result!.thread.id).toBe(t.id);
    expect(result!.messages).toHaveLength(1);
    const m = result!.messages[0];
    if (m.kind === 'user_message') {
      expect(m.text).toBe('Hello');
    }
  });

  it('returns null for unknown thread', () => {
    expect(getThread('CONV-NOTFOUND')).toBeNull();
  });

  it('appends user_message', () => {
    const t = createThread({ title: 'Msg' });
    const msg = appendMessage(t.id, { kind: 'user_message', threadId: t.id, authorId: 'user-1', text: 'Hi' });

    expect(msg.kind).toBe('user_message');
    expect(msg.id.startsWith('MSG-')).toBe(true);
    expect(msg.timestamp).toBeDefined();
    if (msg.kind === 'user_message') {
      expect(msg.text).toBe('Hi');
    }
  });

  it('appends agent_response', () => {
    const t = createThread({ title: 'Msg' });
    const msg = appendMessage(t.id, { kind: 'agent_response', threadId: t.id, authorId: 'agent-1', text: 'Response' });

    expect(msg.kind).toBe('agent_response');
    if (msg.kind === 'agent_response') {
      expect(msg.text).toBe('Response');
    }
  });

  it('appends tool_event', () => {
    const t = createThread({ title: 'Msg' });
    const msg = appendMessage(t.id, { kind: 'tool_event', threadId: t.id, authorId: 'agent-1', toolName: 'readFile' });

    expect(msg.kind).toBe('tool_event');
    if (msg.kind === 'tool_event') {
      expect(msg.toolName).toBe('readFile');
    }
  });

  it('appends plan', () => {
    const t = createThread({ title: 'Msg' });
    const msg = appendMessage(t.id, { kind: 'plan', threadId: t.id, authorId: 'agent-1', planId: 'PLAN-1', steps: ['a', 'b'] });

    expect(msg.kind).toBe('plan');
    if (msg.kind === 'plan') {
      expect(msg.planId).toBe('PLAN-1');
      expect(msg.steps).toEqual(['a', 'b']);
    }
  });

  it('appends approval_request', () => {
    const t = createThread({ title: 'Msg' });
    const msg = appendMessage(t.id, { kind: 'approval_request', threadId: t.id, authorId: 'agent-1', targetAction: 'merge', riskLevel: 'high' });

    expect(msg.kind).toBe('approval_request');
    if (msg.kind === 'approval_request') {
      expect(msg.targetAction).toBe('merge');
      expect(msg.riskLevel).toBe('high');
    }
  });

  it('appends decision', () => {
    const t = createThread({ title: 'Msg' });
    const msg = appendMessage(t.id, { kind: 'decision', threadId: t.id, authorId: 'agent-1', decisionId: 'DEC-1', summary: 'Go with A' });

    expect(msg.kind).toBe('decision');
    if (msg.kind === 'decision') {
      expect(msg.decisionId).toBe('DEC-1');
      expect(msg.summary).toBe('Go with A');
    }
  });

  it('appends handoff', () => {
    const t = createThread({ title: 'Msg' });
    const msg = appendMessage(t.id, { kind: 'handoff', threadId: t.id, authorId: 'agent-1', handoffId: 'HO-1', toParticipant: 'agent-2', summary: 'Take over' });

    expect(msg.kind).toBe('handoff');
    if (msg.kind === 'handoff') {
      expect(msg.handoffId).toBe('HO-1');
      expect(msg.toParticipant).toBe('agent-2');
      expect(msg.summary).toBe('Take over');
    }
  });

  it('throws when appending to nonexistent thread', () => {
    expect(() =>
      appendMessage('CONV-NOTFOUND', { kind: 'user_message', threadId: 'CONV-NOTFOUND', authorId: 'x', text: 'fail' })
    ).toThrow('Thread not found');
  });

  // P2: Secret scanning on thread metadata

  it('rejects thread creation with secret in title', () => {
    expect(() =>
      createThread({ title: 'My ' + 'ghp_' + 'abcdef1234567890abcdef1234567890abcd token' })
    ).toThrow(/Thread title contains.*GitHub token/i);
  });

  it('rejects thread creation with secret in participants', () => {
    const ghToken = 'ghp_' + 'testtoken123456789forsecretscan';
    expect(() =>
      createThread({
        title: 'Safe title',
        participants: [{ id: 'u1', kind: 'human', displayName: 'Key: ' + ghToken }],
      })
    ).toThrow(/participants contain.*GitHub token/i);
  });

  it('transitions status from open to active on first message', () => {
    const t = createThread({ title: 'Status' });
    expect(t.status).toBe('open');

    appendMessage(t.id, { kind: 'user_message', threadId: t.id, authorId: 'user-1', text: 'Hi' });

    const result = getThread(t.id);
    expect(result!.thread.status).toBe('active');
  });

  it('persists messages to messages.jsonl', () => {
    const t = createThread({ title: 'JSONL' });
    appendMessage(t.id, { kind: 'user_message', threadId: t.id, authorId: 'u1', text: 'Line 1' });
    appendMessage(t.id, { kind: 'agent_response', threadId: t.id, authorId: 'a1', text: 'Line 2' });

    const jsonlPath = join(tmpDir, '.openslack.local', 'conversations', t.id, 'messages.jsonl');
    expect(existsSync(jsonlPath)).toBe(true);

    const raw = readFileSync(jsonlPath, 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);

    const msg1 = JSON.parse(lines[0]);
    expect(msg1.kind).toBe('user_message');
    expect(msg1.text).toBe('Line 1');

    const msg2 = JSON.parse(lines[1]);
    expect(msg2.kind).toBe('agent_response');
    expect(msg2.text).toBe('Line 2');
  });

  it('archives an open thread', () => {
    const t = createThread({ title: 'Archive' });
    const result = archiveThread(t.id);

    expect(result).toBe(true);
    const fetched = getThread(t.id);
    expect(fetched!.thread.status).toBe('archived');
  });

  it('returns false when archiving unknown thread', () => {
    expect(archiveThread('CONV-NOTFOUND')).toBe(false);
  });

  it('returns false when archiving already archived thread', () => {
    const t = createThread({ title: 'Double' });
    archiveThread(t.id);
    expect(archiveThread(t.id)).toBe(false);
  });

  it('prunes expired threads', async () => {
    const t = createThread({ title: 'Old' });
    appendMessage(t.id, { kind: 'user_message', threadId: t.id, authorId: 'u1', text: 'Hi' });

    // Verify it exists
    expect(getThread(t.id)).not.toBeNull();

    // Prune with very short max age (1ms)
    await new Promise((r) => setTimeout(r, 10));
    const removed = pruneExpiredThreads(1);

    expect(removed).toBe(1);
    expect(getThread(t.id)).toBeNull();
  });

  it('does not prune fresh threads', () => {
    createThread({ title: 'Fresh' });
    const removed = pruneExpiredThreads(24 * 60 * 60 * 1000);
    expect(removed).toBe(0);
    expect(listThreads()).toHaveLength(1);
  });

  it('prunes with default 24h max age', () => {
    createThread({ title: 'Fresh' });
    // Default 24h should not remove a freshly created thread
    const removed = pruneExpiredThreads();
    expect(removed).toBe(0);
  });

  it('returns 0 when no threads exist to prune', () => {
    expect(pruneExpiredThreads()).toBe(0);
  });

  it('handles multiple appends to same thread', () => {
    const t = createThread({ title: 'Multi' });
    for (let i = 0; i < 10; i++) {
      appendMessage(t.id, { kind: 'user_message', threadId: t.id, authorId: `u${i}`, text: `Msg ${i}` });
    }

    const result = getThread(t.id);
    expect(result!.messages).toHaveLength(10);

    // All message IDs should be unique
    const ids = result!.messages.map((m) => m.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(10);
  });

  // --- M2: Path traversal validation tests ---

  it('rejects thread IDs with path traversal (..)', () => {
    expect(() => getThread('../etc/passwd')).toThrow(/Invalid thread ID/);
  });

  it('rejects thread IDs with forward slash', () => {
    expect(() => getThread('CONV-foo/bar')).toThrow(/Invalid thread ID/);
  });

  it('rejects thread IDs with backslash', () => {
    expect(() => getThread('CONV-foo\\bar')).toThrow(/Invalid thread ID/);
  });

  it('rejects thread IDs not matching CONV- pattern', () => {
    expect(() => getThread('INVALID')).toThrow(/Invalid thread ID/);
  });

  it('appendMessage rejects path traversal threadId', () => {
    expect(() =>
      appendMessage('../etc/passwd', { kind: 'user_message', threadId: '../etc/passwd', authorId: 'x', text: 'fail' })
    ).toThrow(/Invalid thread ID/);
  });

  it('archiveThread rejects path traversal threadId', () => {
    expect(() => archiveThread('../etc/passwd')).toThrow(/Invalid thread ID/);
  });

  // --- M1: Secret-scanning tests ---

  it('rejects messages containing Slack tokens', () => {
    const t = createThread({ title: 'Secret Test' });
    expect(() =>
      appendMessage(t.id, { kind: 'user_message', threadId: t.id, authorId: 'u1', text: 'Here is my token: ' + 'xox' + 'b-1234567890-ABCDEFGHIJKLMNOPQRSTUVWX' })
    ).toThrow(/contains.*Slack token/i);
  });

  it('rejects messages containing GitHub tokens in tool_event input', () => {
    const t = createThread({ title: 'Secret Test' });
    expect(() =>
      appendMessage(t.id, { kind: 'tool_event', threadId: t.id, authorId: 'a1', toolName: 'fetch', input: 'ghp_' + 'abcdef1234567890abcdef1234567890abcd' })
    ).toThrow(/contains.*GitHub token/i);
  });

  // --- M3: memoryPolicy functional tests ---

  it('does not persist messages when memoryPolicy is none', () => {
    const t = createThread({ title: 'Ephemeral', memoryPolicy: 'none' });
    const msg = appendMessage(t.id, { kind: 'user_message', threadId: t.id, authorId: 'u1', text: 'Transient' });

    // Message is returned but not persisted to JSONL
    expect(msg.kind).toBe('user_message');
    if (msg.kind === 'user_message') {
      expect(msg.text).toBe('Transient');
    }

    const jsonlPath = join(tmpDir, '.openslack.local', 'conversations', t.id, 'messages.jsonl');
    expect(existsSync(jsonlPath)).toBe(false);
  });

  it('does persist messages when memoryPolicy is local (default)', () => {
    const t = createThread({ title: 'Persisted', memoryPolicy: 'local' });
    appendMessage(t.id, { kind: 'user_message', threadId: t.id, authorId: 'u1', text: 'Sticky' });

    const jsonlPath = join(tmpDir, '.openslack.local', 'conversations', t.id, 'messages.jsonl');
    expect(existsSync(jsonlPath)).toBe(true);
  });

  it('applies longer TTL for project memoryPolicy threads', async () => {
    const t = createThread({ title: 'Project', memoryPolicy: 'project' });
    appendMessage(t.id, { kind: 'user_message', threadId: t.id, authorId: 'u1', text: 'Hi' });

    const metaPath = join(tmpDir, '.openslack.local', 'conversations', t.id, 'thread.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { updatedAt: string };
    meta.updatedAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

    // A 30-second TTL would prune a local thread, but project gets a 7x multiplier.
    const removed = pruneExpiredThreads(30_000);
    expect(removed).toBe(0);
    expect(getThread(t.id)).not.toBeNull();
  });

  it('applies shorter TTL for none memoryPolicy threads', () => {
    const t = createThread({ title: 'None', memoryPolicy: 'none' });
    appendMessage(t.id, { kind: 'user_message', threadId: t.id, authorId: 'u1', text: 'Hi' });

    const metaPath = join(tmpDir, '.openslack.local', 'conversations', t.id, 'thread.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { updatedAt: string };
    meta.updatedAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

    // A 100-second local TTL would keep this thread, but none gets half (50 seconds).
    const removed = pruneExpiredThreads(100_000);
    expect(removed).toBe(1);
    expect(getThread(t.id)).toBeNull();
  });

  // --- R5: memoryPolicy read failure throws ---

  it('throws when thread meta is corrupted during appendMessage', () => {
    const t = createThread({ title: 'Corrupt Test' });
    const metaPath = join(tmpDir, '.openslack.local', 'conversations', t.id, 'thread.json');

    // Corrupt the thread.json file
    writeFileSync(metaPath, '{ invalid json !!!', 'utf-8');

    expect(() =>
      appendMessage(t.id, { kind: 'user_message', threadId: t.id, authorId: 'u1', text: 'fail' })
    ).toThrow(/Failed to read thread metadata/);
  });
});

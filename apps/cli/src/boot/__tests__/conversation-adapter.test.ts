import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { appendMessage, createThread } from '@openslack/collaboration';

import { createCollaborationConversationAdapter } from '../conversation-adapter.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('collaboration conversation adapter', () => {
  it('preserves list, detail, and append behavior within the bound workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-cli-conversation-'));
    roots.push(root);
    const thread = createThread({
      title: 'Composition root',
      participants: [{ id: 'operator', kind: 'agent', displayName: 'Operator' }],
      linkedObjects: [{ kind: 'pr', id: '199' }],
      rootDir: root,
    });
    appendMessage(
      thread.id,
      { kind: 'user_message', threadId: thread.id, authorId: 'human', text: 'Review it' },
      root,
    );
    const adapter = createCollaborationConversationAdapter(root);

    expect(adapter.listThreads({ status: 'active' })).toEqual([
      expect.objectContaining({
        id: thread.id,
        participantCount: 1,
        status: 'active',
      }),
    ]);
    expect(adapter.getThread(thread.id)).toEqual(
      expect.objectContaining({
        participants: ['Operator'],
        linkedObjects: ['pr:199'],
        messages: [expect.stringContaining('Review it')],
      }),
    );
    expect(adapter.appendMessage(thread.id, 'operator', 'Acknowledged')).toEqual({
      messageId: expect.stringMatching(/^MSG-/),
      threadId: thread.id,
    });
    expect(adapter.getThread(thread.id)?.messages).toHaveLength(2);
  });
});

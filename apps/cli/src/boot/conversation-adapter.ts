import {
  appendMessage,
  getThread,
  listThreads,
  renderMessage,
  type ConversationStatus,
} from '@openslack/collaboration';
import type { ConversationListOptions, ConversationStoreAdapter } from '@openslack/operator';

const CONVERSATION_STATUSES = new Set<string>([
  'open',
  'active',
  'paused',
  'completed',
  'archived',
]);

function statusFromOptions(options?: ConversationListOptions): ConversationStatus | undefined {
  const status = options?.status;
  return status && CONVERSATION_STATUSES.has(status) ? (status as ConversationStatus) : undefined;
}

/** Adapt the collaboration store without making Operator depend on that package. */
export function createCollaborationConversationAdapter(
  workspaceRoot: string,
): ConversationStoreAdapter {
  const adapter: ConversationStoreAdapter = {
    listThreads(options) {
      return listThreads({
        ...(statusFromOptions(options) === undefined ? {} : { status: statusFromOptions(options) }),
        rootDir: workspaceRoot,
      }).map((thread) => ({
        id: thread.id,
        title: thread.title,
        status: thread.status,
        participantCount: thread.participants.length,
        lastActivity: thread.updatedAt,
      }));
    },
    getThread(threadId) {
      const result = getThread(threadId, workspaceRoot);
      if (!result) return null;
      return {
        id: result.thread.id,
        title: result.thread.title,
        status: result.thread.status,
        createdAt: result.thread.createdAt,
        updatedAt: result.thread.updatedAt,
        participants: result.thread.participants.map((participant) => participant.displayName),
        linkedObjects: result.thread.linkedObjects.map((object) => `${object.kind}:${object.id}`),
        messages: result.messages.map(renderMessage),
      };
    },
    appendMessage(threadId, authorId, text) {
      const message = appendMessage(
        threadId,
        { kind: 'user_message', threadId, authorId, text },
        workspaceRoot,
      );
      return { messageId: message.id, threadId: message.threadId };
    },
  };
  return Object.freeze(adapter);
}

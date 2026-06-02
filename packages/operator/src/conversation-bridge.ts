/**
 * Conversation bridge for the operator executor.
 *
 * Defines adapter types and functions that the operator can use to interact
 * with conversation threads without a direct dependency on @openslack/collaboration.
 * The actual adapter is wired in at the CLI/app layer.
 */

export interface ConversationListOptions {
  status?: string;
}

export interface ConversationListItem {
  id: string;
  title: string;
  status: string;
  participantCount: number;
  lastActivity: string;
}

export interface ConversationDetailView {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  participants: string[];
  linkedObjects: string[];
  messages: string[];
}

export interface ConversationStoreAdapter {
  listThreads(options?: ConversationListOptions): ConversationListItem[];
  getThread(threadId: string): ConversationDetailView | null;
  appendMessage(threadId: string, authorId: string, text: string): { messageId: string; threadId: string };
}

let storeAdapter: ConversationStoreAdapter | null = null;

export function registerConversationStoreAdapter(adapter: ConversationStoreAdapter): void {
  if (storeAdapter !== null) {
    throw new Error('Conversation store adapter already registered. Call resetConversationStoreAdapter() first (test-only).');
  }
  storeAdapter = adapter;
}

export function resetConversationStoreAdapter(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetConversationStoreAdapter is only available in test environments');
  }
  storeAdapter = null;
}

function getAdapter(): ConversationStoreAdapter {
  if (!storeAdapter) {
    throw new Error('Conversation store adapter not registered. Call registerConversationStoreAdapter first.');
  }
  return storeAdapter;
}

export function listConversationsForOperator(
  options?: ConversationListOptions,
): ConversationListItem[] {
  return getAdapter().listThreads(options);
}

export function showConversationForOperator(
  threadId: string,
): ConversationDetailView | null {
  return getAdapter().getThread(threadId);
}

export function sendConversationMessage(
  threadId: string,
  text: string,
  authorId: string,
): { messageId: string; threadId: string } {
  return getAdapter().appendMessage(threadId, authorId, text);
}

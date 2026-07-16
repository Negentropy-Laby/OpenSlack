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
  appendMessage(
    threadId: string,
    authorId: string,
    text: string,
  ): { messageId: string; threadId: string };
}

/**
 * Instance-scoped binding between Operator conversation actions and a store.
 *
 * A binding may be wired exactly once. Application composition roots should
 * create one binding per host instance so independently composed hosts cannot
 * replace or observe each other's conversation adapters.
 */
export interface ConversationStoreBindingPort {
  bind(adapter: ConversationStoreAdapter): void;
  list(options?: ConversationListOptions): ConversationListItem[];
  show(threadId: string): ConversationDetailView | null;
  send(threadId: string, text: string, authorId: string): { messageId: string; threadId: string };
}

interface ConversationStoreBindingState {
  readonly binding: ConversationStoreBindingPort;
  resetForTests(): void;
}

const ALREADY_REGISTERED_ERROR =
  'Conversation store adapter already registered. Call resetConversationStoreAdapter() first (test-only).';
const NOT_REGISTERED_ERROR =
  'Conversation store adapter not registered. Call registerConversationStoreAdapter first.';
const INSTANCE_ALREADY_BOUND_ERROR =
  'Conversation store binding is already bound. Create a new binding for another adapter.';
const INSTANCE_NOT_BOUND_ERROR =
  'Conversation store binding is not bound. Call bind(adapter) first.';

function createConversationStoreBindingInternal(errors: {
  readonly alreadyBound: string;
  readonly notBound: string;
}): ConversationStoreBindingState {
  let storeAdapter: ConversationStoreAdapter | undefined;
  let isBound = false;

  function getAdapter(): ConversationStoreAdapter {
    if (!isBound || !storeAdapter) {
      throw new Error(errors.notBound);
    }
    return storeAdapter;
  }

  const binding: ConversationStoreBindingPort = Object.freeze({
    bind(adapter: ConversationStoreAdapter): void {
      if (isBound) {
        throw new Error(errors.alreadyBound);
      }
      storeAdapter = adapter;
      isBound = true;
    },
    list(options?: ConversationListOptions): ConversationListItem[] {
      return getAdapter().listThreads(options);
    },
    show(threadId: string): ConversationDetailView | null {
      return getAdapter().getThread(threadId);
    },
    send(
      threadId: string,
      text: string,
      authorId: string,
    ): { messageId: string; threadId: string } {
      return getAdapter().appendMessage(threadId, authorId, text);
    },
  });

  return Object.freeze({
    binding,
    resetForTests(): void {
      storeAdapter = undefined;
      isBound = false;
    },
  });
}

/** Create an isolated, single-bind conversation-store port. */
export function createConversationStoreBinding(): ConversationStoreBindingPort {
  return createConversationStoreBindingInternal({
    alreadyBound: INSTANCE_ALREADY_BOUND_ERROR,
    notBound: INSTANCE_NOT_BOUND_ERROR,
  }).binding;
}

const defaultConversationStoreBindingState = createConversationStoreBindingInternal({
  alreadyBound: ALREADY_REGISTERED_ERROR,
  notBound: NOT_REGISTERED_ERROR,
});
const defaultConversationStoreBinding = defaultConversationStoreBindingState.binding;

export function registerConversationStoreAdapter(adapter: ConversationStoreAdapter): void {
  defaultConversationStoreBinding.bind(adapter);
}

export function resetConversationStoreAdapter(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetConversationStoreAdapter is only available in test environments');
  }
  defaultConversationStoreBindingState.resetForTests();
}

export function listConversationsForOperator(
  options?: ConversationListOptions,
): ConversationListItem[] {
  return defaultConversationStoreBinding.list(options);
}

export function showConversationForOperator(threadId: string): ConversationDetailView | null {
  return defaultConversationStoreBinding.show(threadId);
}

export function sendConversationMessage(
  threadId: string,
  text: string,
  authorId: string,
): { messageId: string; threadId: string } {
  return defaultConversationStoreBinding.send(threadId, text, authorId);
}

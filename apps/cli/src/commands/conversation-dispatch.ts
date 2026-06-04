import {
  appendMessage,
  createThread,
  getThread,
  linkRunToThread,
  listThreads,
} from '@openslack/collaboration';

export const WORKBENCH_THREAD_TITLE = 'OpenSlack Workbench Session';

export function findOrCreateWorkbenchThread(rootDir: string) {
  const existing = listThreads({ rootDir }).find(
    (thread) =>
      thread.title === WORKBENCH_THREAD_TITLE &&
      (thread.status === 'open' || thread.status === 'active'),
  );
  if (existing) return existing;

  return createThread({
    title: WORKBENCH_THREAD_TITLE,
    participants: [
      { id: 'tui-user', kind: 'human', displayName: 'TUI User', provider: 'openslack' },
      { id: 'openslack', kind: 'system', displayName: 'OpenSlack', provider: 'openslack' },
    ],
    memoryPolicy: 'local',
    rootDir,
  });
}

export function resolveWorkbenchThread(threadId: string | undefined, rootDir: string) {
  if (threadId) {
    const existing = getThread(threadId, rootDir);
    if (existing) return existing.thread;
  }
  return findOrCreateWorkbenchThread(rootDir);
}

export async function dispatchConversationAgentMessage(input: {
  rootDir: string;
  threadId: string;
  authorId: string;
  agentId: string;
  prompt: string;
  originalText?: string;
}): Promise<{ dispatched: boolean; runId?: string; responseText: string }> {
  const { rootDir, threadId, authorId, agentId, prompt } = input;
  const originalText = input.originalText ?? `@${agentId} ${prompt}`;

  const { resolveAgentType } = await import('@openslack/workflows');
  const resolvedConfig = resolveAgentType(agentId, rootDir);
  if (!resolvedConfig) {
    appendMessage(
      threadId,
      {
        kind: 'user_message',
        threadId,
        authorId,
        text: originalText,
      },
      rootDir,
    );
    return {
      dispatched: false,
      responseText: `Agent "${agentId}" not found. Message sent as plain text.`,
    };
  }

  appendMessage(
    threadId,
    {
      kind: 'user_message',
      threadId,
      authorId,
      text: originalText,
    },
    rootDir,
  );

  const { createOpenSlackAgentLauncher, createRunStore } = await import('@openslack/agent-runtime');
  const store = createRunStore(rootDir);
  const launcher = createOpenSlackAgentLauncher({ runStore: store, rootDir });

  const runResult = await launcher(prompt, {
    label: agentId,
    phase: 'conversation',
    agentType: agentId,
    resolvedAgentConfig: resolvedConfig,
    correlationId: threadId,
    threadId,
  });

  const responseText =
    typeof runResult.data === 'string'
      ? runResult.data
      : JSON.stringify(runResult.data, null, 2);

  appendMessage(
    threadId,
    {
      kind: 'agent_response',
      threadId,
      authorId: agentId,
      text: responseText,
      structured: runResult.data,
      runId: runResult.runId,
    },
    rootDir,
  );

  linkRunToThread(threadId, runResult.runId, rootDir);

  return {
    dispatched: true,
    runId: runResult.runId,
    responseText,
  };
}

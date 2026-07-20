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
}): Promise<{
  dispatched: boolean;
  runId?: string;
  failureCode?: 'RUNTIME_NOT_CONFIGURED' | 'RUNTIME_MISCONFIGURED';
  responseText: string;
}> {
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

  let runResult;
  try {
    runResult = await launcher(prompt, {
      label: agentId,
      phase: 'conversation',
      agentType: agentId,
      resolvedAgentConfig: resolvedConfig,
      correlationId: threadId,
      threadId,
    });
  } catch (error) {
    const code = readRuntimeFailureCode(error);
    if (!code) throw error;

    const runId = readRunId(error);
    if (runId) linkRunToThread(threadId, runId, rootDir);
    return {
      dispatched: false,
      runId,
      failureCode: code,
      responseText: `[${code}] ${safeRuntimeFailureMessage(code)}`,
    };
  }

  const responseText =
    typeof runResult.data === 'string' ? runResult.data : JSON.stringify(runResult.data, null, 2);

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

function safeRuntimeFailureMessage(
  code: 'RUNTIME_NOT_CONFIGURED' | 'RUNTIME_MISCONFIGURED',
): string {
  return code === 'RUNTIME_NOT_CONFIGURED'
    ? 'Agent runtime is not configured. Configure an execution provider before retrying.'
    : 'Agent runtime configuration is invalid. Run openslack agent-runtime doctor for details.';
}

function readRuntimeFailureCode(
  error: unknown,
): 'RUNTIME_NOT_CONFIGURED' | 'RUNTIME_MISCONFIGURED' | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return code === 'RUNTIME_NOT_CONFIGURED' || code === 'RUNTIME_MISCONFIGURED' ? code : undefined;
}

function readRunId(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const runId = (error as { runId?: unknown }).runId;
  return typeof runId === 'string' ? runId : undefined;
}

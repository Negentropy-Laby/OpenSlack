import { describe, expect, it } from 'vitest';

import {
  REGISTERED_ACTION_IDS,
  type ConversationStoreAdapter,
  type LLMPlannerProvider,
} from '@openslack/operator';

import { createOpenSlackCliContext } from '../context.js';

function conversationAdapter(id: string): ConversationStoreAdapter {
  return {
    listThreads: () => [
      {
        id,
        title: id,
        status: 'open',
        participantCount: 0,
        lastActivity: '2026-07-16T00:00:00.000Z',
      },
    ],
    getThread: () => null,
    appendMessage: (threadId) => ({ messageId: `${id}-message`, threadId }),
  };
}

function plannerProvider(id: string): LLMPlannerProvider {
  return {
    id,
    classifyAndPlan: async () => ({
      intent: { kind: 'status', slots: {}, confidence: 1 },
    }),
  };
}

describe('OpenSlack CLI composition context', () => {
  it('seeds the exact built-in action order into an isolated sealed host graph', () => {
    const context = createOpenSlackCliContext({
      workspaceRoot: '.',
      openslackVersion: '0.1.1',
      conversationStoreAdapter: conversationAdapter('CONV-A'),
    });

    expect(context.operator.actionRegistry.list().map((action) => action.id)).toEqual(
      REGISTERED_ACTION_IDS,
    );
    expect(context.operator.actionRegistry.list()).toHaveLength(30);
    expect(context.pluginHost.snapshot()).toMatchObject({
      bound: true,
      sealed: true,
      registryRevision: 0,
      plugins: [],
    });
  });

  it('does not leak provider or conversation registrations across two contexts', () => {
    const contextA = createOpenSlackCliContext({
      workspaceRoot: '.',
      openslackVersion: '0.1.1',
      conversationStoreAdapter: conversationAdapter('CONV-A'),
    });
    const contextB = createOpenSlackCliContext({
      workspaceRoot: '.',
      openslackVersion: '0.1.1',
      conversationStoreAdapter: conversationAdapter('CONV-B'),
    });

    contextA.operator.llmProviderRegistry.register(plannerProvider('context-only'));

    expect(contextA.pluginHost).not.toBe(contextB.pluginHost);
    expect(contextA.pluginActions).not.toBe(contextB.pluginActions);
    expect(contextA.operator.actionRegistry).not.toBe(contextB.operator.actionRegistry);
    expect(contextA.operator.llmProviderRegistry.get('context-only')).toBeDefined();
    expect(contextB.operator.llmProviderRegistry.get('context-only')).toBeUndefined();
    expect(contextA.operator.conversationStore.list()[0]?.id).toBe('CONV-A');
    expect(contextB.operator.conversationStore.list()[0]?.id).toBe('CONV-B');
  });
});

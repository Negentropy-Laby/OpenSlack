import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  LLM_PLANNER_MAX_REPLANS,
  LLM_PLANNER_MAX_RETRIES,
  LLM_PLANNER_MAX_TOOL_STEPS,
  createOpenAICompatiblePlannerProvider,
  resolveIntent,
  clearLLMPlannerProviders,
  createActionRegistry,
  getLLMPlannerProvider,
  getRegisteredAction,
  registerLLMPlannerProvider,
  type LLMPlannerProvider,
} from '../index.js';
import { createLLMPlannerProviderRegistry, getConfiguredLLMPlannerProvider } from '../llm.js';

afterEach(() => {
  vi.unstubAllGlobals();
  clearLLMPlannerProviders();
});

describe('resolveIntent', () => {
  it('calls LLM and returns LLM result for high-confidence known intents', async () => {
    let called = false;
    const provider: LLMPlannerProvider = {
      id: 'test',
      async classifyAndPlan() {
        called = true;
        return { intent: { kind: 'doctor', slots: {}, confidence: 1 } };
      },
    };

    const result = await resolveIntent('check status', { provider });

    expect(result.intent.kind).toBe('doctor');
    expect(result.source).toBe('llm');
    expect(called).toBe(true);
  });

  it('uses LLM fallback for unknown requests and returns typed intents only', async () => {
    const provider: LLMPlannerProvider = {
      id: 'test',
      async classifyAndPlan() {
        return { intent: { kind: 'pr_doctor', slots: { prNumber: 42 }, confidence: 0.9 } };
      },
    };

    const result = await resolveIntent('why is the release blocked?', { provider });

    expect(result.intent.kind).toBe('pr_doctor');
    expect(result.intent.slots.prNumber).toBe(42);
    expect(result.source).toBe('llm');
  });

  it('falls back to unknown when provider returns an invalid raw command shape', async () => {
    const provider: LLMPlannerProvider = {
      id: 'test',
      async classifyAndPlan() {
        return {
          intent: { kind: 'shell.run', slots: { command: 'rm -rf .' }, confidence: 1 } as never,
        };
      },
    };

    const result = await resolveIntent('delete everything', { provider });

    expect(result.intent.kind).toBe('unknown');
    expect(result.source).toBe('keyword-fallback');
  });

  it('exports bounded planner limits', () => {
    expect(LLM_PLANNER_MAX_TOOL_STEPS).toBe(6);
    expect(LLM_PLANNER_MAX_REPLANS).toBe(2);
    expect(LLM_PLANNER_MAX_RETRIES).toBe(1);
  });

  it('uses the 30 built-in actions in request order by default', async () => {
    let actionIds: string[] = [];
    const provider: LLMPlannerProvider = {
      id: 'capture-builtins',
      async classifyAndPlan(request) {
        actionIds = request.actions.map((action) => action.id);
        return { intent: { kind: 'status', slots: {}, confidence: 1 } };
      },
    };

    await resolveIntent('check status', { provider });

    expect(actionIds).toHaveLength(30);
    expect(actionIds[0]).toBe('status.show');
    expect(actionIds.at(-1)).toBe('conversation.archive');
  });

  it('sends a parseable JSON example without trailing commas in the system prompt', async () => {
    let systemPrompt = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: unknown) => {
        const bodyText = (init as { body?: unknown }).body;
        expect(typeof bodyText).toBe('string');
        const requestBody = JSON.parse(bodyText as string) as {
          messages: Array<{ role: string; content: string }>;
        };
        systemPrompt =
          requestBody.messages.find((message) => message.role === 'system')?.content ?? '';
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    intent: { kind: 'status', slots: {}, confidence: 0.9 },
                  }),
                },
              },
            ],
          }),
        );
      }),
    );
    const provider = createOpenAICompatiblePlannerProvider({
      id: 'openai-compatible',
      apiKey: 'sk-test',
      model: 'gpt-test',
    });

    const result = await provider.classifyAndPlan({
      query: 'check status',
      maxToolSteps: 1,
      maxReplans: 0,
      actions: [
        {
          id: 'plugin:fixture:inspect',
          description: 'Inspect fixture state',
          inputSchema: {},
        },
      ],
    });

    const example = systemPrompt.match(
      /Return JSON matching this structure:\n([\s\S]*?)\n\nSupport both/,
    )?.[1];
    expect(result.intent?.kind).toBe('status');
    expect(example).toBeDefined();
    expect(() => JSON.parse(example ?? '')).not.toThrow();
    expect(example).not.toContain('"confidence": 0.9,');
    expect(systemPrompt).toContain('plugin:fixture:inspect: Inspect fixture state');
    expect(systemPrompt).not.toContain('status.show: Show product dashboard');
  });
});

describe('LLM planner provider registries', () => {
  it('isolates two instances and preserves Map.set replacement semantics', () => {
    const first = createLLMPlannerProviderRegistry();
    const second = createLLMPlannerProviderRegistry();
    const original: LLMPlannerProvider = {
      id: 'local',
      async classifyAndPlan() {
        return { intent: { kind: 'status', slots: {}, confidence: 1 } };
      },
    };
    const replacement: LLMPlannerProvider = {
      id: 'local',
      async classifyAndPlan() {
        return { intent: { kind: 'doctor', slots: {}, confidence: 1 } };
      },
    };

    first.register(original);
    expect(first.get('local')).toBe(original);
    expect(second.get('local')).toBeUndefined();

    first.register(replacement);
    expect(first.get('local')).toBe(replacement);
    expect(second.get('local')).toBeUndefined();

    second.register(original);
    first.clear();
    expect(first.get('local')).toBeUndefined();
    expect(second.get('local')).toBe(original);
  });

  it('keeps the legacy registration API on an overwrite-compatible default registry', () => {
    const original: LLMPlannerProvider = {
      id: 'legacy',
      async classifyAndPlan() {
        return { intent: { kind: 'status', slots: {}, confidence: 1 } };
      },
    };
    const replacement: LLMPlannerProvider = {
      id: 'legacy',
      async classifyAndPlan() {
        return { intent: { kind: 'doctor', slots: {}, confidence: 1 } };
      },
    };

    registerLLMPlannerProvider(original);
    expect(getLLMPlannerProvider('legacy')).toBe(original);
    registerLLMPlannerProvider(replacement);
    expect(getLLMPlannerProvider('legacy')).toBe(replacement);
    clearLLMPlannerProviders();
    expect(getLLMPlannerProvider('legacy')).toBeUndefined();
  });

  it('resolves a configured provider and actions from explicit isolated registries', async () => {
    const savedProvider = process.env.OPENSLACK_LLM_PROVIDER;
    const providerRegistry = createLLMPlannerProviderRegistry();
    const statusAction = getRegisteredAction('status.show');
    expect(statusAction).toBeDefined();
    const actionRegistry = createActionRegistry([statusAction!]);
    let actionIds: string[] = [];
    const isolatedProvider: LLMPlannerProvider = {
      id: 'isolated',
      async classifyAndPlan(request) {
        actionIds = request.actions.map((action) => action.id);
        return { intent: { kind: 'status', slots: {}, confidence: 1 } };
      },
    };
    providerRegistry.register(isolatedProvider);
    process.env.OPENSLACK_LLM_PROVIDER = 'isolated';

    try {
      expect(getConfiguredLLMPlannerProvider(providerRegistry)).toBe(isolatedProvider);
      const result = await resolveIntent('check status', {
        providerRegistry,
        actionRegistry,
      });

      expect(result.source).toBe('llm');
      expect(actionIds).toEqual(['status.show']);
    } finally {
      if (savedProvider === undefined) delete process.env.OPENSLACK_LLM_PROVIDER;
      else process.env.OPENSLACK_LLM_PROVIDER = savedProvider;
    }
  });
});

describe('resolveIntent LLM-first mode', () => {
  it('uses LLM result even when keyword router has high confidence', async () => {
    const provider: LLMPlannerProvider = {
      id: 'test-llm-wins',
      async classifyAndPlan() {
        return { intent: { kind: 'doctor', slots: { scope: 'llm-derived' }, confidence: 0.95 } };
      },
    };

    const result = await resolveIntent('check status', { provider });

    expect(result.source).toBe('llm');
    expect(result.intent.kind).toBe('doctor');
  });

  it('falls back to keyword when LLM provider throws', async () => {
    const provider: LLMPlannerProvider = {
      id: 'test-llm-throws',
      async classifyAndPlan() {
        throw new Error('network timeout');
      },
    };

    const result = await resolveIntent('check status', { provider });

    expect(result.source).toBe('keyword-fallback');
    expect(result.intent.kind).toBe('status');
    expect(result.fallbackReason).toContain('LLM unavailable');
  });

  it('falls back when LLM returns invalid intent kind', async () => {
    const provider: LLMPlannerProvider = {
      id: 'test-llm-invalid',
      async classifyAndPlan() {
        return { intent: { kind: 'shell.run', slots: {}, confidence: 0.9 } as never };
      },
    };

    const result = await resolveIntent('check status', { provider });

    expect(result.source).toBe('keyword-fallback');
    expect(result.intent.kind).toBe('status');
  });

  it('falls back when LLM returns unknown for a keyword-recognized request', async () => {
    const provider: LLMPlannerProvider = {
      id: 'test-llm-unknown',
      async classifyAndPlan() {
        return { intent: { kind: 'unknown', slots: { query: 'unclear' }, confidence: 0.8 } };
      },
    };

    const result = await resolveIntent('这个仓库现在最值得先检查哪一块', { provider });

    expect(result.source).toBe('keyword-fallback');
    expect(result.intent.kind).toBe('doctor');
    expect(result.intent.slots.scope).toBe('recommendation');
  });

  it('merges deterministic slots from keyword parser into LLM result', async () => {
    const provider: LLMPlannerProvider = {
      id: 'test-llm-slot-merge',
      async classifyAndPlan() {
        return { intent: { kind: 'pr_merge', slots: {}, confidence: 0.9 } };
      },
    };

    const result = await resolveIntent('merge PR #166', { provider });

    expect(result.source).toBe('llm');
    expect(result.intent.slots.prNumber).toBe(166);
  });

  it('returns keyword source when no provider configured', async () => {
    const savedProvider = process.env.OPENSLACK_LLM_PROVIDER;
    delete process.env.OPENSLACK_LLM_PROVIDER;
    clearLLMPlannerProviders();

    try {
      const result = await resolveIntent('check status');

      expect(result.source).toBe('keyword');
      expect(result.intent.kind).toBe('status');
    } finally {
      if (savedProvider !== undefined) {
        process.env.OPENSLACK_LLM_PROVIDER = savedProvider;
      }
    }
  });
});

import { describe, expect, it, afterEach, vi } from 'vitest';
import { buildTuiAskPlan } from '../tui-ask.js';
import {
  registerLLMPlannerProvider,
  clearLLMPlannerProviders,
  createLLMPlannerProviderRegistry,
} from '../llm.js';
import { BUILTIN_ACTION_REGISTRY } from '../tool-registry.js';
import type { ActionRegistryPort } from '../tool-registry.js';

describe('buildTuiAskPlan', () => {
  it('maps broad PR checks to a PR queue route card', async () => {
    const result = await buildTuiAskPlan('检查 PR');

    expect(result.plan.intent.kind).toBe('pr_queue');
    expect(result.cards).toContainEqual(expect.objectContaining({
      label: 'Open PR Queue',
      kind: 'route',
      route: 'pr-queue',
    }));
  });

  it('maps workflow-shaped prompts to draft-first workflow cards', async () => {
    const result = await buildTuiAskPlan('use a workflow to audit every API endpoint');

    expect(result.plan.intent.kind).toBe('workflow_recommended');
    expect(result.cards[0]).toEqual(expect.objectContaining({
      label: 'Generate Draft',
      kind: 'workflow_draft',
      confirmationRequired: false,
    }));
    expect(result.cards).toContainEqual(expect.objectContaining({
      label: 'Preview Draft',
      command: 'openslack collaboration workflow preview-draft <draftId>',
      detail: expect.stringContaining('Replace <draftId>'),
    }));
    expect(result.cards).toContainEqual(expect.objectContaining({
      label: 'Run after approval',
      confirmationRequired: true,
      detail: expect.stringContaining('Replace <workflow-file>'),
    }));
  });

  it('keeps small status prompts on the direct status route', async () => {
    const result = await buildTuiAskPlan('check status');

    expect(result.plan.intent.kind).toBe('status');
    expect(result.cards).toContainEqual(expect.objectContaining({
      label: 'Open Status',
      kind: 'route',
      route: 'status',
    }));
  });

  it('maps profile sync prompts to profile sync route cards', async () => {
    const result = await buildTuiAskPlan('检查 GitHub 主页是否需要更新');

    expect(result.plan.intent.kind).toBe('profile_sync');
    expect(result.cards).toContainEqual(expect.objectContaining({
      label: 'Check Profile Sync',
      route: 'profile',
    }));
    expect(result.cards).toContainEqual(expect.objectContaining({
      label: 'Create Profile Sync PR',
      confirmationRequired: true,
    }));
  });
});

describe('buildTuiAskPlan LLM integration', () => {
  afterEach(() => {
    clearLLMPlannerProviders();
    delete process.env.OPENSLACK_LLM_PROVIDER;
  });

  it('uses LLM intent when provider is configured', async () => {
    registerLLMPlannerProvider({
      id: 'test-mock',
      async classifyAndPlan() {
        return {
          intent: { kind: 'doctor', slots: {}, confidence: 0.9 },
        };
      },
    });
    process.env.OPENSLACK_LLM_PROVIDER = 'test-mock';

    const plan = await buildTuiAskPlan('run diagnostics');

    expect(plan.llmSource).toBe('llm');
    expect(plan.plan.intent.kind).toBe('doctor');
  });

  it('includes fallbackReason when LLM fails', async () => {
    registerLLMPlannerProvider({
      id: 'test-fail',
      async classifyAndPlan() {
        throw new Error('timeout');
      },
    });
    process.env.OPENSLACK_LLM_PROVIDER = 'test-fail';

    const plan = await buildTuiAskPlan('check status');

    expect(plan.fallbackReason).toBeTruthy();
    expect(plan.fallbackReason).toContain('LLM');
    expect(plan.cards.length).toBeGreaterThan(0);
  });

  it('uses only the explicitly supplied provider and action registries', async () => {
    registerLLMPlannerProvider({
      id: 'isolated-tui',
      async classifyAndPlan() {
        return { intent: { kind: 'doctor', slots: {}, confidence: 1 } };
      },
    });
    const providers = createLLMPlannerProviderRegistry([
      {
        id: 'isolated-tui',
        async classifyAndPlan() {
          return { intent: { kind: 'status', slots: {}, confidence: 1 } };
        },
      },
    ]);
    const createStep = vi.fn((...args: Parameters<ActionRegistryPort['createStep']>) =>
      BUILTIN_ACTION_REGISTRY.createStep(...args),
    );
    const actions = {
      list: () => BUILTIN_ACTION_REGISTRY.list(),
      get: (actionId: string) => BUILTIN_ACTION_REGISTRY.get(actionId),
      createStep,
      revalidateStep: (value: unknown) => BUILTIN_ACTION_REGISTRY.revalidateStep(value),
      buildPlanSteps: (...args: Parameters<ActionRegistryPort['buildPlanSteps']>) =>
        BUILTIN_ACTION_REGISTRY.buildPlanSteps(...args),
    } satisfies ActionRegistryPort;
    process.env.OPENSLACK_LLM_PROVIDER = 'isolated-tui';

    const plan = await buildTuiAskPlan('route through the isolated graph', {
      actionRegistry: actions,
      llmProviderRegistry: providers,
    });

    expect(plan.llmSource).toBe('llm');
    expect(plan.plan.intent.kind).toBe('status');
    expect(createStep).toHaveBeenCalledWith('status.show', {}, 's1');
  });
});

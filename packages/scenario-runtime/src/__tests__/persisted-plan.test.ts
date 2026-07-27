import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createPreviewedScenarioInstance,
  createSoftwareDeliveryScenarioCatalog,
  loadScenarioPack,
  normalizeScenarioPlanInput,
  previewScenario,
  rehydrateScenarioInstantiationPlan,
} from '../index.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');

async function plan() {
  const catalog = createSoftwareDeliveryScenarioCatalog();
  const definition = await loadScenarioPack({
    scenarioRoot: resolve(repositoryRoot, 'scenarios'),
    scenarioId: 'software-delivery',
    catalog,
  });
  return previewScenario({
    definition,
    catalog,
    input: {
      objective: 'Explain governed delivery state.',
      constraints: ['read-only', 'evidence-required'],
    },
    targetRefs: [
      {
        provider: 'github',
        objectType: 'repository',
        objectId: 'acme/project',
        version: 'head:abc123',
        observedAt: '2026-07-27T00:00:00.000Z',
      },
    ],
    actor: { id: 'human-reviewer', permissions: {} },
    workspaceId: 'workspace-main',
    correlationId: 'correlation-001',
    createdAt: '2026-07-27T00:00:00.000Z',
    expiresAt: '2026-07-27T00:15:00.000Z',
  });
}

function binding(value: Awaited<ReturnType<typeof plan>>) {
  return {
    planHash: value.planHash,
    actorId: value.actorId,
    workspaceId: value.workspaceId,
    correlationId: value.correlationId,
    definitionHash: value.definitionHash,
    now: '2026-07-27T00:05:00.000Z',
  } as const;
}

describe('persisted Scenario plan', () => {
  it('round-trips JSON into a newly sealed immutable plan', async () => {
    const original = await plan();
    const restored = rehydrateScenarioInstantiationPlan(
      JSON.parse(JSON.stringify(original)),
      binding(original),
    );

    expect(restored).toEqual(original);
    expect(restored).not.toBe(original);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(restored.normalizedInput)).toBe(true);
    expect(createPreviewedScenarioInstance(restored).planHash).toBe(original.planHash);
  });

  it.each([
    ['actorId', 'different-actor'],
    ['workspaceId', 'different-workspace'],
    ['correlationId', 'different-correlation'],
    ['definitionHash', 'f'.repeat(64)],
    ['planHash', 'e'.repeat(64)],
  ] as const)('rejects a mismatched host-owned %s binding', async (field, value) => {
    const original = await plan();
    expect(() =>
      rehydrateScenarioInstantiationPlan(JSON.parse(JSON.stringify(original)), {
        ...binding(original),
        [field]: value,
      }),
    ).toThrowError(expect.objectContaining({ code: 'SCENARIO_PERSISTED_PLAN_BINDING_MISMATCH' }));
  });

  it('rejects expired, mutated, and open-shaped persisted plans', async () => {
    const original = await plan();
    const mutatedInput = JSON.parse(JSON.stringify(original));
    mutatedInput.normalizedInput.objective = 'Mutated after preview.';
    expect(() => rehydrateScenarioInstantiationPlan(mutatedInput, binding(original))).toThrowError(
      expect.objectContaining({ code: 'SCENARIO_PERSISTED_PLAN_INVALID' }),
    );

    const openShape = { ...JSON.parse(JSON.stringify(original)), allowUnattended: true };
    expect(() => rehydrateScenarioInstantiationPlan(openShape, binding(original))).toThrowError(
      expect.objectContaining({ code: 'SCENARIO_PERSISTED_PLAN_INVALID' }),
    );

    expect(() =>
      rehydrateScenarioInstantiationPlan(JSON.parse(JSON.stringify(original)), {
        ...binding(original),
        now: original.expiresAt,
      }),
    ).toThrowError(expect.objectContaining({ code: 'SCENARIO_PREVIEW_EXPIRED' }));
  });

  it('rejects nested proxies and accessors without invoking their traps', async () => {
    const original = await plan();
    const persisted = JSON.parse(JSON.stringify(original));
    let traps = 0;
    persisted.normalizedInput = new Proxy(
      {},
      {
        getPrototypeOf() {
          traps += 1;
          return Object.prototype;
        },
        ownKeys() {
          traps += 1;
          return [];
        },
      },
    );
    expect(() => rehydrateScenarioInstantiationPlan(persisted, binding(original))).toThrowError(
      expect.objectContaining({ code: 'SCENARIO_PREVIEW_INPUT_INVALID' }),
    );
    expect(traps).toBe(0);

    let getters = 0;
    const input = {};
    Object.defineProperty(input, 'objective', {
      enumerable: true,
      get() {
        getters += 1;
        return 'hidden';
      },
    });
    expect(() => normalizeScenarioPlanInput(input)).toThrowError(
      expect.objectContaining({ code: 'SCENARIO_PREVIEW_INPUT_INVALID' }),
    );
    expect(getters).toBe(0);
  });

  it.each([
    { allowUnattended: true },
    { confirmStep: true },
    { workflowPath: './dynamic.mjs' },
    { repository: 'acme/implicit' },
    { nested: { githubToken: 'not-a-real-token' } },
  ])('does not carry host-owned execution or authority fields in normalized input', (input) => {
    expect(() => normalizeScenarioPlanInput(input)).toThrowError(
      expect.objectContaining({ code: 'SCENARIO_PREVIEW_INPUT_INVALID' }),
    );
  });
});

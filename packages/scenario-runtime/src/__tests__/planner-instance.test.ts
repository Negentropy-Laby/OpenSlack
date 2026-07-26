import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AuthorityRef } from '@openslack/organization-graph';
import {
  createPreviewedScenarioInstance,
  createSoftwareDeliveryScenarioCatalog,
  loadScenarioPack,
  previewScenario,
  transitionScenarioInstance,
  validateScenarioInstance,
} from '../index.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');
const scenarioRoot = resolve(repositoryRoot, 'scenarios');

function target(objectId: string, observedAt: string): AuthorityRef {
  return {
    provider: 'github',
    objectType: 'repository',
    objectId,
    version: 'head:abc123',
    observedAt,
  };
}

async function context(
  targetRefs: readonly AuthorityRef[] = [target('acme/project', '2026-07-27T00:00:00.000Z')],
) {
  const catalog = createSoftwareDeliveryScenarioCatalog();
  const definition = await loadScenarioPack({
    scenarioRoot,
    scenarioId: 'software-delivery',
    catalog,
  });
  return {
    definition,
    catalog,
    input: { objective: 'Explain governed delivery state.' },
    targetRefs,
    actor: { id: 'human-reviewer', permissions: {} },
    workspaceId: 'workspace-main',
    correlationId: 'correlation-001',
    createdAt: '2026-07-27T00:00:00.000Z',
    expiresAt: '2026-07-27T00:15:00.000Z',
  } as const;
}

describe('Scenario preview and instance contract', () => {
  it('produces an immutable read-only plan and a valid previewed instance', async () => {
    const plan = previewScenario(await context());
    expect(plan.effects).toEqual([]);
    expect(plan.capabilities).toEqual([]);
    expect(plan.planId).toBe(`scenario-plan:sha256:${plan.planHash}`);
    expect(Object.isFrozen(plan)).toBe(true);
    const instance = createPreviewedScenarioInstance(plan);
    expect(instance.state).toBe('previewed');
    expect(instance.correlationId).toBe(plan.correlationId);
    expect(validateScenarioInstance(instance)).toEqual(instance);
  });

  it('uses canonical target identity/version scope independent of order and observation time', async () => {
    const first = previewScenario(
      await context([
        target('acme/a', '2026-07-27T00:00:00.000Z'),
        target('acme/b', '2026-07-27T00:01:00.000Z'),
      ]),
    );
    const second = previewScenario(
      await context([
        target('acme/b', '2026-07-27T00:03:00.000Z'),
        target('acme/a', '2026-07-27T00:02:00.000Z'),
      ]),
    );
    expect(first.targetScopeHash).toBe(second.targetScopeHash);
    expect(first.scenarioInstanceId).toBe(second.scenarioInstanceId);
    expect(first.planHash).not.toBe(second.planHash);
  });

  it('rejects duplicate or conflicting target identities', async () => {
    await expect(
      Promise.resolve().then(async () =>
        previewScenario(
          await context([
            target('acme/a', '2026-07-27T00:00:00.000Z'),
            target('acme/a', '2026-07-27T00:01:00.000Z'),
          ]),
        ),
      ),
    ).rejects.toMatchObject({ code: 'SCENARIO_PREVIEW_SCOPE_INVALID' });
    await expect(
      Promise.resolve().then(async () => {
        const second = { ...target('acme/a', '2026-07-27T00:01:00.000Z'), version: 'head:def456' };
        return previewScenario(
          await context([target('acme/a', '2026-07-27T00:00:00.000Z'), second]),
        );
      }),
    ).rejects.toMatchObject({ code: 'SCENARIO_PREVIEW_SCOPE_INVALID' });
  });

  it.each([
    { field: 'objectId', value: 'https://evil.example/\u0000' },
    { field: 'objectId', value: 'repository-\ud800' },
    { field: 'version', value: 'javascript:alert(1)' },
    { field: 'version', value: 'https://evil.example/revision' },
  ] as const)('rejects unsafe authority $field references', async ({ field, value }) => {
    const unsafe = { ...target('acme/project', '2026-07-27T00:00:00.000Z'), [field]: value };
    await expect(
      Promise.resolve().then(async () => previewScenario(await context([unsafe]))),
    ).rejects.toMatchObject({ code: 'SCENARIO_INSTANCE_INVALID' });
  });

  it('rejects forged definitions and plans by nominal host brand', async () => {
    const valid = await context();
    expect(() =>
      previewScenario({
        ...valid,
        definition: { ...valid.definition } as never,
      }),
    ).toThrowError(expect.objectContaining({ code: 'SCENARIO_PACK_POLICY_DENIED' }));
    const plan = previewScenario(valid);
    expect(() => createPreviewedScenarioInstance({ ...plan })).toThrowError(
      expect.objectContaining({ code: 'SCENARIO_PREVIEW_INPUT_INVALID' }),
    );
  });

  it('rejects accessor preview input without invoking it', async () => {
    let invoked = false;
    const input = {};
    Object.defineProperty(input, 'objective', {
      enumerable: true,
      get() {
        invoked = true;
        return 'secret';
      },
    });
    const valid = await context();
    expect(() => previewScenario({ ...valid, input })).toThrowError(
      expect.objectContaining({ code: 'SCENARIO_PREVIEW_INPUT_INVALID' }),
    );
    expect(invoked).toBe(false);
  });

  it('enforces closed instance fields, temporal order, and lifecycle transitions', async () => {
    const instance = createPreviewedScenarioInstance(previewScenario(await context()));
    expect(() => validateScenarioInstance({ ...instance, extra: true })).toThrowError(
      expect.objectContaining({ code: 'SCENARIO_INSTANCE_INVALID' }),
    );
    expect(() =>
      validateScenarioInstance({
        ...instance,
        updatedAt: '2026-07-26T23:59:59.000Z',
      }),
    ).toThrowError(expect.objectContaining({ code: 'SCENARIO_INSTANCE_INVALID' }));
    expect(() =>
      transitionScenarioInstance(instance, {
        state: 'completed',
        updatedAt: '2026-07-27T00:01:00.000Z',
        evidenceRefs: ['evidence:premature'],
      }),
    ).toThrowError(expect.objectContaining({ code: 'SCENARIO_INSTANCE_TRANSITION_DENIED' }));
    const instantiating = transitionScenarioInstance(instance, {
      state: 'instantiating',
      updatedAt: '2026-07-27T00:01:00.000Z',
      evidenceRefs: ['evidence:started'],
    });
    expect(instantiating.state).toBe('instantiating');
  });
});

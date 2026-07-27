import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SOFTWARE_DELIVERY_PROJECTOR_CONTRACT,
  SOFTWARE_DELIVERY_PROJECTOR_ID,
  type AuthorityRef,
} from '@openslack/organization-graph';
import {
  createPreviewedScenarioInstance,
  createSoftwareDeliveryScenarioCatalog,
  loadScenarioPack,
  previewScenario,
  sealScenarioHostCatalog,
  transitionScenarioInstance,
  validateScenarioInstance,
} from '../index.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');
const scenarioRoot = resolve(repositoryRoot, 'scenarios');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function workflowCatalog(includeWorkflow: boolean) {
  return sealScenarioHostCatalog({
    projectors: [
      {
        id: SOFTWARE_DELIVERY_PROJECTOR_ID,
        version: '1.0.0',
        adapterId: SOFTWARE_DELIVERY_PROJECTOR_ID,
        nodeTypes: SOFTWARE_DELIVERY_PROJECTOR_CONTRACT.nodeTypes,
        edgeTypes: SOFTWARE_DELIVERY_PROJECTOR_CONTRACT.edgeTypes,
      },
    ],
    workflows: includeWorkflow
      ? [
          {
            id: 'delivery-preview',
            version: '1.0.0',
            adapterId: 'openslack.github.v1',
            capabilityIds: ['github.issues.create'],
          },
        ]
      : [],
    capabilities: [
      {
        id: 'github.issues.create',
        adapterId: 'openslack.github.v1',
        risk: 'low',
        readOnly: false,
        approvalRequired: true,
      },
    ],
    adapters: [
      {
        id: SOFTWARE_DELIVERY_PROJECTOR_ID,
        kind: 'projection',
        capabilityIds: [],
      },
      {
        id: 'openslack.github.v1',
        kind: 'workflow',
        capabilityIds: ['github.issues.create'],
      },
    ],
    deepLinkTemplates: [],
    notificationIntents: [],
  });
}

async function loadWorkflowDefinition() {
  const parent = await mkdtemp(join(tmpdir(), 'openslack-scenario-planner-'));
  temporaryRoots.push(parent);
  const root = join(parent, 'scenarios');
  const pack = join(root, 'software-delivery');
  await mkdir(root);
  await cp(join(scenarioRoot, 'software-delivery'), pack, { recursive: true });
  await writeFile(
    join(pack, 'capabilities.yaml'),
    [
      'schema: openslack.scenario_capabilities.v1',
      'requested:',
      '  - github.issues.create',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(pack, 'workflows.yaml'),
    [
      'schema: openslack.scenario_workflows.v1',
      'workflows:',
      '  - id: delivery-preview',
      '    adapterId: openslack.github.v1',
      '    capabilityIds:',
      '      - github.issues.create',
      '    role: delivery',
      '',
    ].join('\n'),
    'utf8',
  );
  const lockPath = join(pack, 'scenario.lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  for (const entry of lock.files) {
    const bytes = await readFile(join(pack, ...entry.path.split('/')));
    entry.bytes = bytes.length;
    entry.sha256 = createHash('sha256').update(bytes).digest('hex');
  }
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  return loadScenarioPack({
    scenarioRoot: root,
    scenarioId: 'software-delivery',
    catalog: workflowCatalog(true),
  });
}

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
    expect(plan.effects).toHaveLength(1);
    expect(plan.effects[0]).toMatchObject({
      kind: 'scenario.instantiate',
      payload: {
        schema: 'openslack.scenario_instantiate.v1',
        scenarioInstanceId: plan.scenarioInstanceId,
        inputHash: plan.inputHash,
        targetScopeHash: plan.targetScopeHash,
      },
    });
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

  it('fails with a typed error when a loaded definition is paired with another sealed catalog', async () => {
    const valid = await context();
    const definition = await loadWorkflowDefinition();
    expect(() =>
      previewScenario({
        ...valid,
        definition,
        catalog: workflowCatalog(false),
        actor: {
          id: valid.actor.id,
          permissions: { capabilities: ['github.issues.create'] },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'SCENARIO_PREVIEW_CATALOG_MISMATCH' }));
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

  it('rejects instance and nested array proxies before invoking reflection traps', async () => {
    const instance = createPreviewedScenarioInstance(previewScenario(await context()));
    let traps = 0;
    const proxy = new Proxy(
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
    expect(() => validateScenarioInstance(proxy)).toThrowError(
      expect.objectContaining({ code: 'SCENARIO_INSTANCE_INVALID' }),
    );
    expect(() => validateScenarioInstance({ ...instance, targetRefs: proxy })).toThrowError(
      expect.objectContaining({ code: 'SCENARIO_INSTANCE_INVALID' }),
    );
    expect(traps).toBe(0);
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

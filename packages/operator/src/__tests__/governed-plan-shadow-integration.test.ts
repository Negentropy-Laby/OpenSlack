import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGovernedActionExecutionRegistry } from '../action-execution-registry.js';
import { LocalGovernedPlanStore } from '../governed-plan-store.js';
import {
  createGovernedPlanCompiler,
  createGovernedPlanService,
  type GovernedPlanServiceOptions,
} from '../governed-plan-service.js';
import {
  GOVERNANCE_SHADOW_RECEIPT_SCHEMA,
  createGovernanceShadowPublisherPort,
  createGovernedPlanShadowObservationPort,
  prepareGovernanceShadowRequest,
  type GovernanceShadowEnvelope,
  type GovernanceShadowReceipt,
  type GovernedPlanShadowObservationPort,
} from '../governed-plan-shadow.js';

const roots: string[] = [];

async function root(name: string): Promise<string> {
  const value = await mkdtemp(`/tmp/openslack-${name}-`);
  roots.push(value);
  return value;
}

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  const deadline = Date.now() + 2_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function receipt(envelope: GovernanceShadowEnvelope): GovernanceShadowReceipt {
  const prepared = prepareGovernanceShadowRequest(envelope);
  return {
    schema: GOVERNANCE_SHADOW_RECEIPT_SCHEMA,
    operation: 'observation_ingest',
    status: 'accepted',
    parity: 'matched',
    idempotencyKey: prepared.idempotencyKey,
    requestFingerprint: prepared.requestFingerprint,
    workspaceId: envelope.source.workspaceId,
    planId: envelope.source.planId,
    sourceSequence: envelope.source.sourceSequence,
    observationKind: envelope.observation.kind,
    observationDigest: createHash('sha256').update(prepared.body, 'utf8').digest('hex'),
    committedAt: '2026-08-02T00:00:00.000Z',
  };
}

async function harness(shadowObserver?: GovernedPlanShadowObservationPort) {
  const registry = createGovernedActionExecutionRegistry([
    {
      actionId: 'scenario.instantiate',
      version: '1.0.0',
      bindingId: 'scenario-runtime.instantiate.v1',
      description: 'Instantiate scenario',
      execute: async () => ({ status: 'succeeded', summary: 'Created', evidenceRefs: [] }),
    },
  ]);
  const store = new LocalGovernedPlanStore(await root('governed-store'), shadowObserver);
  const options: GovernedPlanServiceOptions = {
    store,
    registry,
    getBindingSnapshot: () => ({
      sourceVersions: { scenario: 'v1' },
      permissionSnapshot: { allowed: true },
      buildNonce: 'operator-build-nonce-0123456789',
    }),
    audit: () => undefined,
    ...(shadowObserver === undefined ? {} : { shadowObserver }),
  };
  const service = createGovernedPlanService(options);
  const preview = await service.preview(
    createGovernedPlanCompiler(() => ({
      kind: 'scenario.instantiate',
      goal: 'Instantiate scenario',
      input: { scenarioId: 'software-delivery' },
      actions: [{ actionId: 'scenario.instantiate', input: { scenarioId: 'software-delivery' } }],
      effects: [{ type: 'scenario.instance', summary: 'Create instance', risk: 'medium' }],
    })),
    { actorId: 'agent.test', workspaceId: 'workspace.test' },
  );
  return { service, preview };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe('governance shadow authority integration', () => {
  it('is disabled by default and performs zero network calls', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 500 }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);
    const { service, preview } = await harness();
    const result = await service.confirm(
      { planId: preview.record.planId, confirmationToken: preview.confirmationToken },
      { actorId: 'agent.test', workspaceId: 'workspace.test' },
    );

    expect(result.state).toBe('succeeded');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('projects durable records, pre-CAS confirmation, and successful audits in source order', async () => {
    const calls: GovernanceShadowEnvelope[] = [];
    const observer = await createGovernedPlanShadowObservationPort({
      journalRoot: join(await root('governed-shadow'), 'journal'),
      publisher: createGovernanceShadowPublisherPort(async (envelope) => {
        calls.push(envelope);
        return receipt(envelope);
      }),
    });
    const { service, preview } = await harness(observer);
    await service.confirm(
      { planId: preview.record.planId, confirmationToken: preview.confirmationToken },
      { actorId: 'agent.test', workspaceId: 'workspace.test' },
    );

    await waitFor(() => expect(calls).toHaveLength(8));
    expect(calls.map((call) => call.source.sourceSequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(calls.map((call) => call.observation.kind)).toEqual([
      'record',
      'audit',
      'confirmation',
      'record',
      'audit',
      'audit',
      'record',
      'audit',
    ]);
    expect(calls[2]?.observation).toMatchObject({
      kind: 'confirmation',
      recordRevision: 1,
      authorityOutcome: 'claim_eligible',
    });
    expect(JSON.stringify(calls)).not.toContain(preview.confirmationToken);
  });

  it('does not await a hung shadow publisher or change the TypeScript result', async () => {
    const observer = await createGovernedPlanShadowObservationPort({
      journalRoot: join(await root('governed-shadow-hung'), 'journal'),
      publisher: createGovernanceShadowPublisherPort(
        () => new Promise<GovernanceShadowReceipt>(() => undefined),
      ),
    });
    const { service, preview } = await harness(observer);
    const result = await service.confirm(
      { planId: preview.record.planId, confirmationToken: preview.confirmationToken },
      { actorId: 'agent.test', workspaceId: 'workspace.test' },
    );

    expect(result.state).toBe('succeeded');
  });

  it('preserves rejection outcomes and attempted authority without exposing the token', async () => {
    const calls: GovernanceShadowEnvelope[] = [];
    const observer = await createGovernedPlanShadowObservationPort({
      journalRoot: join(await root('governed-shadow-rejection'), 'journal'),
      publisher: createGovernanceShadowPublisherPort(async (envelope) => {
        calls.push(envelope);
        return receipt(envelope);
      }),
    });
    const { service, preview } = await harness(observer);
    await expect(
      service.confirm(
        { planId: preview.record.planId, confirmationToken: preview.confirmationToken },
        { actorId: 'agent.test', workspaceId: 'workspace.attempted' },
      ),
    ).rejects.toMatchObject({ code: 'GOVERNED_PLAN_CONFIRMATION_INVALID' });

    await waitFor(() => expect(calls).toHaveLength(4));
    expect(calls[2]).toMatchObject({
      source: { workspaceId: 'workspace.test' },
      observation: {
        kind: 'confirmation',
        workspaceId: 'workspace.attempted',
        authorityOutcome: 'confirmation_rejected',
      },
    });
    expect(JSON.stringify(calls)).not.toContain(preview.confirmationToken);
  });

  it('keeps TypeScript authoritative when the publisher throws or rejects', async () => {
    const failures = [
      () => {
        throw new Error('shadow throw');
      },
      () => Promise.reject(new Error('shadow rejection')),
    ];
    for (const failure of failures) {
      const observer = await createGovernedPlanShadowObservationPort({
        journalRoot: join(await root('governed-shadow-failure'), 'journal'),
        publisher: createGovernanceShadowPublisherPort(failure),
      });
      const { service, preview } = await harness(observer);
      await expect(
        service.confirm(
          { planId: preview.record.planId, confirmationToken: preview.confirmationToken },
          { actorId: 'agent.test', workspaceId: 'workspace.test' },
        ),
      ).resolves.toMatchObject({ state: 'succeeded' });
    }
  });
});

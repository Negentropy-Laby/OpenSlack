import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
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
  type CreateGovernedPlanShadowObservationPortOptions,
} from '../governed-plan-shadow.js';

function createFixture() {
  const roots: string[] = [];
  const foreground = new Set<Promise<unknown>>();
  const observers: Promise<GovernedPlanShadowObservationPort>[] = [];
  const releases: Array<() => void> = [];
  const restorations: Array<() => void> = [];

  function track<T>(work: Promise<T>): Promise<T> {
    foreground.add(work);
    void work.then(
      () => foreground.delete(work),
      () => foreground.delete(work),
    );
    return work;
  }

  onTestFinished(async (context) => {
    // A flush snapshots scheduled work. Settle its producers first, including
    // a test body that outlived its deadline, before taking that snapshot.
    for (const release of releases) release();
    while (foreground.size) await Promise.allSettled([...foreground]);
    const created = await Promise.allSettled(observers);
    const flushed = await Promise.allSettled(
      created.flatMap((result) => (result.status === 'fulfilled' ? [result.value.flush()] : [])),
    );
    const failures = [...created, ...flushed].flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    for (const restore of restorations) {
      try {
        restore();
      } catch (error) {
        failures.push(error);
      }
    }
    // If creation/drain failed, quiescence is unproven: retain these roots.
    if (failures.length === 0) {
      const removed = await Promise.allSettled(
        roots.map((value) => rm(value, { recursive: true, force: true })),
      );
      failures.push(
        ...removed.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
      );
    }
    if (failures.length) {
      const error = new AggregateError(failures, 'Governance shadow fixture teardown failed');
      if (context.task.result?.state === 'fail') console.error(error);
      else throw error;
    }
  });

  return {
    track,
    restore: (action: () => void) => restorations.push(action),
    root: (name: string) =>
      track(
        (async () => {
          const temporaryParent = process.platform === 'win32' ? tmpdir() : '/tmp';
          const value = await mkdtemp(join(temporaryParent, `openslack-${name}-`));
          roots.push(value);
          return value;
        })(),
      ),
    observer: (options: CreateGovernedPlanShadowObservationPortOptions) => {
      const work = createGovernedPlanShadowObservationPort(options);
      observers.push(work);
      return track(work);
    },
    gate: () => {
      let release!: () => void;
      let enter!: () => void;
      let cancelEntry!: (reason: Error) => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve, reject) => {
        enter = resolve;
        cancelEntry = reject;
      });
      // Cleanup must also settle a waiter when append failed before publishing.
      // Rejecting that wait is cancellation, never evidence of publisher entry.
      void entered.catch(() => undefined);
      releases.push(() => {
        release();
        cancelEntry(new Error('Fixture finished before shadow publisher entry'));
      });
      return { pending, release, entered, enter };
    },
  };
}

type ShadowFixture = ReturnType<typeof createFixture>;

function withFixture(body: (fixture: ShadowFixture) => Promise<void>) {
  return () => {
    const fixture = createFixture();
    return fixture.track(body(fixture));
  };
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

function harness(fixture: ShadowFixture, shadowObserver?: GovernedPlanShadowObservationPort) {
  return fixture.track(
    (async () => {
      const registry = createGovernedActionExecutionRegistry([
        {
          actionId: 'scenario.instantiate',
          version: '1.0.0',
          bindingId: 'scenario-runtime.instantiate.v1',
          description: 'Instantiate scenario',
          execute: async () => ({ status: 'succeeded', summary: 'Created', evidenceRefs: [] }),
        },
      ]);
      const store = new LocalGovernedPlanStore(
        await fixture.root('governed-store'),
        shadowObserver,
      );
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
          actions: [
            { actionId: 'scenario.instantiate', input: { scenarioId: 'software-delivery' } },
          ],
          effects: [{ type: 'scenario.instance', summary: 'Create instance', risk: 'medium' }],
        })),
        { actorId: 'agent.test', workspaceId: 'workspace.test' },
      );
      return { service, preview, store };
    })(),
  );
}

describe('governance shadow authority integration', () => {
  it(
    'is disabled by default and performs zero network calls',
    withFixture(async (fixture) => {
      const fetch = vi.fn(async () => new Response(null, { status: 500 }));
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);
      const installedFetch = globalThis.fetch;
      fixture.restore(() => {
        if (globalThis.fetch === installedFetch) fetchSpy.mockRestore();
      });
      const { service, preview } = await harness(fixture);
      const result = await fixture.track(
        service.confirm(
          { planId: preview.record.planId, confirmationToken: preview.confirmationToken },
          { actorId: 'agent.test', workspaceId: 'workspace.test' },
        ),
      );

      expect(result.state).toBe('succeeded');
      expect(fetch).not.toHaveBeenCalled();
    }),
  );

  it(
    'projects durable records, pre-CAS confirmation, and successful audits in source order',
    withFixture(async (fixture) => {
      const calls: GovernanceShadowEnvelope[] = [];
      const journalRoot = join(await fixture.root('governed-shadow'), 'journal');
      const observer = await fixture.observer({
        journalRoot,
        publisher: createGovernanceShadowPublisherPort(async (envelope) => {
          calls.push(envelope);
          return receipt(envelope);
        }),
      });
      const { service, preview } = await harness(fixture, observer);
      await fixture.track(
        service.confirm(
          { planId: preview.record.planId, confirmationToken: preview.confirmationToken },
          { actorId: 'agent.test', workspaceId: 'workspace.test' },
        ),
      );

      // Confirmation is authoritative; shadow publication is deliberately asynchronous.
      // Wait for the public qualification seam, not a wall-clock guess about disk I/O.
      await observer.flush();
      expect(calls).toHaveLength(8);
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
      expect(await readdir(join(journalRoot, 'entries'))).toHaveLength(0);
      const states = await readdir(join(journalRoot, 'states'));
      expect(states).toHaveLength(1);
      const state = JSON.parse(await readFile(join(journalRoot, 'states', states[0]!), 'utf8')) as {
        ackedSequence: number;
        lastSequence: number;
      };
      expect(state).toMatchObject({ ackedSequence: 8, lastSequence: 8 });
    }),
  );

  it(
    'does not await a hung shadow publisher or change the TypeScript result',
    withFixture(async (fixture) => {
      const gate = fixture.gate();
      const observer = await fixture.observer({
        journalRoot: join(await fixture.root('governed-shadow-hung'), 'journal'),
        publisher: createGovernanceShadowPublisherPort(async (envelope) => {
          gate.enter();
          await gate.pending;
          return receipt(envelope);
        }),
      });
      const { service, preview } = await harness(fixture, observer);
      await gate.entered;
      const confirmation = fixture.track(
        service.confirm(
          { planId: preview.record.planId, confirmationToken: preview.confirmationToken },
          { actorId: 'agent.test', workspaceId: 'workspace.test' },
        ),
      );
      const result = await confirmation;

      // The publisher is still blocked here; teardown releases it only after
      // the authoritative confirmation has independently completed.
      expect(result.state).toBe('succeeded');
    }),
  );

  it(
    'preserves rejection outcomes and attempted authority without exposing the token',
    withFixture(async (fixture) => {
      const calls: GovernanceShadowEnvelope[] = [];
      const gate = fixture.gate();
      const journalRoot = join(await fixture.root('governed-shadow-rejection'), 'journal');
      const observer = await fixture.observer({
        journalRoot,
        publisher: createGovernanceShadowPublisherPort(async (envelope) => {
          calls.push(envelope);
          if (envelope.source.sourceSequence === 1) {
            gate.enter();
            await gate.pending;
          }
          return receipt(envelope);
        }),
      });
      const { service, preview } = await harness(fixture, observer);
      await gate.entered;
      await expect(
        fixture.track(
          service.confirm(
            { planId: preview.record.planId, confirmationToken: preview.confirmationToken },
            { actorId: 'agent.test', workspaceId: 'workspace.attempted' },
          ),
        ),
      ).rejects.toMatchObject({ code: 'GOVERNED_PLAN_CONFIRMATION_INVALID' });

      // A legal blocked shadow publication does not prevent the authoritative
      // rejection. Releasing it alone is not evidence that the journal drained.
      expect(calls.length).toBeLessThan(4);
      gate.release();
      await observer.flush();
      expect(calls).toHaveLength(4);
      expect(calls.map((call) => call.source.sourceSequence)).toEqual([1, 2, 3, 4]);
      expect(calls.map((call) => call.observation.kind)).toEqual([
        'record',
        'audit',
        'confirmation',
        'audit',
      ]);
      expect(calls[2]).toMatchObject({
        source: { workspaceId: 'workspace.test' },
        observation: {
          kind: 'confirmation',
          workspaceId: 'workspace.attempted',
          authorityOutcome: 'confirmation_rejected',
        },
      });
      expect(JSON.stringify(calls)).not.toContain(preview.confirmationToken);
      expect(await readdir(join(journalRoot, 'entries'))).toHaveLength(0);
      const states = await readdir(join(journalRoot, 'states'));
      expect(states).toHaveLength(1);
      const state = JSON.parse(await readFile(join(journalRoot, 'states', states[0]!), 'utf8')) as {
        ackedSequence: number;
        lastSequence: number;
      };
      expect(state).toMatchObject({ ackedSequence: 4, lastSequence: 4 });
    }),
  );

  it.each(['throws', 'rejects'] as const)(
    'keeps TypeScript authoritative when the publisher %s',
    (mode) =>
      withFixture(async (fixture) => {
        const failure = vi.fn(
          mode === 'throws'
            ? () => {
                throw new Error('shadow throw');
              }
            : () => Promise.reject(new Error('shadow rejection')),
        );
        const observer = await fixture.observer({
          journalRoot: join(await fixture.root('governed-shadow-failure'), 'journal'),
          publisher: createGovernanceShadowPublisherPort(failure),
        });
        const { service, preview, store } = await harness(fixture, observer);
        await expect(
          fixture.track(
            service.confirm(
              { planId: preview.record.planId, confirmationToken: preview.confirmationToken },
              { actorId: 'agent.test', workspaceId: 'workspace.test' },
            ),
          ),
        ).resolves.toMatchObject({ state: 'succeeded' });
        await observer.flush();
        expect(failure).toHaveBeenCalled();
        expect(await store.load(preview.record.planId)).toMatchObject({ state: 'succeeded' });
      })(),
  );
});

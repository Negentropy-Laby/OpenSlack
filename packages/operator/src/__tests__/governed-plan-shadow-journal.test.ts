import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalGovernedJson,
  createCanonicalGovernedPlan,
  hashGovernedValue,
  hashOpaqueValue,
  validateGovernedPlanRecord,
  type GovernedPlanRecord,
} from '../governed-plan.js';
import {
  GOVERNANCE_SHADOW_RECEIPT_SCHEMA,
  createGovernanceShadowConfirmationObservation,
  createGovernanceShadowPublisherPort,
  createGovernedPlanShadowObservationPort,
  prepareGovernanceShadowRequest,
  type GovernanceShadowEnvelope,
  type GovernanceShadowReceipt,
} from '../governed-plan-shadow.js';
import type { GovernedPlanAuditEvent } from '../governed-plan-service.js';

const roots: string[] = [];

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  const deadline = Date.now() + 1_000;
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

async function journalRoot(): Promise<string> {
  // Bun inherits Windows TEMP under WSL, whose DrvFS permissions cannot enforce
  // the owner-only journal invariant. Exercise the POSIX invariant on /tmp,
  // while native Windows uses its absolute temporary directory.
  const temporaryParent = process.platform === 'win32' ? tmpdir() : '/tmp';
  const parent = await mkdtemp(join(temporaryParent, 'openslack-governance-shadow-'));
  roots.push(parent);
  return join(parent, 'journal');
}

function record(revision = 1, state: GovernedPlanRecord['state'] = 'pending'): GovernedPlanRecord {
  const plan = createCanonicalGovernedPlan({
    kind: 'scenario.instantiate',
    goal: 'Instantiate scenario',
    input: { scenarioId: 'software-delivery' },
    actions: [{ actionId: 'scenario.instantiate', input: { scenarioId: 'software-delivery' } }],
    effects: [{ type: 'scenario.instance', summary: 'Create instance', risk: 'medium' }],
  });
  return validateGovernedPlanRecord({
    schema: 'openslack.governed_plan.v1',
    revision,
    planId: 'GPLAN-123e4567-e89b-42d3-a456-426614174000',
    state,
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    expiresAt: '2026-08-02T00:15:00.000Z',
    canonicalPlan: plan,
    bindings: {
      actorId: 'agent.test',
      workspaceId: 'workspace.test',
      correlationId: 'CORR-123e4567-e89b-42d3-a456-426614174001',
      inputHash: hashGovernedValue(plan.input),
      planHash: hashGovernedValue(plan),
      sourceVersionHash: hashGovernedValue({ source: 'v1' }),
      permissionSnapshotHash: hashGovernedValue({ allowed: true }),
      actionCatalogHash: hashGovernedValue(['scenario.instantiate']),
      executorBindingHash: hashGovernedValue(['scenario.instantiate@v1']),
      buildNonceHash: hashOpaqueValue('build-nonce-0123456789'),
      processNonceHash: hashOpaqueValue('process-nonce-0123456789'),
    },
    confirmationTokenHash: hashOpaqueValue('confirmation-token-0123456789'),
  });
}

function audit(value: GovernedPlanRecord): GovernedPlanAuditEvent {
  return {
    schema: 'openslack.governed_plan_audit.v1',
    eventId: 'GAUDIT-123e4567-e89b-42d3-a456-426614174002',
    type: 'plan.previewed',
    occurredAt: '2026-08-02T00:00:00.001Z',
    planId: value.planId,
    kind: value.canonicalPlan.kind,
    actorId: value.bindings.actorId,
    workspaceId: value.bindings.workspaceId,
    correlationId: value.bindings.correlationId,
    state: value.state,
    revision: value.revision,
    evidenceRefs: [],
  };
}

function executingRecord(): GovernedPlanRecord {
  const pending = record();
  return validateGovernedPlanRecord({
    ...pending,
    revision: 2,
    state: 'executing',
    updatedAt: '2026-08-02T00:00:00.003Z',
    execution: {
      executionId: 'GEXEC-123e4567-e89b-42d3-a456-426614174004',
      ownerPid: process.pid,
      startedAt: '2026-08-02T00:00:00.003Z',
      outcomes: [],
    },
  });
}

function accepted(value: GovernanceShadowEnvelope): GovernanceShadowReceipt {
  const request = prepareGovernanceShadowRequest(value);
  return {
    schema: GOVERNANCE_SHADOW_RECEIPT_SCHEMA,
    operation: 'observation_ingest',
    status: 'accepted',
    parity: 'matched',
    idempotencyKey: request.idempotencyKey,
    requestFingerprint: request.requestFingerprint,
    workspaceId: value.source.workspaceId,
    planId: value.source.planId,
    sourceSequence: value.source.sourceSequence,
    observationKind: value.observation.kind,
    observationDigest: createHash('sha256').update(request.body, 'utf8').digest('hex'),
    committedAt: '2026-08-02T00:00:00.002Z',
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('governance shadow observation journal', () => {
  it('persists and dispatches record, confirmation, and audit in per-plan source order', async () => {
    const calls: GovernanceShadowEnvelope[] = [];
    const root = await journalRoot();
    const publisher = createGovernanceShadowPublisherPort(async (value) => {
      calls.push(value);
      return accepted(value);
    });
    const port = await createGovernedPlanShadowObservationPort({
      journalRoot: root,
      publisher,
    });
    const value = record();
    const presentedTokenHash = hashOpaqueValue('presented-confirmation-token-123456789');

    port.observeRecord(value);
    port.observeConfirmation(
      value,
      createGovernanceShadowConfirmationObservation({
        recordRevision: value.revision,
        attemptedAt: '2026-08-02T00:00:00.001Z',
        actorId: value.bindings.actorId,
        workspaceId: value.bindings.workspaceId,
        presentedTokenHash,
        authorityOutcome: 'confirmation_rejected',
      }),
    );
    port.observeAudit(value, audit(value));

    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls.map((call) => call.source.sourceSequence)).toEqual([1, 2, 3]);
    expect(calls.map((call) => call.observation.kind)).toEqual(['record', 'confirmation', 'audit']);
    const serialized = calls.map((call) => canonicalGovernedJson(call)).join('\n');
    expect(serialized).not.toContain('presented-confirmation-token-123456789');
    expect(serialized).toContain(presentedTokenHash);
    await waitFor(async () => {
      expect(await readdir(join(root, 'entries'))).toHaveLength(0);
      const states = await readdir(join(root, 'states'));
      const state = JSON.parse(await readFile(join(root, 'states', states[0]!), 'utf8')) as {
        ackedSequence: number;
        lastSequence: number;
      };
      expect(state).toMatchObject({ ackedSequence: 3, lastSequence: 3 });
    });
  });

  it('replays an unacknowledged exact journal entry after observer restart', async () => {
    const root = await journalRoot();
    const unavailable = createGovernanceShadowPublisherPort(async () => {
      throw new Error('service unavailable');
    });
    const diagnostics: string[] = [];
    const first = await createGovernedPlanShadowObservationPort({
      journalRoot: root,
      publisher: unavailable,
      diagnosticSink: (value) => {
        diagnostics.push(value.outcome);
      },
    });
    first.observeRecord(record());
    await waitFor(() => expect(diagnostics).toContain('unavailable'));
    expect(await readdir(join(root, 'entries'))).toHaveLength(1);

    const replayed: GovernanceShadowEnvelope[] = [];
    await createGovernedPlanShadowObservationPort({
      journalRoot: root,
      publisher: createGovernanceShadowPublisherPort(async (value) => {
        replayed.push(value);
        return accepted(value);
      }),
    });

    await waitFor(() => expect(replayed).toHaveLength(1));
    expect(replayed[0]?.source.sourceSequence).toBe(1);
    await waitFor(async () => expect(await readdir(join(root, 'entries'))).toHaveLength(0));
    const states = await readdir(join(root, 'states'));
    const state = JSON.parse(await readFile(join(root, 'states', states[0]!), 'utf8')) as {
      ackedSequence: number;
      lastSequence: number;
    };
    expect(state).toMatchObject({ ackedSequence: 1, lastSequence: 1 });
  });

  it('reaps a durably acknowledged entry after a crash without republishing it', async () => {
    const root = await journalRoot();
    const diagnostics: string[] = [];
    const first = await createGovernedPlanShadowObservationPort({
      journalRoot: root,
      publisher: createGovernanceShadowPublisherPort(async () => {
        throw new Error('service unavailable');
      }),
      diagnosticSink: (value) => {
        diagnostics.push(value.outcome);
      },
    });
    first.observeRecord(record());
    await waitFor(() => expect(diagnostics).toContain('unavailable'));

    const states = await readdir(join(root, 'states'));
    const statePath = join(root, 'states', states[0]!);
    const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
    await writeFile(statePath, `${canonicalGovernedJson({ ...state, ackedSequence: 1 })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });

    const replayed: GovernanceShadowEnvelope[] = [];
    await createGovernedPlanShadowObservationPort({
      journalRoot: root,
      publisher: createGovernanceShadowPublisherPort(async (value) => {
        replayed.push(value);
        return accepted(value);
      }),
    });

    await waitFor(async () => expect(await readdir(join(root, 'entries'))).toHaveLength(0));
    expect(replayed).toHaveLength(0);
  });

  it('waits for live journal lock contention instead of dropping the observation', async () => {
    const root = await journalRoot();
    const calls: GovernanceShadowEnvelope[] = [];
    const port = await createGovernedPlanShadowObservationPort({
      journalRoot: root,
      publisher: createGovernanceShadowPublisherPort(async (value) => {
        calls.push(value);
        return accepted(value);
      }),
    });
    const capacityHash = createHash('sha256')
      .update('openslack.governance-shadow.journal-capacity.v1')
      .digest('hex');
    const lockPath = join(root, 'locks', `${capacityHash}.lock`);
    await writeFile(
      lockPath,
      `${canonicalGovernedJson({ pid: process.pid, nonce: '123e4567-e89b-42d3-a456-426614174003' })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );

    port.observeRecord(record());
    setTimeout(() => void rm(lockPath, { force: true }), 50);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.source.sourceSequence).toBe(1);
    await waitFor(async () => expect(await readdir(join(root, 'entries'))).toHaveLength(0));
  });

  it('orders a newer record before dependent observations and coalesces its later replay', async () => {
    const root = await journalRoot();
    const calls: GovernanceShadowEnvelope[] = [];
    const port = await createGovernedPlanShadowObservationPort({
      journalRoot: root,
      publisher: createGovernanceShadowPublisherPort(async (value) => {
        calls.push(value);
        return accepted(value);
      }),
    });
    const pending = record();
    const executing = executingRecord();
    port.observeRecord(pending);
    await waitFor(() => expect(calls).toHaveLength(1));

    port.observeConfirmation(
      executing,
      createGovernanceShadowConfirmationObservation({
        recordRevision: executing.revision,
        attemptedAt: '2026-08-02T00:00:00.004Z',
        actorId: executing.bindings.actorId,
        workspaceId: executing.bindings.workspaceId,
        presentedTokenHash: hashOpaqueValue('presented-confirmation-token-123456789'),
        authorityOutcome: 'execution_active',
      }),
    );
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls.map((call) => call.observation.kind)).toEqual([
      'record',
      'record',
      'confirmation',
    ]);

    port.observeRecord(executing);
    port.observeAudit(executing, audit(executing));
    await waitFor(() => expect(calls).toHaveLength(4));
    expect(calls.map((call) => call.observation.kind)).toEqual([
      'record',
      'record',
      'confirmation',
      'audit',
    ]);
    expect(calls.map((call) => call.source.sourceSequence)).toEqual([1, 2, 3, 4]);
    await waitFor(async () => expect(await readdir(join(root, 'entries'))).toHaveLength(0));
  });

  it('marks a restart gap incomplete and never blocks reconciliation callers', async () => {
    const diagnostics: string[] = [];
    const root = await journalRoot();
    const calls: GovernanceShadowEnvelope[] = [];
    const port = await createGovernedPlanShadowObservationPort({
      journalRoot: root,
      publisher: createGovernanceShadowPublisherPort(async (value) => {
        calls.push(value);
        return accepted(value);
      }),
      diagnosticSink: (value) => {
        diagnostics.push(value.outcome);
      },
    });

    expect(() => port.reconcile([record(1)])).not.toThrow();
    await waitFor(() => expect(diagnostics).toContain('journal_incomplete'));
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(async () => expect(await readdir(join(root, 'entries'))).toHaveLength(0));
  });

  it('acknowledges a committed mismatch and emits only its bounded code', async () => {
    const diagnostics: { outcome: string; code?: string }[] = [];
    const root = await journalRoot();
    const port = await createGovernedPlanShadowObservationPort({
      journalRoot: root,
      publisher: createGovernanceShadowPublisherPort(async (value) => ({
        ...accepted(value),
        parity: 'mismatched',
        mismatchCode: 'record_hash_mismatch',
      })),
      diagnosticSink: (value) => {
        diagnostics.push(value);
      },
    });
    port.observeRecord(record());

    await waitFor(() =>
      expect(diagnostics).toContainEqual({
        schema: 'openslack.governance_shadow_diagnostic.v1',
        outcome: 'mismatched',
        workspaceIdHash: expect.any(String),
        planIdHash: expect.any(String),
        sourceSequence: 1,
        code: 'record_hash_mismatch',
      }),
    );
    expect(await readdir(join(root, 'entries'))).toHaveLength(0);
    expect(JSON.stringify(diagnostics)).not.toContain('confirmation-token');
  });
});

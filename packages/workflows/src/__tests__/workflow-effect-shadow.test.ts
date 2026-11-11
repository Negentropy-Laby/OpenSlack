import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  createWorkflowEffectDecisionAuthority,
  workflowEffectApprovalAuditEventId,
} from '../workflow-effect-approval.js';
import { LocalWorkflowEffectApprovalStore } from '../workflow-effect-approval-store.js';
import {
  createWorkflowEffectAuthorizationPort,
  WorkflowEffectApprovalPendingError,
} from '../workflow-effect-authorization.js';
import {
  prepareWorkflowEffectControlEnvelope,
  validateWorkflowEffectControlEnvelope,
  type WorkflowEffectControlEnvelope,
} from '../workflow-effect-control-contract.js';
import {
  createWorkflowEffectShadowHttpPublisher,
  createWorkflowEffectShadowObservationPort,
  type WorkflowEffectShadowDiagnostic,
} from '../workflow-effect-shadow.js';
import {
  WORKFLOW_EFFECT_SHADOW_ERROR_CODES,
  workflowEffectShadowCanonicalJson,
} from '../workflow-effect-shadow-contract.js';
import { productionJournalSecurity, writeExclusive } from '../workflow-control-shadow.js';
import * as journalOperations from '../workflow-control-shadow.js';
import * as effectAuthorityOperations from '../workflow-effect-authority-store.js';
import {
  createWorkflowEffectLeaseAuthority,
  type WorkflowEffectLeaseBinding,
} from '../internal/workflow-effect-lease-authority.js';
import {
  createWorkflowRunnerEventReceipt,
  prepareWorkflowRunnerMessage,
  validateWorkflowRunnerMessage,
  WORKFLOW_RUNNER_PROTOCOL_VERSION,
  type WorkflowRunnerEffectIntentMessage,
} from '../workflow-runner-contract.js';

const roots: string[] = [];
const BUILD_HASH = '1'.repeat(64);
const SOURCE_HASH = '2'.repeat(64);
const MANIFEST_HASH = '3'.repeat(64);
const INPUT_HASH = '4'.repeat(64);
const REASON_HASH = '5'.repeat(64);

vi.setConfig({ testTimeout: process.platform === 'win32' ? 120_000 : 30_000 });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(
    join(process.platform === 'win32' ? tmpdir() : '/tmp', 'openslack-effect-shadow-'),
  );
  roots.push(root);
  return root;
}

async function goldenEnvelope(name: 'approvalCreated' | 'approvalDecided' | 'auditRecorded') {
  const golden = JSON.parse(
    await readFile(
      join(
        import.meta.dirname,
        '..',
        '..',
        'contracts',
        'workflow-effect-shadow',
        'v1',
        'golden-vectors.json',
      ),
      'utf8',
    ),
  ) as {
    sourceEnvelopes: Record<string, { value: unknown; canonicalBytes: string }>;
  };
  return {
    envelope: validateWorkflowEffectControlEnvelope(golden.sourceEnvelopes[name]!.value),
    canonicalBytes: golden.sourceEnvelopes[name]!.canonicalBytes,
  };
}

function receiptFor(
  envelope: WorkflowEffectControlEnvelope,
  status: 'accepted' | 'reconciliation_required' = 'accepted',
) {
  const prepared = prepareWorkflowEffectControlEnvelope(envelope);
  return workflowEffectShadowCanonicalJson({
    schema: 'openslack.workflow_effect_shadow_receipt.v1',
    status,
    idempotencyKey: prepared.idempotencyKey,
    receiptId: `receipt.${envelope.sourceSequence}`,
    observationId: status === 'accepted' ? `observation.${envelope.sourceSequence}` : null,
    workspaceId: envelope.observation.workspaceId,
    runId: envelope.observation.runId,
    occurrenceId: envelope.observation.occurrenceId,
    approvalId: envelope.observation.approvalId,
    sourceSequence: envelope.sourceSequence,
    operation: envelope.operation,
    parity: status === 'accepted' ? 'matched' : 'unknown',
    mismatchCode: null,
    reconciliationToken: status === 'reconciliation_required' ? 'reconciliation.test.1' : null,
    envelopeHash: prepared.bodyHash,
    observationHash: envelope.observationHash,
    serviceBuildHash: '8'.repeat(64),
    committedAt: status === 'accepted' ? '2026-08-14T00:00:01.000Z' : null,
  });
}

describe('GS9-D effect shadow transport and durable observation', () => {
  it('keeps all generated response schemas aligned with golden instances', async () => {
    const contractRoot = join(
      import.meta.dirname,
      '..',
      '..',
      'contracts',
      'workflow-effect-shadow',
      'v1',
    );
    const schemaNames = [
      'workflow-effect-shadow-accepted-receipt.v1.schema.json',
      'workflow-effect-shadow-reconciliation-receipt.v1.schema.json',
      'workflow-effect-shadow-receipt.v1.schema.json',
      'workflow-effect-shadow-head.v1.schema.json',
      'workflow-effect-shadow-error.v1.schema.json',
    ];
    const schemas = await Promise.all(
      schemaNames.map(async (name) =>
        JSON.parse(await readFile(join(contractRoot, 'schemas', name), 'utf8')),
      ),
    );
    const golden = JSON.parse(
      await readFile(join(contractRoot, 'golden-vectors.json'), 'utf8'),
    ) as { responses: Record<string, { value: Record<string, unknown> }> };
    const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
    for (const schema of schemas) ajv.addSchema(schema);
    const validateReceipt = ajv.getSchema(schemas[2].$id)!;
    const validateHead = ajv.getSchema(schemas[3].$id)!;
    const validateError = ajv.getSchema(schemas[4].$id)!;
    for (const name of [
      'acceptedMatched',
      'acceptedReplay',
      'acceptedMismatched',
      'reconciliation',
    ]) {
      expect(
        validateReceipt(golden.responses[name]!.value),
        JSON.stringify(validateReceipt.errors),
      ).toBe(true);
    }
    expect(validateHead(golden.responses.head!.value), JSON.stringify(validateHead.errors)).toBe(
      true,
    );
    for (const code of WORKFLOW_EFFECT_SHADOW_ERROR_CODES) {
      expect(
        validateError({ ...golden.responses.error!.value, code }),
        JSON.stringify(validateError.errors),
      ).toBe(true);
    }
    const firstMismatch = {
      ...golden.responses.head!.value,
      matchedSourceSequence: null,
      matchedOperation: null,
      matchedObservationHash: null,
      mismatchLatched: true,
      mismatchCode: 'EFFECT_IDENTITY_DRIFT',
    };
    expect(validateHead(firstMismatch), JSON.stringify(validateHead.errors)).toBe(true);
    const invalidHead = structuredClone(golden.responses.head!.value);
    invalidHead.matchedSourceSequence = null;
    invalidHead.matchedOperation = null;
    invalidHead.matchedObservationHash = null;
    expect(validateHead(invalidHead)).toBe(false);
    expect(
      validateError({
        ...golden.responses.error!.value,
        code: 'WORKFLOW_EFFECT_SHADOW_UNKNOWN',
      }),
    ).toBe(false);
  });

  it('posts exact D1 bytes with closed identity headers and accepts byte-identical replay metadata', async () => {
    const { envelope, canonicalBytes } = await goldenEnvelope('approvalCreated');
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(init!);
      return new Response(receiptFor(envelope), {
        status: calls.length === 1 ? 201 : 200,
        headers: {
          'content-type': 'application/json',
          ...(calls.length === 1 ? {} : { 'Idempotency-Replayed': 'true' }),
        },
      });
    });
    const publisher = createWorkflowEffectShadowHttpPublisher({
      endpoint: 'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
      bearerToken: 'qualification-bearer-token-value',
      callerId: 'workflow-runner',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(publisher.publish(envelope)).resolves.toMatchObject({ status: 'accepted' });
    await expect(publisher.publish(envelope)).resolves.toMatchObject({ status: 'accepted' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(calls[0]?.body).toBe(`${canonicalBytes}\n`);
    expect(calls[0]?.headers).toMatchObject({
      Authorization: 'Bearer qualification-bearer-token-value',
      'Content-Type': 'application/json',
      'X-OpenSlack-Caller-ID': 'workflow-runner',
      'X-OpenSlack-Workspace-ID': envelope.observation.workspaceId,
    });
  });

  it('resolves an immutable 202 receipt before acknowledging journal delivery', async () => {
    const { envelope, canonicalBytes } = await goldenEnvelope('approvalCreated');
    const calls: URL[] = [];
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(new URL(String(input)));
      if (init?.body !== undefined && init.body !== null) bodies.push(init.body);
      const index = calls.length;
      const resolving = index % 2 === 0;
      return new Response(
        receiptFor(envelope, resolving ? 'accepted' : 'reconciliation_required'),
        {
          status: resolving ? (index === 2 ? 201 : 200) : 202,
          headers: {
            'content-type': 'application/json',
            ...(index >= 3 ? { 'Idempotency-Replayed': 'true' } : {}),
          },
        },
      );
    });
    const publisher = createWorkflowEffectShadowHttpPublisher({
      endpoint: 'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
      bearerToken: 'qualification-bearer-token-value',
      callerId: 'workflow-runner',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(publisher.publish(envelope)).resolves.toMatchObject({ status: 'accepted' });
    await expect(publisher.publish(envelope)).resolves.toMatchObject({ status: 'accepted' });
    expect(calls.map((value) => value.pathname)).toEqual([
      '/v1/shadow/workflow-control/effect-events',
      '/v1/shadow/workflow-control/effect-reconciliations/reconciliation.test.1/resolve',
      '/v1/shadow/workflow-control/effect-events',
      '/v1/shadow/workflow-control/effect-reconciliations/reconciliation.test.1/resolve',
    ]);
    expect(bodies).toEqual(Array.from({ length: 4 }, () => `${canonicalBytes}\n`));
  });

  it('applies the calibrated timeout independently to the original and resolve requests', async () => {
    vi.useFakeTimers();
    try {
      const { envelope } = await goldenEnvelope('approvalCreated');
      let call = 0;
      const publisher = createWorkflowEffectShadowHttpPublisher({
        endpoint: 'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
        bearerToken: 'qualification-bearer-token-value',
        callerId: 'workflow-runner',
        fetchImpl: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10_000));
          call += 1;
          return new Response(
            receiptFor(envelope, call === 1 ? 'reconciliation_required' : 'accepted'),
            {
              status: call === 1 ? 202 : 201,
              headers: { 'content-type': 'application/json' },
            },
          );
        }) as typeof fetch,
      });

      const pending = publisher.publish(envelope);
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toMatchObject({ status: 'accepted' });
      expect(call).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries only explicit temporary HTTP failures', async () => {
    const { envelope } = await goldenEnvelope('approvalCreated');
    const publish = async (status: number, code: string) => {
      const publisher = createWorkflowEffectShadowHttpPublisher({
        endpoint: 'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
        bearerToken: 'qualification-bearer-token-value',
        callerId: 'workflow-runner',
        fetchImpl: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                schema: 'openslack.workflow_effect_shadow_error.v1',
                code,
                message: 'bounded qualification failure',
              }),
              { status, headers: { 'content-type': 'application/json' } },
            ),
        ) as typeof fetch,
      });
      return publisher.publish(envelope);
    };

    await expect(publish(408, 'WORKFLOW_EFFECT_SHADOW_REQUEST_TIMEOUT')).rejects.toMatchObject({
      retryable: true,
    });
    await expect(publish(400, 'WORKFLOW_EFFECT_SHADOW_REQUEST_READ_FAILED')).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('uses the calibrated 15-second default request timeout', async () => {
    vi.useFakeTimers();
    try {
      const { envelope } = await goldenEnvelope('approvalCreated');
      const publisher = createWorkflowEffectShadowHttpPublisher({
        endpoint: 'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
        bearerToken: 'qualification-bearer-token-value',
        callerId: 'workflow-runner',
        fetchImpl: vi.fn(
          async (_input, init) =>
            await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                once: true,
              });
            }),
        ) as typeof fetch,
      });
      const pending = publisher.publish(envelope);
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).rejects.toMatchObject({ retryable: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects non-loopback routes, contradictory statuses, and oversized receipts', async () => {
    const { envelope } = await goldenEnvelope('approvalCreated');
    expect(() =>
      createWorkflowEffectShadowHttpPublisher({
        endpoint: 'https://example.com/v1/shadow/workflow-control/effect-events',
        bearerToken: 'qualification-bearer-token-value',
        callerId: 'workflow-runner',
      }),
    ).toThrow('Workflow effect shadow endpoint is invalid.');
    const contradictory = createWorkflowEffectShadowHttpPublisher({
      endpoint: 'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
      bearerToken: 'qualification-bearer-token-value',
      callerId: 'workflow-runner',
      fetchImpl: vi.fn(
        async () =>
          new Response(receiptFor(envelope), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          }),
      ) as typeof fetch,
    });
    await expect(contradictory.publish(envelope)).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
    });
    const oversized = createWorkflowEffectShadowHttpPublisher({
      endpoint: 'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
      bearerToken: 'qualification-bearer-token-value',
      callerId: 'workflow-runner',
      fetchImpl: vi.fn(
        async () =>
          new Response(' '.repeat(64 * 1024 + 1), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }),
      ) as typeof fetch,
    });
    await expect(oversized.publish(envelope)).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
    });
    const oversizedError = createWorkflowEffectShadowHttpPublisher({
      endpoint: 'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
      bearerToken: 'qualification-bearer-token-value',
      callerId: 'workflow-runner',
      fetchImpl: vi.fn(
        async () =>
          new Response(' '.repeat(16 * 1024 + 1), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
      ) as typeof fetch,
    });
    await expect(oversizedError.publish(envelope)).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
    });
    const remoteFailure = createWorkflowEffectShadowHttpPublisher({
      endpoint: 'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
      bearerToken: 'qualification-bearer-token-value',
      callerId: 'workflow-runner',
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              schema: 'openslack.workflow_effect_shadow_error.v1',
              code: 'WORKFLOW_EFFECT_SHADOW_DATABASE_ERROR',
              message: 'effect shadow repository is unavailable',
            }),
            { status: 503, headers: { 'content-type': 'application/json' } },
          ),
      ) as typeof fetch,
    });
    await expect(remoteFailure.publish(envelope)).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
      remoteCode: 'WORKFLOW_EFFECT_SHADOW_DATABASE_ERROR',
    });
    const malformedFailure = createWorkflowEffectShadowHttpPublisher({
      endpoint: 'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
      bearerToken: 'qualification-bearer-token-value',
      callerId: 'workflow-runner',
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ code: 'WORKFLOW_EFFECT_SHADOW_DATABASE_ERROR' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
      ) as typeof fetch,
    });
    await expect(malformedFailure.publish(envelope)).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
      remoteCode: undefined,
    });
  });

  it('rejects journal roots that overlap TypeScript effect authority state before writing', async () => {
    const workspaceRoot = await temporaryRoot();
    const publisher = createWorkflowEffectShadowHttpPublisher({
      endpoint: 'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
      bearerToken: 'qualification-bearer-token-value',
      callerId: 'workflow-runner',
      fetchImpl: vi.fn() as typeof fetch,
    });
    for (const journalRoot of [
      join(workspaceRoot, '.openslack.local', 'workflows'),
      join(workspaceRoot, '.openslack.local', 'workflows', 'effect-approvals', 'shadow'),
      join(workspaceRoot, '.openslack.local', 'workflows', 'effect-authority', 'shadow'),
    ]) {
      await expect(
        createWorkflowEffectShadowObservationPort({
          enabled: true,
          workspaceRoot,
          journalRoot,
          publisher,
        }),
      ).rejects.toMatchObject({ code: 'WORKFLOW_EFFECT_SHADOW_CONFIG_INVALID' });
    }
    await expect(readdir(join(workspaceRoot, '.openslack.local'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('quarantines one safe malformed journal entry without poisoning later replay', async () => {
    const workspaceRoot = await temporaryRoot();
    const journalRoot = join(workspaceRoot, '.openslack.local', 'workflow-effect-shadow');
    const publisher = createWorkflowEffectShadowHttpPublisher({
      endpoint: 'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
      bearerToken: 'qualification-bearer-token-value',
      callerId: 'workflow-runner',
      fetchImpl: vi.fn() as typeof fetch,
    });
    const observer = await createWorkflowEffectShadowObservationPort({
      enabled: true,
      workspaceRoot,
      journalRoot,
      publisher,
    });
    await writeExclusive(
      join(journalRoot, 'entries', 'unexpected.tmp'),
      'incomplete',
      productionJournalSecurity(),
    );

    await expect(observer.replay()).resolves.toBeUndefined();
    expect(await readdir(join(journalRoot, 'entries'))).toEqual([]);
    expect(await readdir(join(journalRoot, 'quarantine'))).toHaveLength(1);
    await expect(observer.synchronize()).resolves.toBeUndefined();
  });

  it('parks deterministic delivery failures and retries the durable journal after restart', async () => {
    const workspaceRoot = await temporaryRoot();
    const journalRoot = join(workspaceRoot, '.openslack.local', 'workflow-effect-shadow');
    const { envelope } = await goldenEnvelope('approvalCreated');
    const prepared = prepareWorkflowEffectControlEnvelope(envelope);
    const rejectingPublisher = createWorkflowEffectShadowHttpPublisher({
      endpoint: 'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
      bearerToken: 'qualification-bearer-token-value',
      callerId: 'workflow-runner',
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              schema: 'openslack.workflow_effect_shadow_error.v1',
              code: 'WORKFLOW_EFFECT_SHADOW_INPUT_INVALID',
              message: 'deterministic qualification rejection',
            }),
            { status: 422, headers: { 'content-type': 'application/json' } },
          ),
      ) as typeof fetch,
    });
    const first = await createWorkflowEffectShadowObservationPort({
      enabled: true,
      workspaceRoot,
      journalRoot,
      publisher: rejectingPublisher,
    });
    const entry = join(
      journalRoot,
      'entries',
      `${envelope.sourceSequence}-${prepared.bodyHash}.json`,
    );
    await writeExclusive(entry, prepared.body, productionJournalSecurity());

    await expect(first.replay()).rejects.toMatchObject({ retryable: false });
    await expect(first.replay()).resolves.toBeUndefined();
    expect(await readdir(join(journalRoot, 'entries'))).toEqual([basename(entry)]);

    const acceptingPublisher = createWorkflowEffectShadowHttpPublisher({
      endpoint: 'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
      bearerToken: 'qualification-bearer-token-value',
      callerId: 'workflow-runner',
      fetchImpl: vi.fn(
        async () =>
          new Response(receiptFor(envelope), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }),
      ) as typeof fetch,
    });
    const restarted = await createWorkflowEffectShadowObservationPort({
      enabled: true,
      workspaceRoot,
      journalRoot,
      publisher: acceptingPublisher,
    });
    await expect(restarted.replay()).resolves.toBeUndefined();
    expect(await readdir(join(journalRoot, 'entries'))).toEqual([]);
  });

  it('keeps one delivery in flight while duplicate replay and retry converge', async () => {
    const workspaceRoot = await temporaryRoot();
    const journalRoot = join(workspaceRoot, '.openslack.local', 'workflow-effect-shadow');
    const { envelope } = await goldenEnvelope('approvalCreated');
    const prepared = prepareWorkflowEffectControlEnvelope(envelope);
    let calls = 0;
    let inFlight = 0;
    let maximumInFlight = 0;
    let releaseFirst!: () => void;
    let reportFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      reportFirstStarted = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const publisher = createWorkflowEffectShadowHttpPublisher({
      endpoint: 'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
      bearerToken: 'qualification-bearer-token-value',
      callerId: 'workflow-runner',
      fetchImpl: vi.fn(async () => {
        calls += 1;
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        try {
          if (calls === 1) {
            reportFirstStarted();
            await firstRelease;
            return new Response(
              JSON.stringify({
                schema: 'openslack.workflow_effect_shadow_error.v1',
                code: 'WORKFLOW_EFFECT_SHADOW_DATABASE_ERROR',
                message: 'temporary qualification failure',
              }),
              { status: 503, headers: { 'content-type': 'application/json' } },
            );
          }
          return new Response(receiptFor(envelope), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        } finally {
          inFlight -= 1;
        }
      }) as typeof fetch,
    });
    const observer = await createWorkflowEffectShadowObservationPort({
      enabled: true,
      workspaceRoot,
      journalRoot,
      publisher,
    });
    await writeExclusive(
      join(journalRoot, 'entries', `${envelope.sourceSequence}-${prepared.bodyHash}.json`),
      prepared.body,
      productionJournalSecurity(),
    );

    vi.useFakeTimers();
    try {
      const first = observer.replay();
      await firstStarted;
      const duplicate = observer.replay();
      releaseFirst();
      await expect(first).rejects.toMatchObject({ retryable: true });
      await expect(duplicate).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(250);
      await observer.flush();
      expect(calls).toBe(2);
      expect(maximumInFlight).toBe(1);
      expect(await readdir(join(journalRoot, 'entries'))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  async function rebuildDurableObservations(
    options: {
      contendWithExecutionClaim?: boolean;
      decision?: 'approved' | 'rejected';
      cancelClaim?: boolean;
    } = {},
  ) {
    const {
      contendWithExecutionClaim = false,
      decision = 'approved',
      cancelClaim = false,
    } = options;
    const workspaceRoot = await temporaryRoot();
    const approvalRoot = join(workspaceRoot, '.openslack.local', 'workflows', 'effect-approvals');
    let now = new Date().toISOString();
    let sequence = 2;
    const binding: WorkflowEffectLeaseBinding = {
      workspaceId: 'workspace-1',
      runId: 'run-1',
      correlationId: 'correlation-1',
      workflowId: 'workflow-1',
      workflowVersion: '1.0.0',
      workflowSourceHash: SOURCE_HASH,
      manifestHash: MANIFEST_HASH,
      inputHash: INPUT_HASH,
      descriptorExpiresAt: new Date(Date.parse(now) + 60 * 60_000).toISOString(),
      expectedControlBuildHash: BUILD_HASH,
      async emitIntent(handle, beforeSend) {
        const message = validateWorkflowRunnerMessage({
          protocolVersion: WORKFLOW_RUNNER_PROTOCOL_VERSION,
          kind: 'effect_intent',
          workspaceId: 'workspace-1',
          jobId: 'job-1',
          workflowRunId: 'run-1',
          attemptId: 'attempt-1',
          leaseId: 'lease-1',
          fencingToken: 1,
          sequence,
          eventId: `event-${sequence}`,
          correlationId: 'correlation-1',
          sentAt: now,
          payload: handle,
        }) as WorkflowRunnerEffectIntentMessage;
        const prepared = prepareWorkflowRunnerMessage(message);
        await beforeSend({ message, prepared });
        const receipt = createWorkflowRunnerEventReceipt(message, {
          status: 'accepted',
          errorCode: null,
          sequence: sequence + 1,
          sentAt: now,
          controlBuildHash: BUILD_HASH,
        });
        sequence += 2;
        return { message, prepared, receipt };
      },
    };
    const delivered: WorkflowEffectControlEnvelope[] = [];
    const diagnostics: WorkflowEffectShadowDiagnostic[] = [];
    let releaseExecutionClaim: (() => void) | undefined;
    let releasedExecutionClaim = false;
    let witnessedClaimLock = false;
    let recoveredWhileClaimHeld = false;
    let observerLockWaits = 0;
    const seen = new Set<string>();
    let failFirstDelivery = true;
    const publisher = createWorkflowEffectShadowHttpPublisher({
      endpoint: 'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
      bearerToken: 'qualification-bearer-token-value',
      callerId: 'workflow-runner',
      fetchImpl: vi.fn(async (_input, init) => {
        if (failFirstDelivery) {
          failFirstDelivery = false;
          throw new TypeError('qualification observer unavailable');
        }
        const envelope = validateWorkflowEffectControlEnvelope(JSON.parse(String(init?.body)));
        delivered.push(envelope);
        const prepared = prepareWorkflowEffectControlEnvelope(envelope);
        const replay = seen.has(prepared.idempotencyKey);
        seen.add(prepared.idempotencyKey);
        return new Response(receiptFor(envelope), {
          status: replay ? 200 : 201,
          headers: {
            'content-type': 'application/json',
            ...(replay ? { 'Idempotency-Replayed': 'true' } : {}),
          },
        });
      }) as typeof fetch,
    });
    const observer = await createWorkflowEffectShadowObservationPort({
      enabled: true,
      workspaceRoot,
      journalRoot: join(workspaceRoot, '.openslack.local', 'workflow-effect-shadow'),
      publisher,
      diagnosticSink: (diagnostic) => {
        diagnostics.push(diagnostic);
        if (diagnostic.outcome === 'failed') releaseExecutionClaim?.();
      },
    });
    const observationEvidence = async () => {
      const entries = join(workspaceRoot, '.openslack.local', 'workflow-effect-shadow', 'entries');
      const evidenceFailure = (error: unknown) => {
        const code = (error as { code?: unknown })?.code;
        return {
          evidenceCode:
            typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(code)
              ? code
              : 'OBSERVATION_EVIDENCE_UNAVAILABLE',
        };
      };
      try {
        const journal = await Promise.all(
          (await readdir(entries)).map(async (name) => {
            try {
              const value = validateWorkflowEffectControlEnvelope(
                JSON.parse(await readFile(join(entries, name), 'utf8')),
              );
              return {
                operation: value.operation,
                sourceSequence: value.sourceSequence,
                observationHash: value.observationHash,
              };
            } catch (error) {
              return evidenceFailure(error);
            }
          }),
        );
        return JSON.stringify({
          diagnostics,
          journal,
          witnessedClaimLock,
          recoveredWhileClaimHeld,
          observerLockWaits,
        });
      } catch (error) {
        return JSON.stringify({
          diagnostics,
          ...evidenceFailure(error),
          witnessedClaimLock,
          recoveredWhileClaimHeld,
          observerLockWaits,
        });
      }
    };
    const makePort = () =>
      createWorkflowEffectAuthorizationPort({
        workspaceRoot,
        effectBoundary: Object.freeze({ intent: vi.fn(), outcome: vi.fn() }),
        leaseAuthority: createWorkflowEffectLeaseAuthority(binding),
        now: () => now,
        effectShadowObservationPort: observer,
      });
    const first = makePort();
    const prepared = await first.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    let pending!: WorkflowEffectApprovalPendingError;
    try {
      await first.authorize(prepared);
    } catch (error) {
      if (error instanceof WorkflowEffectApprovalPendingError) pending = error;
      else throw error;
    }
    await observer.flush();
    expect(delivered).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await observer.flush();
    expect(delivered.map((value) => value.operation)).toEqual(['approval_created']);

    const decisionAuthority = createWorkflowEffectDecisionAuthority({
      workspaceId: 'workspace-1',
      humanPrincipalIds: ['wsman'],
      capabilities: ['workflow.effect.decide'],
      maxBindingTtlMs: 60_000,
    });
    const approvals = new LocalWorkflowEffectApprovalStore(
      approvalRoot,
      decisionAuthority,
      () => now,
    );
    const pendingRecord = await approvals.read('run-1', pending.approvalId);
    const decisionBinding = decisionAuthority.issueHumanDecisionBinding({
      principalId: 'wsman',
      capability: 'workflow.effect.decide',
      runId: 'run-1',
      approvalId: pending.approvalId,
      correlationId: 'correlation-1',
      approvalExpiresAt: pendingRecord!.expiresAt,
      decision,
      reasonHash: REASON_HASH,
      expiresAt: new Date(
        Math.min(Date.now() + 30_000, Date.parse(pendingRecord!.expiresAt) - 1),
      ).toISOString(),
    });
    now = decisionBinding.issuedAt;
    const decided = await approvals.decide({
      runId: 'run-1',
      approvalId: pending.approvalId,
      expectedRevision: 0,
      decision,
      reasonHash: REASON_HASH,
      binding: decisionBinding,
    });
    const resumed = makePort();
    const resumedPrepared = await resumed.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    const restoreSpies: Array<() => void> = [];
    let rejectClaimWriteStarted: ((error: unknown) => void) | undefined;
    let authorizing: ReturnType<typeof resumed.authorize> | undefined;
    let primaryFailed = false;
    let primaryError: unknown;
    try {
      let claimWriteStarted: Promise<void> | undefined;
      let recoveryRequested = false;
      if (contendWithExecutionClaim) {
        let reportClaimWriteStarted!: () => void;
        claimWriteStarted = new Promise<void>((resolve, reject) => {
          reportClaimWriteStarted = resolve;
          rejectClaimWriteStarted = reject;
        });
        // Keep an early setup failure's cleanup rejection observed even if
        // the main barrier race or observer recovery has not attached yet.
        void claimWriteStarted.catch(() => undefined);
        const release = new Promise<void>((resolve) => {
          releaseExecutionClaim = () => {
            releasedExecutionClaim = true;
            resolve();
          };
        });
        const write = journalOperations.atomicWrite;
        const writeSpy = vi
          .spyOn(journalOperations, 'atomicWrite')
          .mockImplementation(async (...args) => {
            const [path, body] = args;
            const text =
              typeof body === 'string'
                ? body
                : new TextDecoder('utf-8', { fatal: true }).decode(body);
            if (
              basename(dirname(path)) === 'records' &&
              basename(dirname(dirname(path))) === 'effect-authority' &&
              JSON.parse(text).executionState === 'claimed'
            ) {
              const authorityRoot = dirname(dirname(path));
              const lock = JSON.parse(
                await readFile(join(authorityRoot, 'locks', 'authority.lock'), 'utf8'),
              );
              expect(lock.pid).toBe(process.pid);
              const claimRecords = await Promise.all(
                (await readdir(join(authorityRoot, 'claims'))).map(async (name) =>
                  JSON.parse(await readFile(join(authorityRoot, 'claims', name), 'utf8')),
                ),
              );
              expect(
                claimRecords.filter(
                  (record) => record.schema === 'openslack.workflow_effect_execution_record.v1',
                ),
              ).toMatchObject([
                { artifact: { claimStatus: 'claimed' }, owner: { pid: process.pid } },
              ]);
              witnessedClaimLock = true;
              reportClaimWriteStarted();
              await release;
            }
            return write(...args);
          });
        restoreSpies.push(() => writeSpy.mockRestore());
        let recovering = false;
        const recover = effectAuthorityOperations.recoverWorkflowEffectAuthorityObservationPrefix;
        const recoverSpy = vi
          .spyOn(effectAuthorityOperations, 'recoverWorkflowEffectAuthorityObservationPrefix')
          .mockImplementation(async (...args) => {
            expect(args.slice(1)).toEqual(['run-1', pending.approvalId, 1]);
            recoveryRequested = true;
            await claimWriteStarted;
            recoveredWhileClaimHeld = !releasedExecutionClaim;
            recovering = true;
            try {
              return await recover(...args);
            } finally {
              recovering = false;
            }
          });
        restoreSpies.push(() => recoverSpy.mockRestore());
        const acquire = journalOperations.acquireOwnerJournalLock;
        const lockSpy = vi
          .spyOn(journalOperations, 'acquireOwnerJournalLock')
          .mockImplementation(async (locks, hash, security) => {
            if (
              recovering &&
              basename(locks) === 'locks' &&
              basename(dirname(locks)) === 'effect-authority'
            ) {
              let lockTime = Date.now();
              return acquire(locks, hash, {
                ...security,
                now: () => lockTime,
                sleep: async () => {
                  observerLockWaits += 1;
                  lockTime += journalOperations.WORKFLOW_CONTROL_SHADOW_POLICY.maxTimeoutMs + 1;
                },
              });
            }
            return acquire(locks, hash, security);
          });
        restoreSpies.push(() => lockSpy.mockRestore());
      }
      const executionClaims = async () => {
        const directory = join(
          workspaceRoot,
          '.openslack.local',
          'workflows',
          'effect-authority',
          'claims',
        );
        const records = await Promise.all(
          (await readdir(directory)).map(async (name) =>
            JSON.parse(await readFile(join(directory, name), 'utf8')),
          ),
        );
        return records
          .filter((record) => record.schema === 'openslack.workflow_effect_execution_record.v1')
          .map((record) => ({
            executionId: record.artifact.executionId,
            claimStatus: record.artifact.claimStatus,
            ownerPid: record.owner?.pid ?? null,
          }));
      };
      authorizing = resumed.authorize(
        resumedPrepared,
        cancelClaim ? AbortSignal.abort(new Error('qualification claim cancelled')) : undefined,
      );
      if (decision === 'rejected' || cancelClaim) {
        await expect(authorizing).rejects.toMatchObject({
          code:
            decision === 'rejected'
              ? 'WORKFLOW_EFFECT_AUTHORIZATION_REJECTED'
              : 'WORKFLOW_EFFECT_AUTHORITY_REJECTED',
        });
        await observer.flush();
        expect(
          delivered.at(-1)?.operation,
          delivered.at(-1)?.operation === 'approval_decided'
            ? undefined
            : await observationEvidence(),
        ).toBe('approval_decided');
        expect(await executionClaims()).toEqual([]);
        expect((await approvals.read('run-1', pending.approvalId))?.status).toBe(decision);
        return;
      }
      if (claimWriteStarted) {
        await Promise.race([
          claimWriteStarted,
          authorizing.then(() => {
            if (!witnessedClaimLock) {
              throw new Error('Execution-claim fixture barrier was not reached.');
            }
          }),
        ]);
        if (!recoveryRequested) releaseExecutionClaim?.();
      }
      const claim = await authorizing;
      expect(claim).toMatchObject({ disposition: 'claimed' });
      if (claim.disposition !== 'claimed') throw new Error('expected an execution claim');
      await observer.flush();
      expect(
        delivered.at(-1)?.operation,
        delivered.at(-1)?.operation === 'approval_decided'
          ? undefined
          : await observationEvidence(),
      ).toBe('approval_decided');
      if (contendWithExecutionClaim) {
        expect(witnessedClaimLock).toBe(true);
        expect(recoveryRequested).toBe(true);
        expect(observerLockWaits).toBeLessThanOrEqual(1);
      }

      now = new Date(Date.parse(now) + 1).toISOString();
      await approvals.markAuditProjected({
        runId: 'run-1',
        approvalId: pending.approvalId,
        expectedRevision: 1,
        eventId: workflowEffectApprovalAuditEventId('run-1', pending.approvalId),
      });
      await resumed.complete(claim.authority, { ok: true });
      await observer.flush();
      expect(
        delivered.at(-1)?.operation,
        delivered.at(-1)?.operation === 'audit_recorded' ? undefined : await observationEvidence(),
      ).toBe('audit_recorded');
      expect(
        delivered.every(
          (value) =>
            !value.observation.goEffectDecisionAuthority &&
            !value.observation.goEffectExecutionAuthority,
        ),
      ).toBe(true);
      expect(JSON.stringify(delivered)).not.toContain('attestationNonce');
      expect(
        await readdir(join(workspaceRoot, '.openslack.local', 'workflow-effect-shadow', 'entries')),
      ).toEqual([]);
      expect(decided.revision).toBe(1);
      expect(createHash('sha256').update(JSON.stringify(delivered)).digest('hex')).toMatch(
        /^[0-9a-f]{64}$/u,
      );
      const beforeReplay = await executionClaims();
      expect(beforeReplay).toEqual([
        { executionId: claim.executionId, claimStatus: 'executed', ownerPid: null },
      ]);
      const replayPort = makePort();
      const replayPrepared = await replayPort.prepare({
        runId: 'run-1',
        evaluationIndex: 1,
        operation: 'openslack.governance.audit',
        detail: 'bounded audit',
      });
      const deliveryCount = delivered.length;
      const replay = await replayPort.authorize(replayPrepared);
      expect(replay).toMatchObject({
        disposition: 'replay',
        executionId: claim.executionId,
        value: { ok: true },
      });
      await observer.flush();
      expect(delivered.length).toBeGreaterThan(deliveryCount);
      expect(delivered.at(-1)?.operation).toBe('audit_recorded');
      expect(await executionClaims()).toEqual(beforeReplay);
    } catch (error) {
      primaryFailed = true;
      primaryError = error;
      throw error;
    } finally {
      releaseExecutionClaim?.();
      rejectClaimWriteStarted?.(
        primaryFailed
          ? primaryError
          : new Error('Execution-claim fixture closed before its barrier.'),
      );
      const cleanupErrors: unknown[] = [];
      try {
        await authorizing?.then(
          () => undefined,
          () => undefined,
        );
        await observer.flush();
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        for (const restore of restoreSpies.reverse()) {
          try {
            restore();
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
      }
      if (!primaryFailed && cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Effect-shadow fixture cleanup failed.');
      }
    }
  }

  it(
    'rebuilds pending, decision, and audit observations from durable D2 authority without granting Go authority',
    () => rebuildDurableObservations(),
    process.platform === 'win32' ? 120_000 : 30_000,
  );

  it(
    'does not lose the durable decision observation while its own execution claim holds the authority lock',
    () => rebuildDurableObservations({ contendWithExecutionClaim: true }),
    process.platform === 'win32' ? 120_000 : 30_000,
  );

  it(
    'observes an authenticated rejected decision without claiming an execution',
    () => rebuildDurableObservations({ decision: 'rejected' }),
    process.platform === 'win32' ? 120_000 : 30_000,
  );

  it(
    'observes the durable decision when claim acquisition is cancelled before consumption',
    () => rebuildDurableObservations({ cancelClaim: true }),
    process.platform === 'win32' ? 120_000 : 30_000,
  );
});

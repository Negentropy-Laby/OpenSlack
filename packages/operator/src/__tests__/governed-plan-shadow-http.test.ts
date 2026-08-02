import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalGovernedJson,
  createCanonicalGovernedPlan,
  hashGovernedValue,
  hashOpaqueValue,
  validateGovernedPlanRecord,
  type GovernedPlanRecord,
} from '../governed-plan.js';
import {
  GOVERNANCE_SHADOW_OBSERVATION_SCHEMA,
  GOVERNANCE_SHADOW_RECEIPT_SCHEMA,
  prepareGovernanceShadowRequest,
  type GovernanceShadowEnvelope,
  type GovernanceShadowReceipt,
} from '../governed-plan-shadow.js';
import {
  GovernanceShadowHttpError,
  createGovernanceShadowHttpPublisher,
} from '../governed-plan-shadow-http.js';

function record(): GovernedPlanRecord {
  const plan = createCanonicalGovernedPlan({
    kind: 'scenario.instantiate',
    goal: 'Instantiate scenario',
    input: { scenarioId: 'software-delivery' },
    actions: [{ actionId: 'scenario.instantiate', input: { scenarioId: 'software-delivery' } }],
    effects: [{ type: 'scenario.instance', summary: 'Create instance', risk: 'medium' }],
  });
  return validateGovernedPlanRecord({
    schema: 'openslack.governed_plan.v1',
    revision: 1,
    planId: 'GPLAN-123e4567-e89b-42d3-a456-426614174000',
    state: 'pending',
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

function envelope(): GovernanceShadowEnvelope {
  const value = record();
  return {
    schema: GOVERNANCE_SHADOW_OBSERVATION_SCHEMA,
    authority: 'typescript',
    source: {
      workspaceId: value.bindings.workspaceId,
      planId: value.planId,
      sourceSequence: 1,
    },
    observation: { kind: 'record', expectedRevision: 0, record: value },
  };
}

function receipt(
  value: GovernanceShadowEnvelope,
  status: GovernanceShadowReceipt['status'] = 'accepted',
): GovernanceShadowReceipt {
  const request = prepareGovernanceShadowRequest(value);
  return {
    schema: GOVERNANCE_SHADOW_RECEIPT_SCHEMA,
    operation: 'observation_ingest',
    status,
    parity: status === 'reconciliation_required' ? 'unknown' : 'matched',
    idempotencyKey: request.idempotencyKey,
    requestFingerprint: request.requestFingerprint,
    workspaceId: value.source.workspaceId,
    planId: value.source.planId,
    sourceSequence: value.source.sourceSequence,
    observationKind: value.observation.kind,
    observationDigest: createHash('sha256').update(request.body, 'utf8').digest('hex'),
    ...(status === 'reconciliation_required'
      ? { reconciliationToken: 'reconcile-123' }
      : { committedAt: '2026-08-02T00:00:00.123456Z' }),
  };
}

function response(value: unknown, status: number): Response {
  return new Response(`${canonicalGovernedJson(value as never)}\n`, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('governance shadow HTTP publisher', () => {
  it('uses exact canonical JSON plus LF and a source-bound deterministic fingerprint', () => {
    const value = envelope();
    const prepared = prepareGovernanceShadowRequest(value);
    const binding = `typescript/${value.source.workspaceId}/${value.source.planId}/1`;
    const expectedFingerprint = createHash('sha256')
      .update(`POST\n/v1/shadow/governance/observations\n${binding}\n${prepared.body}`, 'utf8')
      .digest('hex');

    expect(prepared.body).toBe(`${canonicalGovernedJson(value)}\n`);
    expect(prepared.requestFingerprint).toBe(`sha256:${expectedFingerprint}`);
    expect(prepared.idempotencyKey).toBe(
      `openslack.governance-shadow.v1.${createHash('sha256')
        .update(prepared.body, 'utf8')
        .digest('hex')}`,
    );
  });

  it('retries only bounded ordering conflicts and accepts a fully bound receipt', async () => {
    const value = envelope();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(response(receipt(value), 201));
    const publisher = createGovernanceShadowHttpPublisher({
      origin: 'http://127.0.0.1:18182',
      fetch: fetchMock,
      orderingRetryDelayMs: 1,
    });

    await expect(publisher.publish(value)).resolves.toMatchObject({
      status: 'accepted',
      parity: 'matched',
      sourceSequence: 1,
      observationKind: 'record',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(String(url)).toBe('http://127.0.0.1:18182/v1/shadow/governance/observations');
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(
      prepareGovernanceShadowRequest(value).idempotencyKey,
    );
  });

  it('never treats a 202 reconciliation receipt as acknowledged success', async () => {
    const value = envelope();
    const publisher = createGovernanceShadowHttpPublisher({
      origin: 'http://[::1]:18182',
      fetch: vi.fn(async () => response(receipt(value, 'reconciliation_required'), 202)),
    });

    await expect(publisher.publish(value)).rejects.toMatchObject({
      code: 'GOVERNANCE_SHADOW_CONFLICT',
    });
  });

  it('rejects inconsistent status, parity, and mismatch combinations', async () => {
    const value = envelope();
    const cases = [
      { ...receipt(value), parity: 'unknown' },
      { ...receipt(value), parity: 'mismatched' },
      {
        ...receipt(value, 'reconciliation_required'),
        parity: 'matched',
      },
      Object.fromEntries(
        Object.entries({
          ...receipt(value, 'reconciliation_required'),
          mismatchCode: 'not-allowed-for-unknown',
        }),
      ),
    ];
    for (const candidate of cases) {
      const publisher = createGovernanceShadowHttpPublisher({
        origin: 'http://127.0.0.1:18182',
        fetch: vi.fn(async () => response(candidate, candidate.status === 'accepted' ? 201 : 202)),
      });
      await expect(publisher.publish(value)).rejects.toMatchObject({
        code: 'GOVERNANCE_SHADOW_RECEIPT_INVALID',
      });
    }
  });

  it('accepts a committed semantic mismatch only with its mismatch code', async () => {
    const value = envelope();
    const mismatched = {
      ...receipt(value),
      parity: 'mismatched' as const,
      mismatchCode: 'record_hash_mismatch',
    };
    const publisher = createGovernanceShadowHttpPublisher({
      origin: 'http://127.0.0.1:18182',
      fetch: vi.fn(async () => response(mismatched, 201)),
    });
    await expect(publisher.publish(value)).resolves.toMatchObject(mismatched);
  });

  it('rejects DNS, public IPs, redirects, malformed receipts, and bounded timeouts', async () => {
    expect(() => createGovernanceShadowHttpPublisher({ origin: 'http://localhost:18182' })).toThrow(
      GovernanceShadowHttpError,
    );
    expect(() => createGovernanceShadowHttpPublisher({ origin: 'http://8.8.8.8:18182' })).toThrow(
      GovernanceShadowHttpError,
    );
    expect(() =>
      createGovernanceShadowHttpPublisher({
        origin: 'http://10.0.0.2:18182',
        networkMode: 'internal',
      }),
    ).not.toThrow();

    const value = envelope();
    const redirect = createGovernanceShadowHttpPublisher({
      origin: 'http://127.0.0.1:18182',
      fetch: vi.fn(async () => new Response(null, { status: 307 })),
    });
    await expect(redirect.publish(value)).rejects.toMatchObject({
      code: 'GOVERNANCE_SHADOW_HTTP_ERROR',
    });

    const malformed = createGovernanceShadowHttpPublisher({
      origin: 'http://127.0.0.1:18182',
      fetch: vi.fn(
        async () => new Response('{}\n', { headers: { 'Content-Type': 'application/json' } }),
      ),
    });
    await expect(malformed.publish(value)).rejects.toMatchObject({
      code: 'GOVERNANCE_SHADOW_RECEIPT_INVALID',
    });

    const timeout = createGovernanceShadowHttpPublisher({
      origin: 'http://127.0.0.1:18182',
      timeoutMs: 5,
      fetch: vi.fn(
        async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      ),
    });
    await expect(timeout.publish(value)).rejects.toMatchObject({
      code: 'GOVERNANCE_SHADOW_TIMEOUT',
    });
  });
});

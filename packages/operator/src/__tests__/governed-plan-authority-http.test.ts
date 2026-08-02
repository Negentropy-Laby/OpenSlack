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
  createGovernanceAuthorityHttpClient,
  GovernanceAuthorityHttpError,
} from '../governed-plan-authority-http.js';
import type { GovernedPlanAuthorityRoute } from '../governed-plan-authority-store.js';

const BUILD = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ROUTE: GovernedPlanAuthorityRoute = {
  backend: 'go',
  routingEpoch: 7,
  authority: 'governance-control',
};

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
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    expiresAt: '2026-08-03T00:15:00.000Z',
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

function successReceipt(body: string, status: 'accepted' | 'duplicate' = 'accepted') {
  const envelope = JSON.parse(body) as {
    operation: 'accept';
    expectedRevision: 0;
    record: GovernedPlanRecord;
  };
  const path = '/v1/governance/plans:accept';
  const idempotencyKey = `openslack.governance-authority.v1.${createHash('sha256')
    .update(body, 'utf8')
    .digest('hex')}`;
  const requestFingerprint = `sha256:${createHash('sha256')
    .update(`POST\n${path}\nqoder.mcp\nworkspace.test\n7\n${BUILD}\n${body}`, 'utf8')
    .digest('hex')}`;
  return {
    schema: 'openslack.governance_authority_receipt.v1',
    operation: envelope.operation,
    status,
    workspaceId: 'workspace.test',
    planId: envelope.record.planId,
    expectedRevision: envelope.expectedRevision,
    acceptedRevision: envelope.record.revision,
    state: envelope.record.state,
    route: ROUTE,
    idempotencyKey,
    requestFingerprint,
    recordHash: createHash('sha256')
      .update(`${canonicalGovernedJson(envelope.record)}\n`, 'utf8')
      .digest('hex'),
    correlationId: envelope.record.bindings.correlationId,
    callerId: 'qoder.mcp',
    serviceBuildSha: BUILD,
    record: envelope.record,
    committedAt: '2026-08-03T00:00:00.000Z',
  };
}

function response(value: unknown, status = 201): Response {
  return new Response(`${canonicalGovernedJson(value)}\n`, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function reconciliationReceipt(body: string) {
  const accepted = successReceipt(body);
  return {
    schema: accepted.schema,
    operation: accepted.operation,
    status: 'reconciliation_required',
    workspaceId: accepted.workspaceId,
    planId: accepted.planId,
    expectedRevision: accepted.expectedRevision,
    targetRevision: accepted.acceptedRevision,
    targetState: accepted.state,
    route: accepted.route,
    idempotencyKey: accepted.idempotencyKey,
    requestFingerprint: accepted.requestFingerprint,
    recordHash: accepted.recordHash,
    correlationId: accepted.correlationId,
    callerId: accepted.callerId,
    serviceBuildSha: accepted.serviceBuildSha,
    reconciliationToken: 'reconciliation-token-0001',
  };
}

describe('governance authority HTTP client', () => {
  it('binds exact canonical acceptance bytes, body idempotency, and the full fingerprint', async () => {
    const transport = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      const receipt = successReceipt(body);
      const headers = new Headers(init?.headers);
      expect(body).toBe(`${canonicalGovernedJson(JSON.parse(body))}\n`);
      expect(headers.get('Idempotency-Key')).toBe(receipt.idempotencyKey);
      expect(headers.get('X-OpenSlack-Governance-Routing-Epoch')).toBe('7');
      return response(receipt);
    });
    const client = createGovernanceAuthorityHttpClient({
      origin: 'http://127.0.0.1:18082',
      workspaceId: 'workspace.test',
      callerId: 'qoder.mcp',
      expectedBuildSha: BUILD,
      expiresAt: '2026-08-03T01:00:00.000Z',
      now: () => Date.parse('2026-08-03T00:00:00.000Z'),
      fetch: transport,
    });

    await expect(client.accept(record(), ROUTE)).resolves.toEqual(record());
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([
    { httpStatus: 200, receiptStatus: 'accepted' as const },
    { httpStatus: 201, receiptStatus: 'duplicate' as const },
  ])(
    'rejects HTTP $httpStatus with a mismatched $receiptStatus mutation receipt',
    async ({ httpStatus, receiptStatus }) => {
      const transport = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
        response(successReceipt(String(init?.body), receiptStatus), httpStatus),
      );
      const client = createGovernanceAuthorityHttpClient({
        origin: 'http://127.0.0.1:18082',
        workspaceId: 'workspace.test',
        callerId: 'qoder.mcp',
        expectedBuildSha: BUILD,
        expiresAt: '2026-08-03T01:00:00.000Z',
        now: () => Date.parse('2026-08-03T00:00:00.000Z'),
        fetch: transport,
      });

      await expect(client.accept(record(), ROUTE)).rejects.toMatchObject({
        code: 'GOVERNANCE_AUTHORITY_RECEIPT_INVALID',
      });
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      name: '202 with accepted body',
      status: 202,
      body: (request: string) => successReceipt(request),
    },
    {
      name: '200 with reconciliation body',
      status: 200,
      body: reconciliationReceipt,
    },
  ])('rejects $name before receipt recovery', async ({ status, body }) => {
    const transport = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      response(body(String(init?.body)), status),
    );
    const client = createGovernanceAuthorityHttpClient({
      origin: 'http://127.0.0.1:18082',
      workspaceId: 'workspace.test',
      callerId: 'qoder.mcp',
      expectedBuildSha: BUILD,
      expiresAt: '2026-08-03T01:00:00.000Z',
      now: () => Date.parse('2026-08-03T00:00:00.000Z'),
      fetch: transport,
    });

    await expect(client.accept(record(), ROUTE)).rejects.toMatchObject({
      code: 'GOVERNANCE_AUTHORITY_RECEIPT_INVALID',
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('recovers a lost mutation response only through the exact receipt read route', async () => {
    let body = '';
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        body = String(init.body);
        throw new Error('response lost after commit');
      }
      expect(String(input)).toContain('/v1/governance/receipts/');
      return response(successReceipt(body), 200);
    });
    const client = createGovernanceAuthorityHttpClient({
      origin: 'http://127.0.0.1:18082',
      workspaceId: 'workspace.test',
      callerId: 'qoder.mcp',
      expectedBuildSha: BUILD,
      expiresAt: '2026-08-03T01:00:00.000Z',
      now: () => Date.parse('2026-08-03T00:00:00.000Z'),
      fetch: transport,
    });

    await expect(client.accept(record(), ROUTE)).resolves.toEqual(record());
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  });

  it.each([408, 503])(
    'recovers HTTP %i only through the exact receipt read route',
    async (status) => {
      let body = '';
      const transport = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'POST') {
          body = String(init.body);
          return new Response(null, { status });
        }
        return response(successReceipt(body), 200);
      });
      const client = createGovernanceAuthorityHttpClient({
        origin: 'http://127.0.0.1:18082',
        workspaceId: 'workspace.test',
        callerId: 'qoder.mcp',
        expectedBuildSha: BUILD,
        expiresAt: '2026-08-03T01:00:00.000Z',
        now: () => Date.parse('2026-08-03T00:00:00.000Z'),
        fetch: transport,
      });

      await expect(client.accept(record(), ROUTE)).resolves.toEqual(record());
      expect(transport).toHaveBeenCalledTimes(2);
    },
  );

  it('fails closed on 202 without falling back or dispatching an effect', async () => {
    const transport = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      const accepted = successReceipt(body);
      return response(
        {
          schema: accepted.schema,
          operation: accepted.operation,
          status: 'reconciliation_required',
          workspaceId: accepted.workspaceId,
          planId: accepted.planId,
          expectedRevision: accepted.expectedRevision,
          targetRevision: accepted.acceptedRevision,
          targetState: accepted.state,
          route: accepted.route,
          idempotencyKey: accepted.idempotencyKey,
          requestFingerprint: accepted.requestFingerprint,
          recordHash: accepted.recordHash,
          correlationId: accepted.correlationId,
          callerId: accepted.callerId,
          serviceBuildSha: accepted.serviceBuildSha,
          reconciliationToken: 'reconciliation-token-0001',
        },
        202,
      );
    });
    const client = createGovernanceAuthorityHttpClient({
      origin: 'http://127.0.0.1:18082',
      workspaceId: 'workspace.test',
      callerId: 'qoder.mcp',
      expectedBuildSha: BUILD,
      expiresAt: '2026-08-03T01:00:00.000Z',
      now: () => Date.parse('2026-08-03T00:00:00.000Z'),
      fetch: transport,
    });

    await expect(client.accept(record(), ROUTE)).rejects.toBeInstanceOf(
      GovernanceAuthorityHttpError,
    );
    expect(transport).toHaveBeenCalledOnce();
  });

  it('rejects unsafe origins, redirects, noncanonical JSON, and oversized bodies', async () => {
    expect(() =>
      createGovernanceAuthorityHttpClient({
        origin: 'http://example.com:18082',
        workspaceId: 'workspace.test',
        callerId: 'qoder.mcp',
        expectedBuildSha: BUILD,
        expiresAt: '2026-08-03T01:00:00.000Z',
      }),
    ).toThrow('outside the selected private network mode');

    const redirected = createGovernanceAuthorityHttpClient({
      origin: 'http://127.0.0.1:18082',
      workspaceId: 'workspace.test',
      callerId: 'qoder.mcp',
      expectedBuildSha: BUILD,
      expiresAt: '2026-08-03T01:00:00.000Z',
      now: () => Date.parse('2026-08-03T00:00:00.000Z'),
      fetch: vi.fn(async (_input, init) => {
        expect(init?.redirect).toBe('manual');
        return new Response(null, { status: 307, headers: { Location: 'http://127.0.0.2/' } });
      }),
    });
    await expect(redirected.accept(record(), ROUTE)).rejects.toMatchObject({
      code: 'GOVERNANCE_AUTHORITY_HTTP_ERROR',
    });

    const noncanonical = createGovernanceAuthorityHttpClient({
      origin: 'http://127.0.0.1:18082',
      workspaceId: 'workspace.test',
      callerId: 'qoder.mcp',
      expectedBuildSha: BUILD,
      expiresAt: '2026-08-03T01:00:00.000Z',
      now: () => Date.parse('2026-08-03T00:00:00.000Z'),
      fetch: vi.fn(
        async () =>
          new Response('{ "schema": "not-canonical" }\n', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    });
    await expect(noncanonical.load(record().planId, ROUTE)).rejects.toMatchObject({
      code: 'GOVERNANCE_AUTHORITY_RECEIPT_INVALID',
    });

    const oversized = createGovernanceAuthorityHttpClient({
      origin: 'http://127.0.0.1:18082',
      workspaceId: 'workspace.test',
      callerId: 'qoder.mcp',
      expectedBuildSha: BUILD,
      expiresAt: '2026-08-03T01:00:00.000Z',
      maxResponseBytes: 64,
      now: () => Date.parse('2026-08-03T00:00:00.000Z'),
      fetch: vi.fn(
        async () =>
          new Response('x'.repeat(65), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Content-Length': '65' },
          }),
      ),
    });
    await expect(oversized.load(record().planId, ROUTE)).rejects.toMatchObject({
      code: 'GOVERNANCE_AUTHORITY_EXECUTION_UNCERTAIN',
    });
  });

  it('rejects a read whose record workspace differs from the configured workspace', async () => {
    const mismatched = validateGovernedPlanRecord({
      ...record(),
      bindings: { ...record().bindings, workspaceId: 'workspace.other' },
    });
    const transport = vi.fn(async () =>
      response(
        {
          schema: 'openslack.governance_authority_read.v1',
          workspaceId: 'workspace.test',
          planId: mismatched.planId,
          route: ROUTE,
          recordHash: createHash('sha256')
            .update(`${canonicalGovernedJson(mismatched)}\n`, 'utf8')
            .digest('hex'),
          record: mismatched,
          serviceBuildSha: BUILD,
        },
        200,
      ),
    );
    const client = createGovernanceAuthorityHttpClient({
      origin: 'http://127.0.0.1:18082',
      workspaceId: 'workspace.test',
      callerId: 'qoder.mcp',
      expectedBuildSha: BUILD,
      expiresAt: '2026-08-03T01:00:00.000Z',
      now: () => Date.parse('2026-08-03T00:00:00.000Z'),
      fetch: transport,
    });

    await expect(client.load(mismatched.planId, ROUTE)).rejects.toMatchObject({
      code: 'GOVERNANCE_AUTHORITY_RECEIPT_INVALID',
    });
  });

  it('reads only the exact per-plan pending audit and treats recorded as no pending', async () => {
    const value = record();
    const recordHash = createHash('sha256')
      .update(`${canonicalGovernedJson(value)}\n`, 'utf8')
      .digest('hex');
    let pending = true;
    const transport = vi.fn(async (input: string | URL | Request) => {
      expect(new URL(String(input)).pathname).toBe(
        `/v1/governance/plans/${value.planId}/authority-events/1:pending`,
      );
      if (!pending) return new Response(null, { status: 404 });
      pending = false;
      return response(
        {
          schema: 'openslack.governance_authority_pending_audit.v1',
          status: 'pending',
          workspaceId: 'workspace.test',
          planId: value.planId,
          revision: 1,
          operation: 'accept',
          route: ROUTE,
          recordHash,
          serviceBuildSha: BUILD,
        },
        200,
      );
    });
    const client = createGovernanceAuthorityHttpClient({
      origin: 'http://127.0.0.1:18082',
      workspaceId: 'workspace.test',
      callerId: 'qoder.mcp',
      expectedBuildSha: BUILD,
      expiresAt: '2026-08-03T01:00:00.000Z',
      now: () => Date.parse('2026-08-03T00:00:00.000Z'),
      fetch: transport,
    });

    await expect(client.pendingAudit(value.planId, 1, ROUTE)).resolves.toEqual({
      operation: 'accept',
      recordHash,
    });
    await expect(client.pendingAudit(value.planId, 1, ROUTE)).resolves.toBeNull();
  });

  it('replays only the same idempotent audit acknowledgement after response loss', async () => {
    const event = {
      schema: 'openslack.governed_plan_audit.v1' as const,
      eventId: 'GAUDIT-123e4567-e89b-42d3-a456-426614174000',
      type: 'plan.previewed' as const,
      occurredAt: '2026-08-03T00:00:00.000Z',
      planId: record().planId,
      kind: 'scenario.instantiate',
      actorId: 'agent.test',
      workspaceId: 'workspace.test',
      correlationId: record().bindings.correlationId,
      state: 'pending' as const,
      revision: 1,
      evidenceRefs: Object.freeze([]),
    };
    let attempts = 0;
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      attempts += 1;
      const body = String(init?.body);
      if (attempts === 1) throw new Error('response lost');
      const path = new URL(String(input)).pathname;
      const eventHash = createHash('sha256').update(body, 'utf8').digest('hex');
      const idempotencyKey = `openslack.governance-authority-audit.v1.${eventHash}`;
      const requestFingerprint = `sha256:${createHash('sha256')
        .update(`POST\n${path}\nqoder.mcp\nworkspace.test\n7\n${BUILD}\n${body}`, 'utf8')
        .digest('hex')}`;
      return response(
        {
          schema: 'openslack.governance_authority_audit_receipt.v1',
          status: 'duplicate',
          workspaceId: 'workspace.test',
          planId: event.planId,
          revision: event.revision,
          eventId: event.eventId,
          eventHash,
          idempotencyKey,
          requestFingerprint,
          recordedAt: '2026-08-03T00:00:00.000Z',
        },
        200,
      );
    });
    const client = createGovernanceAuthorityHttpClient({
      origin: 'http://127.0.0.1:18082',
      workspaceId: 'workspace.test',
      callerId: 'qoder.mcp',
      expectedBuildSha: BUILD,
      expiresAt: '2026-08-03T01:00:00.000Z',
      now: () => Date.parse('2026-08-03T00:00:00.000Z'),
      fetch: transport,
    });

    await expect(client.recordAudit(event, ROUTE)).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0]?.[1]?.body).toBe(transport.mock.calls[1]?.[1]?.body);
    expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get('Idempotency-Key')).toBe(
      new Headers(transport.mock.calls[1]?.[1]?.headers).get('Idempotency-Key'),
    );
  });
});

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGovernedActionExecutionRegistry } from '../action-execution-registry.js';
import {
  createGovernanceAuthorityHttpClient,
  type GovernanceAuthorityHttpOptions,
} from '../governed-plan-authority-http.js';
import {
  createRoutedGovernedPlanStore,
  type GovernanceAuthorityMutationOperation,
  type GovernedPlanAuthorityRoute,
} from '../governed-plan-authority-store.js';
import { canonicalGovernedJson, type GovernedPlanRecord } from '../governed-plan.js';
import { LocalGovernedPlanStore } from '../governed-plan-store.js';
import { createGovernedPlanCompiler, createGovernedPlanService } from '../governed-plan-service.js';

const BUILD = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const WORKSPACE_ID = 'workspace.demo';
const CALLER_ID = 'qoder.mcp';
const ROUTE: GovernedPlanAuthorityRoute = Object.freeze({
  backend: 'go',
  routingEpoch: 7,
  authority: 'governance-control',
});
const AUTHORITY = Object.freeze({ actorId: 'qoder.local', workspaceId: WORKSPACE_ID });
const roots: string[] = [];

interface MutationEnvelope {
  readonly operation: GovernanceAuthorityMutationOperation;
  readonly expectedRevision: number;
  readonly route: GovernedPlanAuthorityRoute;
  readonly record: GovernedPlanRecord;
}

type ReceiptFailure = '404' | 'timeout' | '202';

interface AuthorityFailure {
  readonly operation: GovernanceAuthorityMutationOperation;
  readonly post: 'timeout' | '503' | '202';
  readonly receipt?: ReceiptFailure;
  readonly commit: boolean;
}

function response(value: unknown, status: number): Response {
  return new Response(`${canonicalGovernedJson(value)}\n`, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mutationPath(envelope: MutationEnvelope): string {
  return envelope.operation === 'accept'
    ? '/v1/governance/plans:accept'
    : `/v1/governance/plans/${encodeURIComponent(envelope.record.planId)}:${envelope.operation.replaceAll('_', '-')}`;
}

function mutationBinding(body: string) {
  const envelope = JSON.parse(body) as MutationEnvelope;
  const path = mutationPath(envelope);
  const idempotencyKey = `openslack.governance-authority.v1.${createHash('sha256')
    .update(body, 'utf8')
    .digest('hex')}`;
  const requestFingerprint = `sha256:${createHash('sha256')
    .update(
      `POST\n${path}\n${CALLER_ID}\n${WORKSPACE_ID}\n${ROUTE.routingEpoch}\n${BUILD}\n${body}`,
      'utf8',
    )
    .digest('hex')}`;
  const executionId =
    envelope.operation === 'claim_execution' ||
    envelope.operation === 'complete_execution' ||
    envelope.operation === 'require_reconciliation'
      ? envelope.record.execution?.executionId
      : undefined;
  return {
    envelope,
    common: {
      schema: 'openslack.governance_authority_receipt.v1',
      operation: envelope.operation,
      workspaceId: WORKSPACE_ID,
      planId: envelope.record.planId,
      expectedRevision: envelope.expectedRevision,
      route: ROUTE,
      idempotencyKey,
      requestFingerprint,
      recordHash: createHash('sha256')
        .update(`${canonicalGovernedJson(envelope.record)}\n`, 'utf8')
        .digest('hex'),
      correlationId: envelope.record.bindings.correlationId,
      callerId: CALLER_ID,
      serviceBuildSha: BUILD,
      ...(executionId === undefined ? {} : { executionId }),
    },
  };
}

function acceptedReceipt(body: string) {
  const { envelope, common } = mutationBinding(body);
  return {
    ...common,
    status: 'accepted',
    acceptedRevision: envelope.record.revision,
    state: envelope.record.state,
    record: envelope.record,
    committedAt: '2026-08-03T00:00:00.000Z',
  };
}

function reconciliationReceipt(body: string) {
  const { envelope, common } = mutationBinding(body);
  return {
    ...common,
    status: 'reconciliation_required',
    targetRevision: envelope.record.revision,
    targetState: envelope.record.state,
    reconciliationToken: 'reconciliation-token-chain-0001',
  };
}

function auditReceipt(body: string, path: string) {
  const event = JSON.parse(body) as {
    readonly planId: string;
    readonly revision: number;
    readonly eventId: string;
  };
  const eventHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const idempotencyKey = `openslack.governance-authority-audit.v1.${eventHash}`;
  return {
    schema: 'openslack.governance_authority_audit_receipt.v1',
    status: 'recorded',
    workspaceId: WORKSPACE_ID,
    planId: event.planId,
    revision: event.revision,
    eventId: event.eventId,
    eventHash,
    idempotencyKey,
    requestFingerprint: `sha256:${createHash('sha256')
      .update(
        `POST\n${path}\n${CALLER_ID}\n${WORKSPACE_ID}\n${ROUTE.routingEpoch}\n${BUILD}\n${body}`,
        'utf8',
      )
      .digest('hex')}`,
    recordedAt: '2026-08-03T00:00:00.000Z',
  };
}

function authorityFetch(failure: AuthorityFailure) {
  const records = new Map<string, GovernedPlanRecord>();
  let failedBody: string | undefined;
  const transport: NonNullable<GovernanceAuthorityHttpOptions['fetch']> = vi.fn(
    async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url.pathname.includes('/authority-events/')) {
        const body = String(init?.body);
        return response(auditReceipt(body, url.pathname), 201);
      }
      if (method === 'POST') {
        const body = String(init?.body);
        const envelope = JSON.parse(body) as MutationEnvelope;
        if (envelope.operation === failure.operation) {
          failedBody = body;
          if (failure.commit) records.set(envelope.record.planId, envelope.record);
          if (failure.post === 'timeout') throw new DOMException('timed out', 'AbortError');
          if (failure.post === '503') return new Response(null, { status: 503 });
          return response(reconciliationReceipt(body), 202);
        }
        records.set(envelope.record.planId, envelope.record);
        return response(acceptedReceipt(body), 201);
      }
      if (url.pathname.startsWith('/v1/governance/receipts/')) {
        if (!failedBody || failure.receipt === '404') {
          return new Response(null, { status: 404 });
        }
        if (failure.receipt === 'timeout') {
          throw new DOMException('timed out', 'AbortError');
        }
        if (failure.receipt === '202') {
          return response(reconciliationReceipt(failedBody), 202);
        }
        return response(acceptedReceipt(failedBody), 200);
      }
      if (url.pathname.endsWith(':pending')) return new Response(null, { status: 404 });
      if (method === 'GET' && url.pathname.startsWith('/v1/governance/plans/')) {
        const planId = decodeURIComponent(url.pathname.slice('/v1/governance/plans/'.length));
        const record = records.get(planId);
        if (!record) return new Response(null, { status: 404 });
        return response(
          {
            schema: 'openslack.governance_authority_read.v1',
            workspaceId: WORKSPACE_ID,
            planId,
            route: ROUTE,
            recordHash: createHash('sha256')
              .update(`${canonicalGovernedJson(record)}\n`, 'utf8')
              .digest('hex'),
            record,
            serviceBuildSha: BUILD,
          },
          200,
        );
      }
      throw new Error(`unexpected authority request ${method} ${url.pathname}`);
    },
  );
  return { records, transport };
}

async function system(failure: AuthorityFailure) {
  const root = join(
    tmpdir(),
    `openslack-governance-chain-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  roots.push(root);
  const local = new LocalGovernedPlanStore(join(root, 'local'));
  const remote = authorityFetch(failure);
  const go = createGovernanceAuthorityHttpClient({
    origin: 'http://127.0.0.1:18082',
    workspaceId: WORKSPACE_ID,
    callerId: CALLER_ID,
    expectedBuildSha: BUILD,
    expiresAt: '2026-08-04T00:00:00.000Z',
    now: () => Date.parse('2026-08-03T00:00:00.000Z'),
    fetch: remote.transport,
  });
  const store = await createRoutedGovernedPlanStore({
    routeRoot: join(root, 'authority'),
    localStore: local,
    backend: 'go',
    routingEpoch: ROUTE.routingEpoch,
    go,
    now: () => new Date('2026-08-03T00:00:00.000Z'),
  });
  const execute = vi.fn(async () => ({ status: 'succeeded' as const, summary: 'Created' }));
  const registry = createGovernedActionExecutionRegistry([
    {
      actionId: 'scenario.instantiate',
      version: '1.0.0',
      bindingId: 'scenario-runtime.instantiate.v1',
      description: 'Instantiate scenario',
      execute,
    },
  ]);
  const service = createGovernedPlanService({
    store,
    registry,
    getBindingSnapshot: () => ({
      sourceVersions: { scenario: 'source-v1' },
      permissionSnapshot: { actions: ['scenario.instantiate'] },
      buildNonce: 'operator-build-nonce-0123456789',
    }),
    audit: () => undefined,
    now: () => new Date('2026-08-03T00:00:00.000Z'),
  });
  const compiler = createGovernedPlanCompiler((context) => ({
    kind: 'scenario.instantiate',
    goal: 'Instantiate scenario',
    input: { scenarioId: 'software-delivery', correlationId: context.correlationId },
    actions: [
      {
        actionId: 'scenario.instantiate',
        input: { scenarioId: 'software-delivery' },
      },
    ],
    effects: [{ type: 'scenario.instance', summary: 'Create instance', risk: 'medium' }],
  }));
  return { compiler, execute, local, remote, service };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('governance authority end-to-end failure chain', () => {
  it.each([
    {
      name: 'accept timeout then receipt miss',
      operation: 'accept' as const,
      post: 'timeout' as const,
      receipt: '404' as const,
    },
    {
      name: 'accept 503 then receipt timeout',
      operation: 'accept' as const,
      post: '503' as const,
      receipt: 'timeout' as const,
    },
    {
      name: 'claim timeout then receipt 202 unknown',
      operation: 'claim_execution' as const,
      post: 'timeout' as const,
      receipt: '202' as const,
    },
    {
      name: 'claim 503 then receipt miss',
      operation: 'claim_execution' as const,
      post: '503' as const,
      receipt: '404' as const,
    },
  ])('$name fails closed without local authority or effects', async (failure) => {
    const harness = await system({ ...failure, commit: false });
    if (failure.operation === 'accept') {
      await expect(harness.service.preview(harness.compiler, AUTHORITY)).rejects.toMatchObject({
        code: 'GOVERNANCE_AUTHORITY_EXECUTION_UNCERTAIN',
      });
    } else {
      const preview = await harness.service.preview(harness.compiler, AUTHORITY);
      await expect(
        harness.service.confirm(
          { planId: preview.record.planId, confirmationToken: preview.confirmationToken },
          AUTHORITY,
        ),
      ).rejects.toMatchObject({ code: 'GOVERNANCE_AUTHORITY_EXECUTION_UNCERTAIN' });
    }
    expect(await harness.local.list()).toEqual([]);
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'terminal response loss and missing receipt', post: 'timeout' as const },
    { name: 'terminal 202 unknown', post: '202' as const },
  ])('$name never replays the executor', async ({ post }) => {
    const harness = await system({
      operation: 'complete_execution',
      post,
      receipt: '404',
      commit: true,
    });
    const preview = await harness.service.preview(harness.compiler, AUTHORITY);
    const request = {
      planId: preview.record.planId,
      confirmationToken: preview.confirmationToken,
    };

    await expect(harness.service.confirm(request, AUTHORITY)).rejects.toMatchObject({
      code: 'GOVERNANCE_AUTHORITY_EXECUTION_UNCERTAIN',
    });
    expect(harness.remote.records.get(preview.record.planId)).toMatchObject({ state: 'succeeded' });
    expect(harness.execute).toHaveBeenCalledOnce();

    await expect(harness.service.confirm(request, AUTHORITY)).rejects.toMatchObject({
      code: 'GOVERNED_PLAN_STATE_INVALID',
    });
    expect(harness.execute).toHaveBeenCalledOnce();
    expect(await harness.local.list()).toEqual([]);
  });
});

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readFile,
  writeFile,
  open as openFile,
  rename as renameFile,
  rm as removeFile,
  realpath as realpathFile,
} from 'node:fs/promises';
import type * as AsyncFs from 'node:fs/promises';
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

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof AsyncFs>();
  return {
    ...fs,
    open: vi.fn(fs.open),
    rename: vi.fn(fs.rename),
    rm: vi.fn(fs.rm),
    realpath: vi.fn(fs.realpath),
  };
});
const open = vi.mocked(openFile);
const rename = vi.mocked(renameFile),
  remove = vi.mocked(removeFile);
const nativeRename = rename.getMockImplementation()!,
  nativeRemove = remove.getMockImplementation()!;
const nativeOpen = open.getMockImplementation()!;
const realpath = vi.mocked(realpathFile);
const nativeRealpath = realpath.getMockImplementation()!;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

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

/** Platform-policy model only; the service, durable store and HTTP receipt client
 * remain real. Native Windows runs separately, without replacing its FS. */
describe('bounded Windows authority file publication', () => {
  beforeEach(() =>
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' }),
  );
  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor);
    rename.mockReset().mockImplementation(nativeRename);
    remove.mockReset().mockImplementation(nativeRemove);
    open.mockReset().mockImplementation(nativeOpen);
    realpath.mockReset().mockImplementation(nativeRealpath);
  });

  it.each(
    ['policy', 'journal'].flatMap((scope) =>
      ['EPERM', 'EACCES', 'EBUSY'].map((code) => ({ scope, code })),
    ),
  )(
    'retains one terminal invocation after a $scope rename is explicitly refused once with $code',
    async ({ scope, code }) => {
      let refused: string | undefined;
      rename.mockImplementation(async (from, to) => {
        const path = String(from).replaceAll('\\', '/');
        if (
          !refused &&
          (scope === 'policy'
            ? /\/\.policy\.[^/]+\.tmp$/.test(path)
            : /\/audit-journal\/\.[^/]+\.tmp$/.test(path))
        ) {
          refused = String(from);
          throw Object.assign(new Error('Controlled rename refusal'), { code });
        }
        await nativeRename(from, to);
      });
      const harness = await system({
        operation: 'complete_execution',
        post: 'timeout',
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
      expect(refused).toBeDefined();
      expect(rename.mock.calls.filter(([from]) => String(from) === refused)).toHaveLength(2);
      expect(harness.execute).toHaveBeenCalledOnce();
      expect(harness.remote.records.get(preview.record.planId)).toMatchObject({
        state: 'succeeded',
      });
      const completions = () =>
        vi
          .mocked(harness.remote.transport)
          .mock.calls.filter(
            ([, init]) =>
              init?.method === 'POST' &&
              JSON.parse(String(init.body)).operation === 'complete_execution',
          );
      expect(completions()).toHaveLength(1);
      await expect(harness.service.confirm(request, AUTHORITY)).rejects.toMatchObject({
        code: 'GOVERNED_PLAN_STATE_INVALID',
      });
      expect(harness.execute).toHaveBeenCalledOnce();
      expect(completions()).toHaveLength(1);
      expect(await harness.local.list()).toEqual([]);
    },
  );

  it.each(['temporary', 'target'] as const)(
    'refuses %s drift between refused rename attempts without overwriting foreign bytes',
    async (drift) => {
      let changed: string | undefined;
      rename.mockImplementation(async (from, to) => {
        if (!changed && /[\\/]\.policy\.[^\\/]+\.tmp$/.test(String(from))) {
          changed = String(drift === 'temporary' ? from : to);
          if (drift === 'temporary') await nativeRename(from, `${String(from)}.retained`);
          await writeFile(changed, 'foreign bytes', { flag: 'wx' });
          throw Object.assign(new Error('Controlled rename refusal'), { code: 'EPERM' });
        }
        await nativeRename(from, to);
      });
      await expect(
        system({ operation: 'complete_execution', post: 'timeout', commit: true }),
      ).rejects.toMatchObject(
        drift === 'temporary'
          ? { cause: { code: 'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE' } }
          : { code: 'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT' },
      );
      expect(await readFile(changed!, 'utf8')).toBe('foreign bytes');
      expect(
        rename.mock.calls.filter(([from]) => /[\\/]\.policy\.[^\\/]+\.tmp$/.test(String(from))),
      ).toHaveLength(1);
      expect(remove.mock.calls.some(([path]) => String(path) === changed)).toBe(false);
    },
  );

  it('does not replay an unconfirmed rename that actually moved the inode', async () => {
    let published: string | undefined;
    rename.mockImplementation(async (from, to) => {
      await nativeRename(from, to);
      if (!published && /[\\/]\.policy\.[^\\/]+\.tmp$/.test(String(from))) {
        published = String(to);
        throw Object.assign(new Error('Controlled uncertain rename result'), { code: 'EPERM' });
      }
    });
    await expect(
      system({ operation: 'complete_execution', post: 'timeout', commit: true }),
    ).rejects.toMatchObject({ code: 'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE' });
    expect(JSON.parse(await readFile(published!, 'utf8'))).toMatchObject({
      schema: 'openslack.governed_plan_authority_policy.v1',
    });
    expect(rename.mock.calls.filter(([, to]) => String(to) === published)).toHaveLength(1);
  });

  it('retains the original publication failure when owned cleanup also fails', async () => {
    const primary = Object.assign(new Error('Controlled storage failure'), { code: 'EIO' });
    const secondary = Object.assign(new Error('Controlled cleanup failure'), { code: 'EBUSY' });
    let temporary: string | undefined;
    rename.mockImplementation(async (from, to) => {
      if (/[\\/]\.policy\.[^\\/]+\.tmp$/.test(String(from))) {
        temporary = String(from);
        throw primary;
      }
      await nativeRename(from, to);
    });
    remove.mockImplementation(async (path, options) => {
      if (String(path) === temporary) throw secondary;
      return nativeRemove(path, options);
    });
    await expect(
      system({ operation: 'complete_execution', post: 'timeout', commit: true }),
    ).rejects.toMatchObject({ cause: primary, errors: [primary, secondary] });
    expect(rename.mock.calls.filter(([from]) => String(from) === temporary)).toHaveLength(1);
    expect(await readFile(temporary!, 'utf8')).toContain(
      'openslack.governed_plan_authority_policy.v1',
    );
  });

  it('does not retry or publish after a file synchronization failure', async () => {
    const failure = Object.assign(new Error('Controlled synchronization failure'), {
      code: 'EBUSY',
    });
    let temporary: string | undefined;
    const sync = vi.fn(async () => {
      throw failure;
    });
    open.mockImplementation(async (...args) => {
      const handle = await nativeOpen(...args);
      if (/[\\/]\.policy\.[^\\/]+\.tmp$/.test(String(args[0]))) {
        temporary = String(args[0]);
        vi.spyOn(handle, 'sync').mockImplementation(sync);
      }
      return handle;
    });
    await expect(
      system({ operation: 'complete_execution', post: 'timeout', commit: true }),
    ).rejects.toBe(failure);
    expect(sync).toHaveBeenCalledOnce();
    expect(rename.mock.calls.filter(([from]) => String(from) === temporary)).toHaveLength(0);
    expect(remove.mock.calls.filter(([path]) => String(path) === temporary)).toHaveLength(1);
  });

  it('rechecks temporary ownership after cleanup directory verification', async () => {
    const primary = Object.assign(new Error('Controlled storage failure'), { code: 'EIO' });
    let temporary: string | undefined;
    let replaced = false;
    rename.mockImplementation(async (from, to) => {
      if (/[\\/]\.policy\.[^\\/]+\.tmp$/.test(String(from))) {
        temporary = String(from);
        throw primary;
      }
      await nativeRename(from, to);
    });
    realpath.mockImplementation(async (...args) => {
      const result = await nativeRealpath(...args);
      if (temporary && !replaced) {
        replaced = true;
        await nativeRename(temporary, `${temporary}.retained`);
        await writeFile(temporary, 'foreign cleanup bytes', { flag: 'wx' });
      }
      return result;
    });
    const failure = await system({
      operation: 'complete_execution',
      post: 'timeout',
      commit: true,
    }).then(
      () => undefined,
      (error) => error as unknown,
    );
    expect(replaced).toBe(true);
    expect(await readFile(temporary!, 'utf8')).toBe('foreign cleanup bytes');
    expect(remove.mock.calls.some(([path]) => String(path) === temporary)).toBe(false);
    expect(failure).toMatchObject({ cause: primary });
  });

  it('bounds persistent refusal instead of replaying the caller', async () => {
    let temporary: string | undefined;
    rename.mockImplementation(async (from, to) => {
      if (/[\\/]\.policy\.[^\\/]+\.tmp$/.test(String(from))) {
        temporary = String(from);
        throw Object.assign(new Error('Controlled persistent refusal'), { code: 'EBUSY' });
      }
      await nativeRename(from, to);
    });
    await expect(
      system({ operation: 'complete_execution', post: 'timeout', commit: true }),
    ).rejects.toMatchObject({ code: 'GOVERNED_PLAN_STORE_BUSY' });
    const calls = rename.mock.calls.filter(([from]) => String(from) === temporary);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThan(20);
    expect(remove.mock.calls.filter(([path]) => String(path) === temporary)).toHaveLength(1);
  });
});

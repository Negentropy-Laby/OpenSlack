import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCanonicalGovernedPlan,
  canonicalGovernedJson,
  hashGovernedValue,
  hashOpaqueValue,
  validateGovernedPlanRecord,
  type GovernedPlanRecord,
} from '../governed-plan.js';
import {
  createRoutedGovernedPlanStore,
  registerGovernanceAuthorityGoPort,
  type GovernanceAuthorityGoPort,
  type GovernedPlanAuthorityRoute,
} from '../governed-plan-authority-store.js';
import { LocalGovernedPlanStore } from '../governed-plan-store.js';
import type { GovernedPlanAuditEvent } from '../governed-plan-service.js';

const roots: string[] = [];

function root(): string {
  const value = join(
    tmpdir(),
    `openslack-governance-authority-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(value, { recursive: true });
  roots.push(value);
  return value;
}

function record(suffix = '4000'): GovernedPlanRecord {
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
    planId: `GPLAN-123e4567-e89b-42d3-a456-42661417${suffix}`,
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

function recordInState(state: GovernedPlanRecord['state'], suffix = '4000'): GovernedPlanRecord {
  const initial = record(suffix);
  if (state === 'pending') return initial;
  if (state === 'cancelled' || state === 'expired') {
    return validateGovernedPlanRecord({
      ...initial,
      revision: 2,
      state,
      updatedAt: '2026-08-03T00:16:00.000Z',
    });
  }
  const execution = {
    executionId: 'GEXEC-123e4567-e89b-42d3-a456-426614174099',
    ownerPid: 42,
    startedAt: '2026-08-03T00:01:00.000Z',
    outcomes: [],
  };
  if (state === 'executing') {
    return validateGovernedPlanRecord({
      ...initial,
      revision: 2,
      state,
      updatedAt: '2026-08-03T00:01:00.000Z',
      execution,
    });
  }
  return validateGovernedPlanRecord({
    ...initial,
    revision: 3,
    state,
    updatedAt: '2026-08-03T00:02:00.000Z',
    execution: {
      ...execution,
      completedAt: '2026-08-03T00:02:00.000Z',
    },
  });
}

function goPort(): GovernanceAuthorityGoPort & {
  readonly records: Map<string, GovernedPlanRecord>;
  readonly routes: Map<string, GovernedPlanAuthorityRoute>;
  readonly audits: GovernedPlanAuditEvent[];
} {
  const records = new Map<string, GovernedPlanRecord>();
  const routes = new Map<string, GovernedPlanAuthorityRoute>();
  const audits: GovernedPlanAuditEvent[] = [];
  return registerGovernanceAuthorityGoPort({
    records,
    routes,
    audits,
    async accept(value, route) {
      records.set(value.planId, value);
      routes.set(value.planId, route);
      return value;
    },
    async load(planId, route) {
      if (routes.has(planId)) expect(route).toEqual(routes.get(planId));
      return records.get(planId) ?? null;
    },
    async transition(_operation, target, _expectedRevision, route) {
      expect(route).toEqual(routes.get(target.planId));
      records.set(target.planId, target);
      return target;
    },
    async pendingAudit() {
      return null;
    },
    async recordAudit(event) {
      audits.push(event);
    },
  });
}

function auditEvent(value: GovernedPlanRecord, suffix = '4000'): GovernedPlanAuditEvent {
  return Object.freeze({
    schema: 'openslack.governed_plan_audit.v1',
    eventId: `GAUDIT-123e4567-e89b-42d3-a456-42661417${suffix}`,
    type: 'plan.previewed',
    occurredAt: '2026-08-03T00:00:00.000Z',
    planId: value.planId,
    kind: value.canonicalPlan.kind,
    actorId: value.bindings.actorId,
    workspaceId: value.bindings.workspaceId,
    correlationId: value.bindings.correlationId,
    state: value.state,
    revision: value.revision,
    evidenceRefs: Object.freeze([]),
  });
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('routed governed plan store', () => {
  it('freezes Go per-record routing and never writes a Go plan to the local store', async () => {
    const workspace = root();
    const local = new LocalGovernedPlanStore(join(workspace, 'local'));
    const go = goPort();
    const store = await createRoutedGovernedPlanStore({
      routeRoot: join(workspace, 'routes'),
      localStore: local,
      backend: 'go',
      routingEpoch: 7,
      go,
      now: () => new Date('2026-08-03T00:00:00.000Z'),
    });
    const value = record();

    expect(await store.create(value)).toEqual(value);
    expect(await local.load(value.planId)).toBeNull();
    expect(go.routes.get(value.planId)).toEqual({
      backend: 'go',
      routingEpoch: 7,
      authority: 'governance-control',
    });
  });

  it('uses a higher epoch only for new records and keeps old Go records on Go', async () => {
    const workspace = root();
    const local = new LocalGovernedPlanStore(join(workspace, 'local'));
    const go = goPort();
    const first = await createRoutedGovernedPlanStore({
      routeRoot: join(workspace, 'routes'),
      localStore: local,
      backend: 'go',
      routingEpoch: 7,
      go,
    });
    const old = await first.create(record('4000'));
    const rollback = await createRoutedGovernedPlanStore({
      routeRoot: join(workspace, 'routes'),
      localStore: local,
      backend: 'ts-local',
      routingEpoch: 8,
      go,
    });
    const fresh = record('4002');

    expect(await rollback.load(old.planId)).toEqual(old);
    expect(await rollback.create(fresh)).toEqual(fresh);
    expect(await local.load(fresh.planId)).toEqual(fresh);
    expect(go.records.has(fresh.planId)).toBe(false);
  });

  it('keeps legacy route-less local records local and rejects epoch rollback', async () => {
    const workspace = root();
    const local = new LocalGovernedPlanStore(join(workspace, 'local'));
    const legacy = await local.create(record());
    const go = goPort();
    const routed = await createRoutedGovernedPlanStore({
      routeRoot: join(workspace, 'routes'),
      localStore: local,
      backend: 'go',
      routingEpoch: 9,
      go,
    });

    expect(await routed.load(legacy.planId)).toEqual(legacy);
    expect(go.records.has(legacy.planId)).toBe(false);
    await expect(
      createRoutedGovernedPlanStore({
        routeRoot: join(workspace, 'routes'),
        localStore: local,
        backend: 'ts-local',
        routingEpoch: 8,
        go,
      }),
    ).rejects.toMatchObject({ code: 'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT' });
  });

  it('never falls back to a local record when Go durable acceptance fails', async () => {
    const workspace = root();
    const local = new LocalGovernedPlanStore(join(workspace, 'local'));
    const go = goPort();
    go.accept = async () => {
      throw new Error('go authority unavailable');
    };
    const routed = await createRoutedGovernedPlanStore({
      routeRoot: join(workspace, 'routes'),
      localStore: local,
      backend: 'go',
      routingEpoch: 10,
      go,
    });
    const value = record();

    await expect(routed.create(value)).rejects.toThrow('go authority unavailable');
    expect(await local.load(value.planId)).toBeNull();
  });

  it('fails closed if a Go-routed identity also appears in the local record store', async () => {
    const workspace = root();
    const local = new LocalGovernedPlanStore(join(workspace, 'local'));
    const go = goPort();
    const routed = await createRoutedGovernedPlanStore({
      routeRoot: join(workspace, 'routes'),
      localStore: local,
      backend: 'go',
      routingEpoch: 11,
      go,
    });
    const value = await routed.create(record());
    await local.create(value);

    await expect(routed.load(value.planId)).rejects.toMatchObject({
      code: 'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
    });
  });

  it('uses bounded Go epoch history to reject a local duplicate after route-index loss', async () => {
    const workspace = root();
    const routeRoot = join(workspace, 'routes');
    const local = new LocalGovernedPlanStore(join(workspace, 'local'));
    const go = goPort();
    const goAuthority = await createRoutedGovernedPlanStore({
      routeRoot,
      localStore: local,
      backend: 'go',
      routingEpoch: 12,
      go,
    });
    const value = await goAuthority.create(record());
    const routeFiles = readdirSync(join(routeRoot, 'routes'));
    expect(routeFiles).toHaveLength(1);
    rmSync(join(routeRoot, 'routes', routeFiles[0]!));

    const rollback = await createRoutedGovernedPlanStore({
      routeRoot,
      localStore: local,
      backend: 'ts-local',
      routingEpoch: 13,
      go,
    });

    await expect(rollback.create(value)).rejects.toMatchObject({
      code: 'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
    });
    expect(await local.load(value.planId)).toBeNull();
  });

  it('fails closed when a lost route index cannot be checked against prior Go epochs', async () => {
    const workspace = root();
    const routeRoot = join(workspace, 'routes');
    const local = new LocalGovernedPlanStore(join(workspace, 'local'));
    const go = goPort();
    const goAuthority = await createRoutedGovernedPlanStore({
      routeRoot,
      localStore: local,
      backend: 'go',
      routingEpoch: 14,
      go,
    });
    const value = await goAuthority.create(record());
    const routeFiles = readdirSync(join(routeRoot, 'routes'));
    expect(routeFiles).toHaveLength(1);
    rmSync(join(routeRoot, 'routes', routeFiles[0]!));

    await expect(
      createRoutedGovernedPlanStore({
        routeRoot,
        localStore: local,
        backend: 'ts-local',
        routingEpoch: 15,
      }),
    ).rejects.toMatchObject({
      code: 'GOVERNED_PLAN_AUTHORITY_TRANSPORT_UNAVAILABLE',
    });
    expect(await local.load(value.planId)).toBeNull();

    await expect(
      createRoutedGovernedPlanStore({
        routeRoot,
        localStore: local,
        backend: 'ts-local',
        routingEpoch: 15,
        go,
      }),
    ).resolves.toBeDefined();
  });

  it('recovers one missing Go sidecar for a terminal record and rejects multiple epoch owners', async () => {
    const workspace = root();
    const routeRoot = join(workspace, 'routes');
    const local = new LocalGovernedPlanStore(join(workspace, 'local'));
    const go = goPort();
    const authority = await createRoutedGovernedPlanStore({
      routeRoot,
      localStore: local,
      backend: 'go',
      routingEpoch: 16,
      go,
    });
    const created = await authority.create(record());
    const routeName = readdirSync(join(routeRoot, 'routes'))[0]!;
    rmSync(join(routeRoot, 'routes', routeName));
    const terminal = await authority.cancel({
      planId: created.planId,
      expectedRevision: 1,
      updatedAt: '2026-08-03T00:01:00.000Z',
    });
    expect(readdirSync(join(routeRoot, 'routes'))).toEqual([routeName]);
    rmSync(join(routeRoot, 'routes', routeName));

    await expect(authority.load(created.planId)).resolves.toEqual(terminal);
    expect(readdirSync(join(routeRoot, 'routes'))).toEqual([routeName]);
    expect(await local.load(created.planId)).toBeNull();

    rmSync(join(routeRoot, 'routes', routeName));
    const originalLoad = go.load.bind(go);
    go.load = vi.fn(async (planId, route) =>
      planId === created.planId && (route.routingEpoch === 16 || route.routingEpoch === 17)
        ? terminal
        : originalLoad(planId, route),
    );
    const epoch17 = await createRoutedGovernedPlanStore({
      routeRoot,
      localStore: local,
      backend: 'go',
      routingEpoch: 17,
      go,
    });
    await expect(epoch17.load(created.planId)).rejects.toMatchObject({
      code: 'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
    });
  });

  it('durably redelivers a prepared audit with the same event ID after restart', async () => {
    const workspace = root();
    const routeRoot = join(workspace, 'routes');
    const local = new LocalGovernedPlanStore(join(workspace, 'local'));
    const go = goPort();
    const first = await createRoutedGovernedPlanStore({
      routeRoot,
      localStore: local,
      backend: 'go',
      routingEpoch: 18,
      go,
      now: () => new Date('2026-08-03T00:00:00.000Z'),
    });
    const value = await first.create(record());
    const event = auditEvent(value);
    const routeName = readdirSync(join(routeRoot, 'routes'))[0]!;
    rmSync(join(routeRoot, 'routes', routeName));
    await first.prepareAudit?.(event);
    expect(readdirSync(join(routeRoot, 'routes'))).toEqual([routeName]);
    const collaboration = [event];

    const restarted = await createRoutedGovernedPlanStore({
      routeRoot,
      localStore: local,
      backend: 'go',
      routingEpoch: 18,
      go,
      now: () => new Date('2026-08-03T00:01:00.000Z'),
    });
    await restarted.recoverAudits?.((replayed) => {
      collaboration.push(replayed);
    });

    expect(collaboration.map((item) => item.eventId)).toEqual([event.eventId, event.eventId]);
    expect(go.audits).toEqual([event]);
    expect(readdirSync(join(routeRoot, 'audit-journal'))).toEqual([]);
  });

  it('recovers a Go-committed pending audit that crashed before any local journal existed', async () => {
    const workspace = root();
    const routeRoot = join(workspace, 'routes');
    const local = new LocalGovernedPlanStore(join(workspace, 'local'));
    const go = goPort();
    const first = await createRoutedGovernedPlanStore({
      routeRoot,
      localStore: local,
      backend: 'go',
      routingEpoch: 20,
      go,
      now: () => new Date('2026-08-03T00:00:00.000Z'),
    });
    const value = await first.create(record());
    expect(readdirSync(join(routeRoot, 'audit-journal'))).toEqual([]);
    let pending = true;
    go.pendingAudit = vi.fn(async (planId, revision, route) => {
      expect({ planId, revision, route }).toEqual({
        planId: value.planId,
        revision: value.revision,
        route: { backend: 'go', routingEpoch: 20, authority: 'governance-control' },
      });
      return pending
        ? {
            operation: 'accept' as const,
            recordHash: createHash('sha256')
              .update(`${canonicalGovernedJson(value)}\n`, 'utf8')
              .digest('hex'),
          }
        : null;
    });
    const originalAck = go.recordAudit.bind(go);
    go.recordAudit = vi.fn(async (event, route) => {
      await originalAck(event, route);
      pending = false;
    });

    const restarted = await createRoutedGovernedPlanStore({
      routeRoot,
      localStore: local,
      backend: 'go',
      routingEpoch: 20,
      go,
      now: () => new Date('2026-08-03T00:01:00.000Z'),
    });
    const collaboration: GovernedPlanAuditEvent[] = [];
    await restarted.recoverAudits?.((event) => {
      collaboration.push(event);
    });

    expect(collaboration).toHaveLength(1);
    expect(collaboration[0]).toMatchObject({
      type: 'plan.previewed',
      planId: value.planId,
      revision: 1,
      details: {
        planHash: value.bindings.planHash,
        actionCount: 1,
        effectCount: 1,
      },
    });
    expect(go.audits).toEqual(collaboration);
    expect(readdirSync(join(routeRoot, 'audit-journal'))).toEqual([]);

    const noDuplicate = vi.fn();
    await restarted.recoverAudits?.(noDuplicate);
    expect(noDuplicate).not.toHaveBeenCalled();
    expect(go.pendingAudit).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      operation: 'claim_execution' as const,
      state: 'executing' as const,
      type: 'plan.confirmed',
      details: { executionId: 'GEXEC-123e4567-e89b-42d3-a456-426614174099' },
    },
    {
      operation: 'complete_execution' as const,
      state: 'succeeded' as const,
      type: 'plan.execution_completed',
    },
    {
      operation: 'complete_execution' as const,
      state: 'blocked' as const,
      type: 'plan.execution_blocked',
    },
    {
      operation: 'complete_execution' as const,
      state: 'failed' as const,
      type: 'plan.execution_failed',
    },
    {
      operation: 'cancel' as const,
      state: 'cancelled' as const,
      type: 'plan.cancelled',
    },
    {
      operation: 'expire' as const,
      state: 'expired' as const,
      type: 'plan.expired',
    },
    {
      operation: 'require_reconciliation' as const,
      state: 'reconciliation_required' as const,
      type: 'plan.reconciliation_required',
    },
  ])(
    'maps pending $operation and $state to $type during pre-journal recovery',
    async ({ operation, state, type, details }) => {
      const workspace = root();
      const routeRoot = join(workspace, 'routes');
      const local = new LocalGovernedPlanStore(join(workspace, 'local'));
      const go = goPort();
      const store = await createRoutedGovernedPlanStore({
        routeRoot,
        localStore: local,
        backend: 'go',
        routingEpoch: 21,
        go,
        now: () => new Date('2026-08-03T00:03:00.000Z'),
      });
      const initial = await store.create(record());
      const target = recordInState(state);
      go.records.set(initial.planId, target);
      go.pendingAudit = vi.fn(async () => ({
        operation,
        recordHash: createHash('sha256')
          .update(`${canonicalGovernedJson(target)}\n`, 'utf8')
          .digest('hex'),
      }));
      const collaboration: GovernedPlanAuditEvent[] = [];

      await store.recoverAudits?.((event) => {
        collaboration.push(event);
      });

      expect(collaboration).toHaveLength(1);
      expect(collaboration[0]).toMatchObject({
        type,
        state,
        revision: target.revision,
        ...(details === undefined ? {} : { details }),
      });
      expect(go.audits).toEqual(collaboration);
      expect(readdirSync(join(routeRoot, 'audit-journal'))).toEqual([]);
    },
  );

  it.each([
    {
      name: 'operation and state mismatch',
      state: 'cancelled' as const,
      operation: 'claim_execution' as const,
      recordHash: 'exact' as const,
    },
    {
      name: 'completion cannot stand in for reconciliation',
      state: 'reconciliation_required' as const,
      operation: 'complete_execution' as const,
      recordHash: 'exact' as const,
    },
    {
      name: 'record hash mismatch',
      state: 'pending' as const,
      operation: 'accept' as const,
      recordHash: 'mismatch' as const,
    },
  ])('fails closed on invalid pending audit $name', async ({ state, operation, recordHash }) => {
    const workspace = root();
    const routeRoot = join(workspace, 'routes');
    const local = new LocalGovernedPlanStore(join(workspace, 'local'));
    const go = goPort();
    const store = await createRoutedGovernedPlanStore({
      routeRoot,
      localStore: local,
      backend: 'go',
      routingEpoch: 22,
      go,
    });
    const initial = await store.create(record());
    const target = recordInState(state);
    go.records.set(initial.planId, target);
    go.pendingAudit = vi.fn(async () => ({
      operation,
      recordHash:
        recordHash === 'exact'
          ? createHash('sha256')
              .update(`${canonicalGovernedJson(target)}\n`, 'utf8')
              .digest('hex')
          : '0'.repeat(64),
    }));
    const collaboration = vi.fn();

    await expect(store.recoverAudits?.(collaboration)).rejects.toMatchObject({
      code: 'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
    });
    expect(collaboration).not.toHaveBeenCalled();
    expect(go.audits).toEqual([]);
  });

  it('restarts from collaboration_recorded without duplicating the collaboration append', async () => {
    const workspace = root();
    const routeRoot = join(workspace, 'routes');
    const local = new LocalGovernedPlanStore(join(workspace, 'local'));
    const go = goPort();
    const first = await createRoutedGovernedPlanStore({
      routeRoot,
      localStore: local,
      backend: 'go',
      routingEpoch: 19,
      go,
      now: () => new Date('2026-08-03T00:00:00.000Z'),
    });
    const value = await first.create(record());
    const event = auditEvent(value);
    await first.prepareAudit?.(event);
    const originalAck = go.recordAudit.bind(go);
    let firstAck = true;
    go.recordAudit = vi.fn(async (candidate, route) => {
      if (firstAck) {
        firstAck = false;
        throw new Error('lost acknowledgement');
      }
      await originalAck(candidate, route);
    });
    await expect(first.recordAudit?.(event)).rejects.toThrow('lost acknowledgement');

    const restarted = await createRoutedGovernedPlanStore({
      routeRoot,
      localStore: local,
      backend: 'go',
      routingEpoch: 19,
      go,
      now: () => new Date('2026-08-03T00:01:00.000Z'),
    });
    const collaboration = vi.fn();
    await restarted.recoverAudits?.(collaboration);

    expect(collaboration).not.toHaveBeenCalled();
    expect(go.audits).toEqual([event]);
    expect(readdirSync(join(routeRoot, 'audit-journal'))).toEqual([]);
  });

  it('queries only the current terminal revision during pending-audit recovery', async () => {
    const workspace = root();
    const local = new LocalGovernedPlanStore(join(workspace, 'local'));
    const go = goPort();
    const store = await createRoutedGovernedPlanStore({
      routeRoot: join(workspace, 'routes'),
      localStore: local,
      backend: 'go',
      routingEpoch: 23,
      go,
    });
    const initial = await store.create(record());
    go.records.set(initial.planId, recordInState('succeeded'));
    go.pendingAudit = vi.fn(async (planId, revision, route) => {
      expect({ planId, revision, route }).toEqual({
        planId: initial.planId,
        revision: 3,
        route: { backend: 'go', routingEpoch: 23, authority: 'governance-control' },
      });
      return null;
    });

    await store.recoverAudits?.(vi.fn());

    expect(go.pendingAudit).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'unknown sidecar name', directory: 'routes', file: 'unknown.txt', bytes: '{}\n' },
    {
      name: 'damaged journal body',
      directory: 'audit-journal',
      file: `${'a'.repeat(64)}.json`,
      bytes: '{"schema":"damaged"}\n',
    },
  ])('fails closed on $name', async ({ directory, file, bytes }) => {
    const workspace = root();
    const routeRoot = join(workspace, 'routes');
    const store = await createRoutedGovernedPlanStore({
      routeRoot,
      localStore: new LocalGovernedPlanStore(join(workspace, 'local')),
      backend: 'ts-local',
      routingEpoch: 1,
    });
    writeFileSync(join(routeRoot, directory, file), bytes, 'utf8');

    await expect(store.recoverAudits?.(vi.fn())).rejects.toMatchObject({
      code: 'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
    });
  });

  it('fails closed on a damaged route sidecar body', async () => {
    const workspace = root();
    const routeRoot = join(workspace, 'routes');
    const store = await createRoutedGovernedPlanStore({
      routeRoot,
      localStore: new LocalGovernedPlanStore(join(workspace, 'local')),
      backend: 'go',
      routingEpoch: 24,
      go: goPort(),
    });
    const value = await store.create(record());
    const sidecar = join(
      routeRoot,
      'routes',
      `${createHash('sha256').update(value.planId, 'utf8').digest('hex')}.json`,
    );
    writeFileSync(sidecar, '{"schema":"damaged"}\n', 'utf8');

    await expect(store.load(value.planId)).rejects.toMatchObject({
      code: 'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
    });
  });

  it('fails closed on a symlinked journal entry', async () => {
    const workspace = root();
    const routeRoot = join(workspace, 'routes');
    const store = await createRoutedGovernedPlanStore({
      routeRoot,
      localStore: new LocalGovernedPlanStore(join(workspace, 'local')),
      backend: 'ts-local',
      routingEpoch: 1,
    });
    const target = join(workspace, process.platform === 'win32' ? 'outside' : 'outside.json');
    if (process.platform === 'win32') mkdirSync(target);
    else writeFileSync(target, '{}\n', 'utf8');
    symlinkSync(
      target,
      join(routeRoot, 'audit-journal', `${'b'.repeat(64)}.json`),
      process.platform === 'win32' ? 'junction' : 'file',
    );

    await expect(store.recoverAudits?.(vi.fn())).rejects.toMatchObject({
      code: 'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
    });
  });

  it('rejects 4,097 route sidecars before any point lookup', async () => {
    const workspace = root();
    const routeRoot = join(workspace, 'routes');
    const go = goPort();
    const store = await createRoutedGovernedPlanStore({
      routeRoot,
      localStore: new LocalGovernedPlanStore(join(workspace, 'local')),
      backend: 'go',
      routingEpoch: 25,
      go,
    });
    const pendingAudit = vi.spyOn(go, 'pendingAudit');
    for (let index = 0; index < 4_097; index += 1) {
      writeFileSync(
        join(routeRoot, 'routes', `${index.toString(16).padStart(64, '0')}.json`),
        '{}\n',
        'utf8',
      );
    }

    await expect(store.recoverAudits?.(vi.fn())).rejects.toMatchObject({
      code: 'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
    });
    expect(pendingAudit).not.toHaveBeenCalled();
  }, 90_000);

  it('keeps ts-local audit journaling empty and detects directory replacement after binding', async () => {
    const workspace = root();
    const routeRoot = join(workspace, 'routes');
    const local = new LocalGovernedPlanStore(join(workspace, 'local'));
    const store = await createRoutedGovernedPlanStore({
      routeRoot,
      localStore: local,
      backend: 'ts-local',
      routingEpoch: 1,
    });
    const value = await store.create(record());
    const event = auditEvent(value);
    await store.prepareAudit?.(event);
    await store.recordAudit?.(event);
    const recovered = vi.fn();
    await store.recoverAudits?.(recovered);
    expect(recovered).not.toHaveBeenCalled();
    expect(readdirSync(join(routeRoot, 'audit-journal'))).toEqual([]);

    renameSync(join(routeRoot, 'routes'), join(routeRoot, 'routes-original'));
    mkdirSync(join(routeRoot, 'routes'));
    await expect(store.load(value.planId)).rejects.toMatchObject({
      code: 'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
    });
  });
});

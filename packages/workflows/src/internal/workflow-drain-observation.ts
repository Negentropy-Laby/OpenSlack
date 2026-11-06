import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { closedDataRecord } from './contract-validation.js';
import {
  validateWorkflowBindingSettlement,
  parseWorkflowBindingSettlement,
} from '../workflow-binding-reconciliation-contract.js';
import type { WorkflowControlAuthorityPort } from '../workflow-control-authority-client.js';
import type { WorkflowControlAuthorityRoute } from '../workflow-control-authority-contract.js';
import {
  canonicalWorkflowControlAuthorityJson as canonical,
  validateWorkflowControlAuthorityRoute,
} from '../workflow-control-authority-contract.js';
import {
  exactWorkflowRunnerLoopbackOrigin,
  readWorkflowRunnerResponseBytes,
} from '../workflow-runner-control-http.js';
import { readWorkflowEffectAuthorityDrain } from '../workflow-effect-authority-store.js';
import { resolveWorkflowEffectApprovalRoot } from './workflow-effect-approval-layout.js';
import { parseWorkflowEffectJson } from '../workflow-effect-json.js';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { readWorkflowRunnerV2EffectDrain } from '../workflow-runner-v2-effect-authorization.js';
import { createWorkflowRunnerAuthorityBindingClient } from '../workflow-runner-authority-binding-client.js';
import {
  readRecoveryBinding,
  type WorkflowRunRecoveryEvidence,
} from '../workflow-run-recovery-evidence.js';

export interface WorkflowDrainSnapshot {
  readonly admissionClosed: boolean;
  readonly activeRuns: number;
  readonly pendingEffects: number;
  readonly openReservations: number;
  readonly reconciliationRequired: number;
  readonly authorityConsistent: boolean;
  readonly runnerDrained: boolean;
  readonly outboxDrained: boolean;
}
type Plane = 'authority' | 'runner' | 'budget';
const COUNTERS = {
  authority: ['active_runs', 'outbox_pending', 'reconciliation_required'],
  runner: ['runner_jobs', 'runner_leases', 'runner_work', 'reconciliation_required'],
  budget: ['open_reservations', 'reconciliation_required'],
} as const;
interface Connection {
  readonly origin: string;
  readonly bearerToken: string;
  readonly callerId: string;
  readonly buildHash: string;
}
const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const invalid = (): never => {
  throw new Error('WORKFLOW_DRAIN_EVIDENCE_UNAVAILABLE');
};

/** Strict current-gauge parser. No absent, duplicate, malformed, or foreign metric becomes zero. */
export function parseWorkflowDrainMetrics(
  bytes: string,
  plane: Plane,
  workspaceId: string,
  epoch: number,
  build: string,
): Readonly<Record<string, number>> {
  const labels = `{workspace_id=${JSON.stringify(workspaceId)},routing_epoch=${JSON.stringify(String(epoch))},build_sha=${JSON.stringify(build)},plane=${JSON.stringify(plane)}}`;
  const names = ['scope', ...COUNTERS[plane]];
  const result: Record<string, number> = {};
  for (const line of bytes.trimEnd().split('\n')) {
    if (line.startsWith('#')) continue;
    const i = line.indexOf('{');
    const close = line.indexOf('}');
    if (
      i < 0 ||
      close < 0 ||
      line.slice(i, close + 1) !== labels ||
      !line.startsWith('openslack_drain_')
    )
      return invalid();
    const name = line.slice('openslack_drain_'.length, i);
    const raw = line.slice(close + 2);
    if (
      line[close + 1] !== ' ' ||
      !names.includes(name as never) ||
      Object.hasOwn(result, name) ||
      !/^(0|[1-9][0-9]*)$/u.test(raw)
    )
      return invalid();
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) return invalid();
    result[name] = value;
  }
  if (Object.keys(result).length !== names.length || result.scope !== 1) return invalid();
  return Object.freeze(result);
}

/** Read-only proof of a committed effect; never grants a current execution lease. */
export function assertWorkflowDrainCommit(
  view: WorkflowRunRecoveryEvidence,
  evidence: unknown,
  operation: 'effect_authorize' | 'effect_complete',
): void {
  let count = 0;
  for (const entry of view.bindings) {
    const parsed = readRecoveryBinding(view, entry);
    if (
      parsed.stage.operation === operation &&
      parsed.resolution &&
      canonical(parsed.resolution.evidence) === canonical(evidence)
    ) {
      if (entry.state !== 'completed') {
        const matches = view.settlements?.filter((s) => s.bindingId === entry.bindingId) ?? [];
        if (matches.length !== 1 || matches[0]!.outcome !== 'committed') return invalid();
        const settlement = parseWorkflowBindingSettlement(canonical(matches[0]) + '\n');
        validateWorkflowBindingSettlement(settlement, parsed.stage, entry.resolution);
      }
      count++;
    }
  }
  if (count !== 1) return invalid();
}

/** Source composition is host-owned; only authenticated loopback read endpoints are accepted. */
export function createWorkflowDrainObserver(supplied: {
  workspaceRoot: string;
  workspaceId: string;
  route: WorkflowControlAuthorityRoute;
  authority: Connection;
  runner: Connection;
  budget: Connection;
  authorityClient: WorkflowControlAuthorityPort;
  fetch?: typeof fetch;
}): { read(signal: AbortSignal): Promise<WorkflowDrainSnapshot>; evidence(): readonly string[] } {
  const own = (value: unknown, fields: readonly string[], optionalFields: readonly string[] = []) =>
    closedDataRecord(
      value,
      fields,
      'drain',
      { inert: invalid, missing: invalid, unknown: invalid, dataField: invalid },
      { optionalFields },
    );
  const raw = own(
    supplied,
    ['workspaceRoot', 'workspaceId', 'route', 'authority', 'runner', 'budget', 'authorityClient'],
    ['fetch'],
  );
  const connection = (value: unknown): Readonly<Connection> => {
    const c = own(value, ['origin', 'bearerToken', 'callerId', 'buildHash']);
    if (Object.values(c).some((v) => typeof v !== 'string' || !v.length || /[\r\n]/u.test(v)))
      return invalid();
    return Object.freeze({ ...c }) as unknown as Readonly<Connection>;
  };
  const client = raw.authorityClient;
  if (client === null || typeof client !== 'object' || nodeTypes.isProxy(client)) return invalid();
  let read: WorkflowControlAuthorityPort['read'] | undefined;
  for (let object: object | null = client; object; object = Object.getPrototypeOf(object)) {
    if (nodeTypes.isProxy(object)) return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(object, 'read');
    if (descriptor) {
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function')
        return invalid();
      read = descriptor.value.bind(client) as WorkflowControlAuthorityPort['read'];
      break;
    }
  }
  if (
    !read ||
    typeof raw.workspaceRoot !== 'string' ||
    typeof raw.workspaceId !== 'string' ||
    (raw.fetch !== undefined && typeof raw.fetch !== 'function')
  )
    return invalid();
  const route = own(raw.route, ['backend', 'authority', 'routingEpoch', 'authorityBuildHash']);
  const input = Object.freeze({
    workspaceRoot: raw.workspaceRoot,
    workspaceId: raw.workspaceId,
    route: Object.freeze(validateWorkflowControlAuthorityRoute({ ...route }, 'drain/route')),
    authority: connection(raw.authority),
    runner: connection(raw.runner),
    budget: connection(raw.budget),
    authorityClient: Object.freeze({ read }),
    fetch: (raw.fetch ?? fetch) as typeof fetch,
  });
  const connections = Object.freeze({
    authority: input.authority,
    runner: input.runner,
    budget: input.budget,
  });
  for (const connection of Object.values(connections)) {
    if (
      exactWorkflowRunnerLoopbackOrigin(connection.origin, invalid, {
        invalid: 'drain origin',
        nonLoopback: 'drain origin',
      }) !== connection.origin ||
      !/^[a-f0-9]{64}$/u.test(connection.buildHash)
    )
      return invalid();
  }
  if (
    input.route.backend !== 'go' ||
    input.route.authority !== 'workflow-control' ||
    input.authority.buildHash !== input.route.authorityBuildHash
  )
    return invalid();
  const proofs: string[] = [];
  const get = async (plane: Plane, path: string, signal: AbortSignal, contentType: string) => {
    signal.throwIfAborted();
    const c = connections[plane];
    const headers: Record<string, string> = { Authorization: `Bearer ${c.bearerToken}` };
    if (plane === 'runner') headers['X-OpenSlack-Workspace-ID'] = input.workspaceId;
    else {
      const prefix =
        plane === 'authority' ? 'X-OpenSlack-Workflow-Control-' : 'X-OpenSlack-Workflow-Budget-';
      headers[prefix + 'Workspace-ID'] = input.workspaceId;
      headers[prefix + 'Caller-ID'] = c.callerId;
      headers[prefix + 'Routing-Epoch'] = String(input.route.routingEpoch);
      headers[prefix + 'Expected-Build-SHA'] = c.buildHash;
    }
    const response = await (input.fetch ?? fetch)(c.origin + path, {
      headers,
      signal,
      redirect: 'error',
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return invalid();
    }
    const bytes = await readWorkflowRunnerResponseBytes(response, {
      signal,
      maxBytes: 64 * 1024,
      minimumBytes: 1,
      validateContentLength: true,
      acceptedContentTypes:
        contentType === 'text/plain' ? ['text/plain', 'text/plain; version=0.0.4'] : [contentType],
      failure: invalid,
      messages: {
        contentType: 'drain_invalid',
        contentLength: 'drain_invalid',
        missingBody: 'drain_unavailable',
        readFailed: 'drain_unavailable',
        exceeded: 'drain_invalid',
        empty: 'drain_invalid',
        lengthMismatch: 'drain_invalid',
        aborted: 'drain_cancelled',
      },
    });
    return bytes;
  };
  const binding = async (signal: AbortSignal) => {
    const bytes = await get(
      'authority',
      '/v1/workflow-control/binding',
      signal,
      'application/json',
    );
    const value = parseWorkflowEffectJson(bytes) as Record<string, unknown>;
    if (
      !value ||
      value.schema !== 'openslack.workflow_control_authority_binding.v1' ||
      value.workspaceId !== input.workspaceId ||
      value.buildSha !== input.route.authorityBuildHash ||
      value.activeRoutingEpoch !== input.route.routingEpoch ||
      value.callerId !== input.authority.callerId ||
      typeof value.acceptNewRecords !== 'boolean' ||
      value.mode !== 'new-record-canary-v1'
    )
      return invalid();
    return value;
  };
  const metrics = async (signal: AbortSignal) => {
    const query = `/metrics?drainWorkspace=${encodeURIComponent(input.workspaceId)}&drainEpoch=${input.route.routingEpoch}`;
    const rows = await Promise.all(
      (['authority', 'runner', 'budget'] as const).map(
        async (plane) =>
          [
            plane,
            parseWorkflowDrainMetrics(
              new TextDecoder('utf-8', { fatal: true }).decode(
                await get(plane, query, signal, 'text/plain'),
              ),
              plane,
              input.workspaceId,
              input.route.routingEpoch,
              connections[plane].buildHash,
            ),
          ] as const,
      ),
    );
    return Object.fromEntries(rows) as Record<Plane, Readonly<Record<string, number>>>;
  };
  return Object.freeze({
    async read(signal: AbortSignal) {
      try {
        const before = await binding(signal);
        const first = await metrics(signal);
        const approvalRoot = resolveWorkflowEffectApprovalRoot(input.workspaceRoot);
        const legacyRoot = join(input.workspaceRoot, '.openslack.local/workflows/effect-authority');
        let legacy:
          | {
              pendingEffects: number;
              reconciliationRequired: number;
              evidenceHash: string;
              approvalScopes: readonly string[];
            }
          | undefined;
        let legacyPresent = false;
        try {
          await lstat(legacyRoot);
          legacyPresent = true;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        if (legacyPresent)
          legacy = await readWorkflowEffectAuthorityDrain({
            approvalRoot,
            workspaceId: input.workspaceId,
            controlBuildHash: input.runner.buildHash,
            signal,
            assertRunScope: async (record) => {
              const head = await input.authorityClient.read(record.runId, input.route, signal);
              if (
                head.workflowSourceHash !== record.workflowSourceHash ||
                head.manifestHash !== record.manifestHash ||
                head.inputHash !== record.inputHash ||
                canonical(head.route) !== canonical(input.route)
              )
                return invalid();
            },
          });
        const recovery = createWorkflowRunnerAuthorityBindingClient({
          origin: input.runner.origin,
          workspaceId: input.workspaceId,
          bearerToken: input.runner.bearerToken,
        });
        const d2 = await readWorkflowRunnerV2EffectDrain({
          workspaceRoot: input.workspaceRoot,
          workspaceId: input.workspaceId,
          authorityBuildHash: input.route.authorityBuildHash,
          signal,
          legacyApprovalScopes: legacy?.approvalScopes,
          readRun: async (runId) => {
            const head = await input.authorityClient.read(runId, input.route, signal);
            if (
              head.workspaceId !== input.workspaceId ||
              canonical(head.route) !== canonical(input.route)
            )
              return invalid();
            return head;
          },
          assertCommitted: async (runId, evidence, operation) => {
            const view = await recovery.readRecoveryEvidence(runId, undefined, signal);
            if (
              !view.complete ||
              view.workspaceId !== input.workspaceId ||
              canonical(view.route) !== canonical(input.route)
            )
              return invalid();
            assertWorkflowDrainCommit(view, evidence, operation);
          },
        });
        const second = await metrics(signal);
        const after = await binding(signal);
        if (canonical(before) !== canonical(after)) return invalid();
        signal.throwIfAborted();
        const count = (plane: Plane, name: string) =>
          Math.max(first[plane][name]!, second[plane][name]!);
        const snapshot = {
          admissionClosed: before.acceptNewRecords === false,
          activeRuns: count('authority', 'active_runs'),
          pendingEffects: d2.pendingEffects + (legacy?.pendingEffects ?? 0),
          openReservations: count('budget', 'open_reservations'),
          reconciliationRequired:
            d2.reconciliationRequired +
            (legacy?.reconciliationRequired ?? 0) +
            count('authority', 'reconciliation_required') +
            count('runner', 'reconciliation_required') +
            count('budget', 'reconciliation_required'),
          authorityConsistent: true,
          runnerDrained: ['runner_jobs', 'runner_leases', 'runner_work'].every(
            (n) => count('runner', n) === 0,
          ),
          outboxDrained: count('authority', 'outbox_pending') === 0,
        };
        if (proofs.length >= 40) return invalid();
        proofs.push(digest({ binding: before, first, second, d2: d2.evidenceHash, snapshot }));
        return Object.freeze(snapshot);
      } catch {
        return invalid();
      }
    },
    evidence: () => Object.freeze([...proofs]),
  });
}

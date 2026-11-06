import { rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  testTemporaryDirectory,
  platformTestTimeout,
} from '../../../../scripts/testing/process-fixture.mjs';
import {
  createWorkflowDrainObserver,
  assertWorkflowDrainCommit,
  parseWorkflowDrainMetrics,
} from '../internal/workflow-drain-observation.js';
import type { WorkflowControlAuthorityPort } from '../workflow-control-authority-client.js';
import { prepareWorkflowBindingReconciliation } from '../workflow-binding-reconciliation-contract.js';
import type { WorkflowRunRecoveryEvidence } from '../workflow-run-recovery-evidence.js';
import { canonicalWorkflowControlAuthorityJson as canonical } from '../workflow-control-authority-contract.js';
import { ensureOwnerDirectory, productionJournalSecurity } from '../workflow-control-shadow.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const build = 'a'.repeat(64),
  workspace = 'workspace.test';
const counters = {
  authority: ['active_runs', 'outbox_pending', 'reconciliation_required'],
  runner: ['runner_jobs', 'runner_leases', 'runner_work', 'reconciliation_required'],
  budget: ['open_reservations', 'reconciliation_required'],
} as const;
function metrics(plane: keyof typeof counters, values: Record<string, number> = {}) {
  const labels = `{workspace_id="${workspace}",routing_epoch="1",build_sha="${build}",plane="${plane}"}`;
  return (
    [
      'openslack_drain_scope' + labels + ' 1',
      ...counters[plane].map((n) => `openslack_drain_${n}${labels} ${values[n] ?? 0}`),
    ].join('\n') + '\n'
  );
}
it.each(['missing', 'duplicate', 'negative', 'foreign', 'nan', 'cumulative', 'extra'] as const)(
  'rejects %s metrics rather than treating them as zero',
  (kind) => {
    let value = metrics('authority');
    if (kind === 'missing') value = value.split('\n').slice(0, -2).join('\n') + '\n';
    if (kind === 'duplicate') value += value.split('\n')[0] + '\n';
    if (kind === 'negative') value = value.replace(/ 0\n/u, ' -1\n');
    if (kind === 'foreign') value = value.replaceAll('workspace.test', 'workspace.other');
    if (kind === 'nan') value = value.replace(/ 0\n/u, ' NaN\n');
    if (kind === 'cumulative') value = value.replace('active_runs', 'runs_total');
    if (kind === 'extra') value += 'unknown 0\n';
    expect(() => parseWorkflowDrainMetrics(value, 'authority', workspace, 1, build)).toThrow(
      'WORKFLOW_DRAIN_EVIDENCE_UNAVAILABLE',
    );
  },
);
async function fixture(values: Record<string, number> = {}) {
  const root = testTemporaryDirectory('drain-observer-');
  roots.push(root);
  const local = join(root, '.openslack.local');
  for (const p of [
    local,
    join(local, 'workflows'),
    join(local, 'workflows/effect-authority'),
    ...['records', 'claims', 'locks'].map((s) => join(local, 'workflows/effect-authority', s)),
    join(local, 'workflows/effect-authority-v2-siblings'),
    ...['records', 'locks'].map((s) => join(local, 'workflows/effect-authority-v2-siblings', s)),
    join(local, 'workflows/effect-approvals'),
    ...['records', 'locks'].map((s) => join(local, 'workflows/effect-approvals', s)),
  ])
    await ensureOwnerDirectory(p, productionJournalSecurity());
  const binding = {
    schema: 'openslack.workflow_control_authority_binding.v1',
    workspaceId: workspace,
    buildSha: build,
    activeRoutingEpoch: 1,
    callerId: 'worker',
    acceptNewRecords: false,
    mode: 'new-record-canary-v1',
    drainRoutingEpochs: [],
  };
  const transport = vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url));
    if (path.pathname.includes('/binding'))
      return new Response(JSON.stringify(binding) + '\n', {
        headers: { 'content-type': 'application/json' },
      });
    const plane = path.port === '10001' ? 'authority' : path.port === '10002' ? 'runner' : 'budget';
    return new Response(metrics(plane, values), {
      headers: { 'content-type': 'text/plain; version=0.0.4' },
    });
  });
  const connection = (port: number) => ({
    origin: `http://127.0.0.1:${port}`,
    bearerToken: 'c'.repeat(48),
    callerId: 'worker',
    buildHash: build,
  });
  const authority = connection(10001);
  const configuration = {
    workspaceRoot: root,
    workspaceId: workspace,
    route: {
      backend: 'go' as const,
      authority: 'workflow-control' as const,
      routingEpoch: 1,
      authorityBuildHash: build,
    },
    authority,
    runner: connection(10002),
    budget: connection(10003),
    authorityClient: {
      read: async () => {
        throw new Error('no D2 run');
      },
    } as unknown as WorkflowControlAuthorityPort,
    fetch: transport as typeof fetch,
  };
  const observer = createWorkflowDrainObserver(configuration);
  return { root, observer, transport, binding, authority, configuration };
}
it(
  'reads current empty authorities without initializing files or publishing observations',
  async () => {
    const { root, observer, transport } = await fixture();
    const before = await readdir(root, { recursive: true });
    expect(await observer.read(new AbortController().signal)).toEqual({
      admissionClosed: true,
      activeRuns: 0,
      pendingEffects: 0,
      openReservations: 0,
      reconciliationRequired: 0,
      authorityConsistent: true,
      runnerDrained: true,
      outboxDrained: true,
    });
    expect(await readdir(root, { recursive: true })).toEqual(before);
    expect(transport).toHaveBeenCalledTimes(8);
    expect(observer.evidence()).toHaveLength(1);
  },
  platformTestTimeout(5_000),
);
it.each([
  'active_runs',
  'outbox_pending',
  'reconciliation_required',
  'runner_jobs',
  'runner_leases',
  'runner_work',
  'open_reservations',
])(
  'does not hide nonzero %s',
  async (name) => {
    const { observer } = await fixture({ [name]: 1 });
    const result = await observer.read(new AbortController().signal);
    expect(
      result.activeRuns === 0 &&
        result.openReservations === 0 &&
        result.reconciliationRequired === 0 &&
        result.runnerDrained &&
        result.outboxDrained,
    ).toBe(false);
  },
  platformTestTimeout(5_000),
);
it(
  'refuses missing D2 authority and propagates cancellation before any read',
  async () => {
    const { root, observer, transport } = await fixture();
    const signal = AbortSignal.abort();
    await expect(observer.read(signal)).rejects.toThrow('WORKFLOW_DRAIN_EVIDENCE_UNAVAILABLE');
    expect(transport).not.toHaveBeenCalled();
    await rm(join(root, '.openslack.local/workflows/effect-authority-v2-siblings'), {
      recursive: true,
    });
    await expect(observer.read(new AbortController().signal)).rejects.toThrow(
      'WORKFLOW_DRAIN_EVIDENCE_UNAVAILABLE',
    );
    expect(observer.evidence()).toEqual([]);
  },
  platformTestTimeout(5_000),
);

it(
  'owns authenticated origins before asynchronous observation',
  async () => {
    const { observer, transport, authority, configuration } = await fixture();
    authority.origin = 'https://unreviewed.example';
    configuration.route.routingEpoch = 999;
    configuration.workspaceId = 'workspace.changed';
    configuration.fetch = vi.fn(async () => {
      throw new Error('changed transport');
    }) as typeof fetch;
    await observer.read(new AbortController().signal);
    expect(
      transport.mock.calls.every(([url]) => new URL(String(url)).hostname === '127.0.0.1'),
    ).toBe(true);
  },
  platformTestTimeout(5_000),
);

it('accepts exact committed settlements without rewriting historical binding state', async () => {
  const vectors = JSON.parse(
    await readFile(
      new URL(
        '../../contracts/workflow-runner-authority-binding/v1/golden-vectors.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const x = vectors.positive.operations.effect_authorize;
  const stage = x.stage.value;
  const frame = {
    bindingId: stage.bindingId,
    state: 'runner_committed',
    stage: x.stage.canonicalBytes,
    stageReceipt: x.stageReceipt.canonicalBytes,
    resolution: x.resolution.canonicalBytes,
    resolutionReceipt: x.resolutionReceipt.canonicalBytes,
  };
  const request = prepareWorkflowBindingReconciliation(stage, 'committed');
  const settlement = {
    schema: 'openslack.workflow_runner_binding_settlement_receipt.v1' as const,
    workspaceId: stage.workspaceId,
    runId: stage.runId,
    bindingId: stage.bindingId,
    stageHash: request.value.stageHash,
    outcome: 'committed' as const,
    proofKind: 'resolution' as const,
    proof: frame.resolution,
    idempotencyKey: request.idempotencyKey,
    requestHash: request.requestHash,
    callerId: 'fixture-reader',
    rulesVersion: 1 as const,
    committedAt: '2026-11-06T00:00:00.000Z',
  };
  const view: WorkflowRunRecoveryEvidence = {
    schema: 'openslack.workflow_runner_recovery_evidence.v2',
    workspaceId: stage.workspaceId,
    runId: stage.runId,
    route: stage.route,
    complete: true,
    snapshot: 'b'.repeat(64),
    nextCursor: null,
    bindings: [frame],
    unfinished: [],
    activeAttempts: [],
    settlements: [settlement],
  };
  expect(() =>
    assertWorkflowDrainCommit(view, x.resolution.value.evidence, 'effect_authorize'),
  ).not.toThrow();
  expect(() =>
    assertWorkflowDrainCommit(
      { ...view, settlements: [] },
      x.resolution.value.evidence,
      'effect_authorize',
    ),
  ).toThrow();
  expect(() =>
    assertWorkflowDrainCommit(
      { ...view, settlements: [{ ...settlement, proof: canonical({ wrong: true }) + '\n' }] },
      x.resolution.value.evidence,
      'effect_authorize',
    ),
  ).toThrow();
});

it(
  'rejects lazy configuration without invoking accessors or Proxy traps',
  async () => {
    const { configuration } = await fixture();
    const getter = vi.fn(() => configuration.authority);
    const lazy = { ...configuration };
    Object.defineProperty(lazy, 'authority', { get: getter, enumerable: true });
    expect(() => createWorkflowDrainObserver(lazy)).toThrow('WORKFLOW_DRAIN_EVIDENCE_UNAVAILABLE');
    expect(getter).not.toHaveBeenCalled();
    const trap = vi.fn();
    expect(() => createWorkflowDrainObserver(new Proxy(configuration, { ownKeys: trap }))).toThrow(
      'WORKFLOW_DRAIN_EVIDENCE_UNAVAILABLE',
    );
    expect(trap).not.toHaveBeenCalled();
  },
  platformTestTimeout(5_000),
);

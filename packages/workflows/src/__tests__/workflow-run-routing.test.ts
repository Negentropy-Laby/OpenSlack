import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  prepareWorkflowControlAuthorityMutation,
  workflowControlAuthorityInitialRecord,
  WorkflowControlAuthorityHttpClient,
  type WorkflowControlAuthorityPort,
} from '../workflow-control-authority-client.js';
import { canonicalWorkflowControlAuthorityJson } from '../workflow-control-authority-contract.js';
import {
  hashWorkflowRunRoutingPolicy,
  WorkflowRunRouteJournal,
  WorkflowRunRouter,
  type WorkflowRunRouteReceipt,
  type WorkflowRunRoutingPolicy,
} from '../workflow-run-routing.js';
import { RunStore } from '../run-store.js';
import { WORKFLOW_RUNNER_CAPABILITIES } from '../workflow-runner-contract.js';
import { workflowRunnerV2DescriptorFixture } from './workflow-runner-v2-test-fixture.js';
import { WorkflowRunnerV2GoProjectionRunStore } from '../workflow-runner-v2-go-projection-store.js';
import {
  loadWorkflowRunRoutingExecutionConfig,
  WORKFLOW_RUN_ROUTING_MODE_GO,
  WORKFLOW_RUN_ROUTING_MODE_TS_ROLLBACK,
} from '../workflow-run-routing-config.js';
import type { WorkflowRunnerControlConfig } from '../workflow-runner-control-client.js';
import type { WorkflowControlShadowJournalSecurityDependencies } from '../workflow-control-shadow.js';
import {
  isWorkflowControlBearerToken,
  parseWorkflowControlRoutingEpoch,
} from '../workflow-control-routing-identity.js';

const roots: string[] = [];
const NOW = '2026-08-29T00:00:00.000Z';
const EXPIRES = '2026-08-30T00:00:00.000Z';
const BUILD = 'a'.repeat(64);
const SOURCE = 'b'.repeat(64);
const MANIFEST = 'c'.repeat(64);
const INPUT = 'd'.repeat(64);
const WORKSPACE = 'workspace.test';
const CALLER = 'typescript.workflow-router';
const TOKEN = 't'.repeat(32);
const UNIT_JOURNAL_SECURITY: WorkflowControlShadowJournalSecurityDependencies = Object.freeze({
  platform: 'win32',
  currentWindowsSid: () => 'S-1-5-21-1000',
  readWindowsPathSecurity: () =>
    JSON.stringify({
      owner: 'S-1-5-21-1000',
      protected: true,
      reparse: false,
      rules: [
        { sid: 'S-1-5-21-1000', type: 'Allow' },
        { sid: 'S-1-5-18', type: 'Allow' },
      ],
    }),
  hardenPath: () => undefined,
});

async function routeWorkspace(prefix: string): Promise<string> {
  const base = process.platform === 'win32' ? 'C:\\Temp' : tmpdir();
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, prefix));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function policy(overrides: Partial<WorkflowRunRoutingPolicy> = {}): WorkflowRunRoutingPolicy {
  return {
    schema: 'openslack.workflow_run_routing_policy.v1',
    workspaceId: WORKSPACE,
    backend: 'go',
    routingEpoch: 17,
    authorityBuildHash: BUILD,
    qualificationEnvironmentId: 'external-canary.test',
    workflowAllowlist: ['workflow.canary'],
    runAllowlist: [],
    expiresAt: EXPIRES,
    ...overrides,
  };
}

function select(
  router = new WorkflowRunRouter(policy()),
  runId = 'run.canary.1',
): WorkflowRunRouteReceipt {
  return router.select({
    workspaceId: WORKSPACE,
    runId,
    workflowId: 'workflow.canary',
    workflowVersion: '1.0.0',
    workflowSourceHash: SOURCE,
    manifestHash: MANIFEST,
    inputHash: INPUT,
    correlationId: 'correlation.canary.1',
    selectedAt: NOW,
  });
}

function routeName(runId: string): string {
  return `${createHash('sha256')
    .update('openslack.workflow-run-route.journal.v1\0', 'utf8')
    .update(runId, 'utf8')
    .digest('hex')}.json`;
}

function acceptedReceipt(route: WorkflowRunRouteReceipt) {
  const prepared = prepareWorkflowControlAuthorityMutation({
    operation: 'accept',
    record: workflowControlAuthorityInitialRecord(route),
    expected: {
      revision: 0,
      state: null,
      currentPhaseId: null,
      currentPhaseIndex: null,
      resumeGeneration: 0,
    },
    correlationId: route.correlationId,
    callerId: CALLER,
    expectedBuildHash: BUILD,
  });
  const value = {
    schema: 'openslack.workflow_control_authority_receipt.v2',
    operation: 'run_transition',
    status: 'accepted',
    workspaceId: route.workspaceId,
    runId: route.runId,
    expectedRevision: 0,
    acceptedRevision: 1,
    resumeGeneration: 0,
    route: route.route,
    idempotencyKey: prepared.idempotencyKey,
    requestFingerprint: prepared.requestFingerprint,
    requestHash: prepared.requestHash,
    recordHash: prepared.recordHash,
    correlationId: route.correlationId,
    serviceBuildHash: BUILD,
    committedAt: NOW,
    reconciliationToken: null,
  } as const;
  return { prepared, exact: `${canonicalWorkflowControlAuthorityJson(value)}\n`, value };
}

describe('Workflow run new-record routing', () => {
  it('freezes one exact allowlisted route with all authority and input bindings', () => {
    const value = policy();
    const route = select(new WorkflowRunRouter(value));

    expect(route).toEqual({
      schema: 'openslack.workflow_run_route_receipt.v1',
      workspaceId: WORKSPACE,
      runId: 'run.canary.1',
      workflowId: 'workflow.canary',
      workflowVersion: '1.0.0',
      workflowSourceHash: SOURCE,
      manifestHash: MANIFEST,
      inputHash: INPUT,
      route: {
        backend: 'go',
        authority: 'workflow-control',
        routingEpoch: 17,
        authorityBuildHash: BUILD,
      },
      policyHash: hashWorkflowRunRoutingPolicy(value),
      correlationId: 'correlation.canary.1',
      qualificationEnvironmentId: 'external-canary.test',
      selectedAt: NOW,
      expiresAt: EXPIRES,
    });
    expect(Object.isFrozen(route)).toBe(true);
    expect(Object.isFrozen(route.route)).toBe(true);
  });

  it('fails closed for unallowlisted, expired, mismatched, or random-looking policy input', () => {
    expect(() =>
      new WorkflowRunRouter(policy()).select({
        ...select(),
        workflowId: 'workflow.not-allowlisted',
      }),
    ).toThrowError(/allowlist/u);
    expect(() => select(new WorkflowRunRouter(policy({ expiresAt: NOW })))).toThrowError(
      /expired/u,
    );
    expect(
      () => new WorkflowRunRouter(policy({ workflowAllowlist: ['workflow.z', 'workflow.a'] })),
    ).toThrowError(/sorted/u);
    expect(() => new WorkflowRunRouter({ ...policy(), percentage: 10 } as never)).toThrowError(
      /unknown fields/u,
    );
  });

  it('commits one owner-only immutable receipt and rejects a second route for the run', async () => {
    const workspace = await routeWorkspace('openslack-workflow-route-');
    roots.push(workspace);
    const journal = new WorkflowRunRouteJournal(join(workspace, 'routes'), UNIT_JOURNAL_SECURITY);
    const route = select();

    await expect(journal.commit(route)).resolves.toEqual(route);
    await expect(journal.commit(route)).resolves.toEqual(route);
    await expect(journal.load(route.runId)).resolves.toEqual(route);
    await expect(
      journal.commit({ ...route, correlationId: 'correlation.canary.drift' }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUN_ROUTE_RECEIPT_CONFLICT' });
  });

  it('migrates a valid flat v1 receipt into the active partition without changing bytes', async () => {
    const workspace = await routeWorkspace('openslack-workflow-route-legacy-');
    roots.push(workspace);
    const routeRoot = join(workspace, 'routes');
    const route = select(undefined, 'run.canary.legacy');
    const name = routeName(route.runId);
    const exact = `${canonicalWorkflowControlAuthorityJson(route)}\n`;
    await mkdir(routeRoot, { recursive: true });
    await writeFile(join(routeRoot, name), exact, 'utf8');

    const journal = new WorkflowRunRouteJournal(routeRoot, UNIT_JOURNAL_SECURITY);
    await expect(journal.locate(route.runId)).resolves.toEqual({
      receipt: route,
      state: 'active',
    });
    await expect(readFile(join(routeRoot, 'active', name), 'utf8')).resolves.toBe(exact);
  });

  it('allows only one policy per epoch and only higher epochs for new records', async () => {
    const workspace = await routeWorkspace('openslack-workflow-route-epoch-');
    roots.push(workspace);
    const journal = new WorkflowRunRouteJournal(join(workspace, 'routes'), UNIT_JOURNAL_SECURITY);
    const activeRouter = new WorkflowRunRouter(policy());
    const first = select(activeRouter, 'run.canary.epoch.17.first');
    const second = select(activeRouter, 'run.canary.epoch.17.second');
    await journal.commit(first);
    await expect(journal.commit(second)).resolves.toEqual(second);

    const changedSameEpoch = select(
      new WorkflowRunRouter(policy({ expiresAt: '2026-08-31T00:00:00.000Z' })),
      'run.canary.epoch.17.changed',
    );
    await expect(journal.commit(changedSameEpoch)).rejects.toMatchObject({
      code: 'WORKFLOW_RUN_ROUTE_RECEIPT_CONFLICT',
    });
    await expect(
      journal.commit(
        select(new WorkflowRunRouter(policy({ routingEpoch: 16 })), 'run.canary.epoch.16.lower'),
      ),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUN_ROUTE_RECEIPT_CONFLICT' });

    const rollback = select(
      new WorkflowRunRouter(
        policy({
          backend: 'ts-local',
          routingEpoch: 18,
          workflowAllowlist: [],
        }),
      ),
      'run.rollback.epoch.18',
    );
    await expect(journal.commit(rollback)).resolves.toEqual(rollback);
    await expect(journal.commit(first)).resolves.toEqual(first);
    await expect(
      journal.commit(select(activeRouter, 'run.canary.epoch.17.after-rollback')),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUN_ROUTE_RECEIPT_CONFLICT' });
    await expect(journal.load(first.runId)).resolves.toEqual(first);
  });

  it('retains the highest routing epoch after terminal receipts move to closed history', async () => {
    const workspace = await routeWorkspace('openslack-workflow-route-close-');
    roots.push(workspace);
    const root = join(workspace, 'routes');
    const first = select(new WorkflowRunRouter(policy({ routingEpoch: 18 })), 'run.closed.18');
    const journal = new WorkflowRunRouteJournal(root, UNIT_JOURNAL_SECURITY);
    await journal.commit(first);
    await expect(journal.close(first.runId)).resolves.toEqual(first);
    await expect(journal.locate(first.runId)).resolves.toMatchObject({ state: 'closed' });
    const restarted = new WorkflowRunRouteJournal(root, UNIT_JOURNAL_SECURITY);
    await expect(
      restarted.commit(
        select(new WorkflowRunRouter(policy({ routingEpoch: 17 })), 'run.lower.after.close'),
      ),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUN_ROUTE_RECEIPT_CONFLICT' });
  });

  it('quarantines a damaged target without blocking unrelated routed runs', async () => {
    const workspace = await routeWorkspace('openslack-workflow-route-quarantine-');
    roots.push(workspace);
    const root = join(workspace, 'routes');
    const damaged = select(undefined, 'run.damaged');
    const journal = new WorkflowRunRouteJournal(root, UNIT_JOURNAL_SECURITY);
    await journal.commit(damaged);
    await writeFile(join(root, 'active', routeName(damaged.runId)), '{"truncated":true', 'utf8');

    const restarted = new WorkflowRunRouteJournal(root, UNIT_JOURNAL_SECURITY);
    await expect(restarted.load(damaged.runId)).rejects.toMatchObject({
      code: 'WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED',
    });
    const healthy = select(undefined, 'run.healthy.after.quarantine');
    await expect(restarted.commit(healthy)).resolves.toEqual(healthy);
    await expect(restarted.inspect()).resolves.toMatchObject({
      active: 1,
      quarantined: 1,
    });
  });

  it('repairs only active receipts backed by terminal evidence', async () => {
    const workspace = await routeWorkspace('openslack-workflow-route-repair-');
    roots.push(workspace);
    const journal = new WorkflowRunRouteJournal(join(workspace, 'routes'), UNIT_JOURNAL_SECURITY);
    const terminal = select(undefined, 'run.repair.terminal');
    const active = select(undefined, 'run.repair.active');
    await journal.commit(terminal);
    await journal.commit(active);
    await expect(
      journal.repair({ canClose: (receipt) => receipt.runId === terminal.runId }),
    ).resolves.toMatchObject({ active: 2, closeable: [terminal.runId], applied: false });
    await expect(
      journal.repair({ apply: true, canClose: (receipt) => receipt.runId === terminal.runId }),
    ).resolves.toMatchObject({ active: 1, closed: 1, applied: true });
  });
});

describe('Process routing configuration', () => {
  it('shares bearer-token and routing-epoch vectors with the Go authority', async () => {
    const vectors = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          'services/workflow-control/internal/authoritybinding/testdata/routing_identity_vectors.json',
        ),
        'utf8',
      ),
    ) as {
      tokens: { value: string; valid: boolean }[];
      epochs: { value: string; valid: boolean }[];
    };
    for (const vector of vectors.tokens) {
      expect(isWorkflowControlBearerToken(vector.value)).toBe(vector.valid);
    }
    for (const vector of vectors.epochs) {
      const parse = () => parseWorkflowControlRoutingEpoch(vector.value);
      if (vector.valid) expect(parse).not.toThrowError();
      else expect(parse).toThrowError();
    }
  });

  function runner(workspaceId: string): WorkflowRunnerControlConfig {
    return {
      origin: 'http://127.0.0.1:18081',
      workspaceId,
      bearerToken: 'x'.repeat(32),
      descriptorRoot: process.cwd(),
    };
  }

  it('is default-off, reports ignored residual settings, and parses one exact Go profile', () => {
    expect(loadWorkflowRunRoutingExecutionConfig(runner('workspace.config.off'), {})).toEqual({
      mode: 'disabled',
      ignoredSettings: [],
    });
    expect(
      loadWorkflowRunRoutingExecutionConfig(runner('workspace.config.partial'), {
        OPENSLACK_WORKFLOW_RUN_ROUTING_EPOCH: '17',
      }),
    ).toEqual({
      mode: 'disabled',
      ignoredSettings: ['OPENSLACK_WORKFLOW_RUN_ROUTING_EPOCH'],
    });

    const token = 'g'.repeat(48);
    const environment = {
      OPENSLACK_WORKFLOW_RUN_ROUTING_MODE: WORKFLOW_RUN_ROUTING_MODE_GO,
      OPENSLACK_WORKFLOW_RUN_ROUTING_EPOCH: '17',
      OPENSLACK_WORKFLOW_RUN_ROUTING_AUTHORITY_BUILD_SHA: BUILD,
      OPENSLACK_WORKFLOW_RUN_ROUTING_QUALIFICATION_ENVIRONMENT_ID: 'external-canary.test',
      OPENSLACK_WORKFLOW_RUN_ROUTING_WORKFLOW_ALLOWLIST: 'workflow.canary',
      OPENSLACK_WORKFLOW_RUN_ROUTING_RUN_ALLOWLIST: '',
      OPENSLACK_WORKFLOW_RUN_ROUTING_EXPIRES_AT: EXPIRES,
      OPENSLACK_WORKFLOW_RUN_ROUTING_AUTHORITY_ORIGIN: 'http://127.0.0.1:18082',
      OPENSLACK_WORKFLOW_RUN_ROUTING_AUTHORITY_BEARER_TOKEN: token,
      OPENSLACK_WORKFLOW_RUN_ROUTING_AUTHORITY_BEARER_SHA256: createHash('sha256')
        .update(token, 'utf8')
        .digest('hex'),
      OPENSLACK_WORKFLOW_RUN_ROUTING_AUTHORITY_CALLER_ID: CALLER,
      OPENSLACK_WORKFLOW_RUN_ROUTING_BUDGET_ACCOUNT_ID: 'budget.canary',
      OPENSLACK_WORKFLOW_RUN_ROUTING_BUDGET_POLICY_SHA: 'e'.repeat(64),
      OPENSLACK_WORKFLOW_RUN_ROUTING_BUDGET_RATE_NANO_USD_PER_TOKEN: '1',
      OPENSLACK_WORKFLOW_RUN_ROUTING_BUDGET_TOKEN_LIMIT: '1000',
      OPENSLACK_WORKFLOW_RUN_ROUTING_BUDGET_COST_LIMIT_NANO_USD: '1000000000',
      OPENSLACK_WORKFLOW_RUN_ROUTING_BUDGET_CALL_LIMIT: '10',
    } satisfies NodeJS.ProcessEnv;
    const config = loadWorkflowRunRoutingExecutionConfig(
      runner('workspace.config.go'),
      environment,
    );
    expect(config).toMatchObject({
      router: { policy: { backend: 'go', routingEpoch: 17 } },
      v2BudgetPolicy: { accountId: 'budget.canary' },
    });
    expect(
      loadWorkflowRunRoutingExecutionConfig(runner('workspace.config.go'), {
        ...environment,
        OPENSLACK_WORKFLOW_RUN_ROUTING_EPOCH: '18',
      }),
    ).toMatchObject({
      mode: WORKFLOW_RUN_ROUTING_MODE_GO,
      router: { policy: { routingEpoch: 18 } },
    });
  });

  it('loads a higher-epoch TS rollback without retaining Go credentials', () => {
    const config = loadWorkflowRunRoutingExecutionConfig(runner('workspace.config.rollback'), {
      OPENSLACK_WORKFLOW_RUN_ROUTING_MODE: WORKFLOW_RUN_ROUTING_MODE_TS_ROLLBACK,
      OPENSLACK_WORKFLOW_RUN_ROUTING_EPOCH: '18',
      OPENSLACK_WORKFLOW_RUN_ROUTING_AUTHORITY_BUILD_SHA: BUILD,
      OPENSLACK_WORKFLOW_RUN_ROUTING_QUALIFICATION_ENVIRONMENT_ID: 'external-rollback.test',
      OPENSLACK_WORKFLOW_RUN_ROUTING_WORKFLOW_ALLOWLIST: '',
      OPENSLACK_WORKFLOW_RUN_ROUTING_RUN_ALLOWLIST: '',
      OPENSLACK_WORKFLOW_RUN_ROUTING_EXPIRES_AT: EXPIRES,
    });
    if (config.mode === 'disabled') throw new Error('Expected explicit rollback config.');
    expect(config.router.policy).toMatchObject({
      backend: 'ts-local',
      routingEpoch: 18,
    });
    expect(config).not.toHaveProperty('authority');
    expect(config).not.toHaveProperty('v2BudgetPolicy');
  });
});

describe('Workflow Control authority accept client', () => {
  it('binds an exact Go accept before returning the durable receipt', async () => {
    const route = select();
    const { prepared, exact, value } = acceptedReceipt(route);
    const send = vi.fn<typeof fetch>(async (request, init) => {
      expect(String(request)).toBe('http://127.0.0.1:18082/v1/workflow-control/runs:accept');
      expect(init?.body).toBe(prepared.exactBody);
      expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(prepared.idempotencyKey);
      expect(new Headers(init?.headers).get('X-OpenSlack-Workflow-Control-Routing-Epoch')).toBe(
        '17',
      );
      return new Response(exact, {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const client = new WorkflowControlAuthorityHttpClient({
      origin: 'http://127.0.0.1:18082',
      workspaceId: WORKSPACE,
      callerId: CALLER,
      bearerToken: TOKEN,
      expectedBuildHash: BUILD,
      fetch: send,
    });

    await expect(client.accept(route)).resolves.toEqual(value);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('recovers one lost accept response only through the same durable receipt key', async () => {
    const route = select();
    const { prepared, exact, value } = acceptedReceipt(route);
    let attempt = 0;
    const send = vi.fn<typeof fetch>(async (request) => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('response lost');
      expect(String(request)).toBe(
        `http://127.0.0.1:18082/v1/workflow-control/receipts/${prepared.idempotencyKey}`,
      );
      return new Response(exact, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const client = new WorkflowControlAuthorityHttpClient({
      origin: 'http://127.0.0.1:18082',
      workspaceId: WORKSPACE,
      callerId: CALLER,
      bearerToken: TOKEN,
      expectedBuildHash: BUILD,
      fetch: send,
    });

    await expect(client.accept(route)).resolves.toEqual(value);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('never falls back when durable receipt recovery is absent or mismatched', async () => {
    const route = select();
    const send = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockResolvedValueOnce(
        new Response('{"code":"not_found"}\n', {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const client = new WorkflowControlAuthorityHttpClient({
      origin: 'http://127.0.0.1:18082',
      workspaceId: WORKSPACE,
      callerId: CALLER,
      bearerToken: TOKEN,
      expectedBuildHash: BUILD,
      fetch: send,
    });

    await expect(client.accept(route)).rejects.toMatchObject({
      code: 'WORKFLOW_CONTROL_AUTHORITY_CLIENT_TRANSPORT_FAILED',
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('distinguishes an absent run from malformed authority read responses', async () => {
    const route = select();
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response('null\n', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('{"schema":"openslack.workflow_control_authority_read.v2"}\n', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const client = new WorkflowControlAuthorityHttpClient({
      origin: 'http://127.0.0.1:18082',
      workspaceId: WORKSPACE,
      callerId: CALLER,
      bearerToken: TOKEN,
      expectedBuildHash: BUILD,
      fetch: send,
    });

    await expect(client.readIfExists(route.runId, route.route)).resolves.toBeNull();
    await expect(client.read(route.runId, route.route)).rejects.toMatchObject({
      code: 'WORKFLOW_CONTROL_AUTHORITY_CLIENT_RESPONSE_INVALID',
    });
    await expect(client.read(route.runId, route.route)).rejects.toMatchObject({
      code: 'WORKFLOW_CONTROL_AUTHORITY_CLIENT_RESPONSE_INVALID',
    });
    expect(send).toHaveBeenCalledTimes(3);
  });
});

describe('Go-owned worker recovery projection', () => {
  it('commits lifecycle to Go while keeping the TypeScript authoritative RunStore namespace empty', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'openslack-workflow-go-projection-'));
    roots.push(workspace);
    const route = select();
    const descriptor = workflowRunnerV2DescriptorFixture({
      descriptorRef: 'descriptor.go-projection.1',
      workspaceId: route.workspaceId,
      workflowRunId: route.runId,
      correlationId: route.correlationId,
      workflowId: route.workflowId,
      workflowVersion: route.workflowVersion,
      workflowSource: 'openslack-project',
      workflowSourceBytes: Buffer.from('export async function run() {}', 'utf8'),
      manifest: {
        name: route.workflowId,
        version: route.workflowVersion,
        description: 'Go projection test.',
        phases: [{ title: 'Run', detail: 'Run once.' }],
        risk: 'low',
      },
      input: {},
      confirmationPolicy: {
        mode: 'unattended-explicit',
        actorId: 'operator',
        runId: route.runId,
        allowUnattended: true,
      },
      requiredCapabilities: WORKFLOW_RUNNER_CAPABILITIES,
      authorityRoute: route.route,
      runRevision: 1,
      resumeGeneration: 0,
      budgetPolicy: {
        accountId: 'budget.go-projection',
        policyHash: 'e'.repeat(64),
        rateNanoUsdPerToken: '1',
        tokenLimit: '100',
        costLimitNanoUsd: '1000000000',
        callLimit: '10',
      },
      createdAt: NOW,
      expiresAt: EXPIRES,
    });
    let record = workflowControlAuthorityInitialRecord({
      ...route,
      workflowSourceHash: descriptor.workflowSourceHash,
      manifestHash: descriptor.manifestHash,
      inputHash: descriptor.inputHash,
    });
    const transitions: string[] = [];
    const projectionBase = join(
      workspace,
      '.openslack.local',
      'workflows',
      'go-recovery-projections',
    );
    const authority: WorkflowControlAuthorityPort = {
      async inspectBinding() {
        return {
          schema: 'openslack.workflow_control_authority_binding.v1',
          workspaceId: WORKSPACE,
          callerId: CALLER,
          mode: 'new-record-canary-v1',
          activeRoutingEpoch: 17,
          drainRoutingEpochs: [],
          buildSha: BUILD,
          acceptNewRecords: true,
        };
      },
      accept: vi.fn(),
      async read() {
        return {
          ...record,
          schema: 'openslack.workflow_control_authority_read.v2',
          recordHash: 'f'.repeat(64),
          record,
          updatedAt: NOW,
        };
      },
      async readIfExists() {
        return this.read(route.runId, route.route);
      },
      async transition(next, expected) {
        expect(expected).toMatchObject({ revision: record.revision, state: record.state });
        expect(next.revision).toBe(record.revision + 1);
        if (record.state === 'created') {
          await expect(
            new RunStore({ baseDir: projectionBase }).runExists(route.runId),
          ).resolves.toBe(false);
        }
        transitions.push(`${record.state}->${next.state}`);
        record = next;
        return {} as never;
      },
    };
    const projection = new WorkflowRunnerV2GoProjectionRunStore({
      baseDir: projectionBase,
      descriptor,
      mode: 'authority',
      authority,
    });

    await projection.initRun(route.runId, {
      runId: route.runId,
      workflowName: route.workflowId,
      mode: 'execute',
      manifestHash: descriptor.manifestHash,
      args: {},
      startedAt: NOW,
      budget: { tokens: 100, costUsd: 1 },
    });
    await projection.saveOutput(route.runId, { status: 'completed', runId: route.runId });
    await projection.transitionStatus(route.runId, 'completed');

    expect(transitions).toEqual(['created->running', 'running->completed']);
    expect(record.state).toBe('completed');
    await expect(projection.loadOutput(route.runId)).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(
      new RunStore({
        baseDir: join(workspace, '.openslack.local', 'workflows'),
      }).runExists(route.runId),
    ).resolves.toBe(false);
  });
});

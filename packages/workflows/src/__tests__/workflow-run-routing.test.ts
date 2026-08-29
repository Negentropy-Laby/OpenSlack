import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { createWorkflowRunnerV2ExecutionDescriptor } from '../workflow-runner-v2-descriptor.js';
import { WorkflowRunnerV2GoProjectionRunStore } from '../workflow-runner-v2-go-projection-store.js';
import {
  loadWorkflowRunRoutingExecutionConfig,
  WORKFLOW_RUN_ROUTING_MODE_GO,
  WORKFLOW_RUN_ROUTING_MODE_TS_ROLLBACK,
} from '../workflow-run-routing-config.js';
import type { WorkflowRunnerControlConfig } from '../workflow-runner-control-client.js';

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

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function policy(overrides: Partial<WorkflowRunRoutingPolicy> = {}): WorkflowRunRoutingPolicy {
  return {
    schema: 'openslack.workflow_run_routing_policy.v1',
    workspaceId: WORKSPACE,
    backend: 'go',
    authority: 'workflow-control',
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
    const workspace = await mkdtemp(join(tmpdir(), 'openslack-workflow-route-'));
    roots.push(workspace);
    const journal = new WorkflowRunRouteJournal(join(workspace, 'routes'));
    const route = select();

    await expect(journal.commit(route)).resolves.toEqual(route);
    await expect(journal.commit(route)).resolves.toEqual(route);
    await expect(journal.load(route.runId)).resolves.toEqual(route);
    await expect(
      journal.commit({ ...route, correlationId: 'correlation.canary.drift' }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUN_ROUTE_RECEIPT_CONFLICT' });
  });

  it('allows only one policy per epoch and only higher epochs for new records', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'openslack-workflow-route-epoch-'));
    roots.push(workspace);
    const journal = new WorkflowRunRouteJournal(join(workspace, 'routes'));
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
          authority: 'typescript',
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
});

describe('Process routing configuration', () => {
  function runner(workspaceId: string): WorkflowRunnerControlConfig {
    return {
      origin: 'http://127.0.0.1:18081',
      workspaceId,
      bearerToken: 'x'.repeat(32),
      descriptorRoot: process.cwd(),
    };
  }

  it('is default-off, closed, and immutable after the first exact Go profile', () => {
    expect(
      loadWorkflowRunRoutingExecutionConfig(runner('workspace.config.off'), {}),
    ).toBeUndefined();
    expect(() =>
      loadWorkflowRunRoutingExecutionConfig(runner('workspace.config.partial'), {
        OPENSLACK_WORKFLOW_RUN_ROUTING_EPOCH: '17',
      }),
    ).toThrowError(/disabled or partially configured/u);

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
    expect(() =>
      loadWorkflowRunRoutingExecutionConfig(runner('workspace.config.go'), {
        ...environment,
        OPENSLACK_WORKFLOW_RUN_ROUTING_EPOCH: '18',
      }),
    ).toThrowError(/changed after process initialization/u);
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
    expect(config?.router.policy).toMatchObject({
      backend: 'ts-local',
      authority: 'typescript',
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
});

describe('Go-owned worker recovery projection', () => {
  it('commits lifecycle to Go while keeping the TypeScript authoritative RunStore namespace empty', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'openslack-workflow-go-projection-'));
    roots.push(workspace);
    const route = select();
    const descriptor = createWorkflowRunnerV2ExecutionDescriptor({
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

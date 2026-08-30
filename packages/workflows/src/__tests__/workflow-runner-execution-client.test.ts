import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../run-store.js';
import { hashWorkflowRunnerResult } from '../workflow-runner-descriptor.js';
import { hashWorkflowRunnerV2Result } from '../index.js';
import {
  executeWorkflowThroughRunner,
  type WorkflowRunnerPausedResult,
} from '../workflow-runner-execution-client.js';
import type {
  PreparedWorkflowRunnerJobSpec,
  WorkflowRunnerControlConfig,
  WorkflowRunnerControlPort,
  WorkflowRunnerJobReceipt,
  WorkflowRunnerJobView,
} from '../workflow-runner-control-client.js';
import type { RunResult, WorkflowMeta } from '../types.js';
import {
  workflowControlAuthorityInitialRecord,
  type WorkflowControlAuthorityPort,
  type WorkflowControlAuthorityRunRecord,
} from '../workflow-control-authority-client.js';
import { WorkflowRunRouter, type WorkflowRunRouteReceipt } from '../workflow-run-routing.js';
import type {
  PreparedWorkflowRunnerV2JobSpec,
  WorkflowRunnerV2ControlPort,
} from '../workflow-runner-v2-control-client.js';

const roots: string[] = [];
const NOW = '2026-08-13T00:00:00.000Z';
const HASH = '1'.repeat(64);
const manifest: WorkflowMeta = {
  name: 'runner-public-test',
  version: '1.0.0',
  description: 'Runner public execution client test.',
  phases: [{ title: 'Run', detail: 'Run once.' }],
  risk: 'low',
};
let windowsSid: string | undefined;

function hardenWindowsDirectory(path: string): void {
  if (process.platform !== 'win32') return;
  windowsSid ??= execFileSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
  ).trim();
  execFileSync('icacls.exe', [path, '/reset'], { windowsHide: true, timeout: 20_000 });
  execFileSync('icacls.exe', [path, '/setowner', `*${windowsSid}`], {
    windowsHide: true,
    timeout: 20_000,
  });
  execFileSync(
    'icacls.exe',
    [path, '/inheritance:r', '/grant:r', `*${windowsSid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'],
    { windowsHide: true, timeout: 20_000 },
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(status: 'completed' | 'paused_waiting_approval' | 'failed') {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'openslack-runner-public-'));
  roots.push(workspaceRoot);
  const workflowRunId = `run.public.${status}`;
  const descriptorRoot = join(workspaceRoot, '.runner-descriptors');
  await mkdir(descriptorRoot, { mode: 0o700 });
  hardenWindowsDirectory(descriptorRoot);
  const config: WorkflowRunnerControlConfig = {
    origin: 'http://127.0.0.1:18183',
    workspaceId: 'workspace.test',
    bearerToken: 't'.repeat(32),
    descriptorRoot,
  };
  const output: RunResult = { status: 'completed', value: 'durable' };
  const runStore = new RunStore({
    baseDir: join(workspaceRoot, '.openslack.local', 'workflows'),
  });
  await runStore.initRun(workflowRunId, {
    runId: workflowRunId,
    workflowName: manifest.name,
    mode: 'execute',
    manifestHash: HASH,
    args: {},
    startedAt: NOW,
  });
  if (status === 'completed') await runStore.saveOutput(workflowRunId, output);
  await runStore.transitionStatus(workflowRunId, status);

  let submitted: PreparedWorkflowRunnerJobSpec | undefined;
  const terminal: WorkflowRunnerJobView = {
    schema: 'openslack.workflow_runner_job_view.v1',
    workspaceId: config.workspaceId,
    jobId: 'job.placeholder',
    workflowRunId,
    correlationId: 'correlation.placeholder',
    state: 'terminal',
    revision: 4,
    fencingToken: 1,
    attemptId: 'attempt-1',
    leaseId: 'lease-1',
    attemptState: 'terminal',
    leaseExpiresAt: '2026-08-13T00:01:00.000Z',
    terminalStatus: status === 'completed' ? 'completed' : 'failed',
    terminalReason: status === 'completed' ? null : 'workflow paused',
    resultHash: status === 'completed' ? hashWorkflowRunnerResult(output) : null,
    openEffectCount: status === 'completed' ? 0 : 1,
    reconciliationId: null,
    reconciliationCode: null,
    executionStarted: true,
    createdAt: NOW,
    updatedAt: '2026-08-13T00:00:01.000Z',
  };
  const client: WorkflowRunnerControlPort = {
    descriptorRoot,
    async submit(prepared): Promise<WorkflowRunnerJobReceipt> {
      submitted = prepared;
      return {
        schema: 'openslack.workflow_runner_job_receipt.v1',
        status: 'accepted',
        workspaceId: prepared.spec.workspaceId,
        jobId: prepared.spec.jobId,
        workflowRunId: prepared.spec.workflowRunId,
        state: 'queued',
        revision: 1,
        jobSpecHash: prepared.jobSpecHash,
        idempotencyKey: prepared.idempotencyKey,
        requestFingerprint: prepared.requestFingerprint,
        committedAt: NOW,
        reconciliationId: null,
      };
    },
    async waitForTerminal(jobId): Promise<WorkflowRunnerJobView> {
      return {
        ...terminal,
        jobId,
        correlationId: submitted!.spec.correlationId,
      };
    },
  };
  return { client, config, output, submitted: () => submitted, workflowRunId, workspaceRoot };
}

describe('Workflow Runner public execution client', () => {
  it('freezes, durably accepts, and submits an explicit Go route without v1 RunStore fallback', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'openslack-runner-go-route-'));
    roots.push(workspaceRoot);
    const descriptorRoot = join(workspaceRoot, '.runner-descriptors');
    await mkdir(descriptorRoot, { mode: 0o700 });
    hardenWindowsDirectory(descriptorRoot);
    const config: WorkflowRunnerControlConfig = {
      origin: 'http://127.0.0.1:18183',
      workspaceId: 'workspace.test',
      bearerToken: 't'.repeat(32),
      descriptorRoot,
      expectedBuildHash: HASH,
    };
    const submit = vi.fn<WorkflowRunnerControlPort['submit']>();
    let preparedV2: PreparedWorkflowRunnerV2JobSpec | undefined;
    const output: RunResult = { status: 'completed', value: 'go-owned' };
    let record: WorkflowControlAuthorityRunRecord | undefined;
    const runId = 'run.public.go-canary';
    const client: WorkflowRunnerControlPort = {
      descriptorRoot,
      submit,
      async waitForTerminal(jobId) {
        const projection = new RunStore({
          baseDir: join(workspaceRoot, '.openslack.local', 'workflows', 'go-recovery-projections'),
        });
        await projection.initRun(runId, {
          runId,
          workflowName: manifest.name,
          mode: 'execute',
          manifestHash: preparedV2!.spec.manifestHash,
          args: {},
          startedAt: NOW,
        });
        await projection.saveOutput(runId, output);
        await projection.transitionStatus(runId, 'completed');
        record = { ...record!, state: 'completed', revision: 3 };
        return {
          schema: 'openslack.workflow_runner_job_view.v1',
          workspaceId: config.workspaceId,
          jobId,
          workflowRunId: runId,
          correlationId: preparedV2!.spec.correlationId,
          state: 'terminal',
          revision: 4,
          fencingToken: 1,
          attemptId: 'attempt-go-1',
          leaseId: 'lease-go-1',
          attemptState: 'terminal',
          leaseExpiresAt: '2026-08-13T00:01:00.000Z',
          terminalStatus: 'completed',
          terminalReason: null,
          resultHash: hashWorkflowRunnerV2Result(output),
          openEffectCount: 0,
          reconciliationId: null,
          reconciliationCode: null,
          executionStarted: true,
          createdAt: NOW,
          updatedAt: '2026-08-13T00:00:01.000Z',
        };
      },
    };
    const v2Submit = vi.fn<WorkflowRunnerV2ControlPort['submit']>(async (prepared) => {
      preparedV2 = prepared;
      return {
        schema: 'openslack.workflow_runner_job_receipt.v2',
        status: 'accepted',
        workspaceId: prepared.spec.workspaceId,
        jobId: prepared.spec.jobId,
        workflowRunId: prepared.spec.workflowRunId,
        state: 'queued',
        revision: 1,
        jobSpecHash: prepared.jobSpecHash,
        idempotencyKey: prepared.idempotencyKey,
        requestFingerprint: prepared.requestFingerprint,
        committedAt: NOW,
        reconciliationId: null,
      };
    });
    const v2Client: WorkflowRunnerV2ControlPort = {
      descriptorRoot,
      submit: v2Submit,
      async inspectBinding() {
        return {
          schema: 'openslack.workflow_runner_control_binding.v1',
          workspaceId: config.workspaceId,
          buildSha: HASH,
          runnerTokenSha256: createHash('sha256').update(config.bearerToken).digest('hex'),
          v2Enabled: true,
          runtimeDeliveryEnabled: true,
          newRecordCanary: true,
          authorityOrigin: 'http://127.0.0.1:18082',
          authorityCallerId: 'workflow-runner-v2',
          authorityBuildSha: HASH,
          authorityTokenSha256: createHash('sha256').update('a'.repeat(32)).digest('hex'),
        };
      },
    };
    let frozen: WorkflowRunRouteReceipt | undefined;
    const authority: WorkflowControlAuthorityPort = {
      async inspectBinding() {
        return {
          schema: 'openslack.workflow_control_authority_binding.v1',
          workspaceId: config.workspaceId,
          callerId: 'workflow-runner-v2',
          mode: 'new-record-canary-v1',
          activeRoutingEpoch: 9,
          drainRoutingEpochs: [],
          buildSha: HASH,
          acceptNewRecords: true,
        };
      },
      accept: vi.fn(async (route) => {
        frozen = route;
        record = workflowControlAuthorityInitialRecord(route);
        return {} as never;
      }),
      transition: vi.fn(),
      read: vi.fn(async () => ({
        ...record!,
        schema: 'openslack.workflow_control_authority_read.v2' as const,
        recordHash: HASH,
        record: record!,
        updatedAt: NOW,
      })),
      readIfExists: vi.fn(async () => ({
        ...record!,
        schema: 'openslack.workflow_control_authority_read.v2' as const,
        recordHash: HASH,
        record: record!,
        updatedAt: NOW,
      })),
    };

    await expect(
      executeWorkflowThroughRunner({
        workspaceRoot,
        workflowRunId: runId,
        workflowSource: 'openslack-project',
        workflowSourceBytes: Buffer.from('export async function run() {}', 'utf8'),
        manifest,
        confirmationPolicy: {
          mode: 'unattended-explicit',
          actorId: 'operator',
          runId,
          allowUnattended: true,
        },
        config,
        client,
        now: () => new Date(NOW),
        routing: {
          mode: 'explicit',
          router: new WorkflowRunRouter({
            schema: 'openslack.workflow_run_routing_policy.v1',
            workspaceId: config.workspaceId,
            backend: 'go',
            routingEpoch: 9,
            authorityBuildHash: HASH,
            qualificationEnvironmentId: 'hosted-canary.test',
            workflowAllowlist: [manifest.name],
            runAllowlist: [],
            expiresAt: '2026-08-14T00:00:00.000Z',
          }),
          journal: {
            async load() {
              return null;
            },
            async locate() {
              return null;
            },
            async commit(route) {
              return route as WorkflowRunRouteReceipt;
            },
            async close() {
              return null;
            },
            async inspect() {
              return { active: 0, closed: 0, quarantined: 0, capacity: 4096, unsafe: 0 };
            },
            async repair() {
              return {
                active: 0,
                closed: 0,
                quarantined: 0,
                capacity: 4096,
                unsafe: 0,
                closeable: [],
                applied: false,
              };
            },
          },
          authority,
          v2Client,
          v2BudgetPolicy: {
            accountId: 'budget.go-public',
            policyHash: '2'.repeat(64),
            rateNanoUsdPerToken: '1',
            tokenLimit: '1000',
            costLimitNanoUsd: '1000000000',
            callLimit: '10',
          },
          fingerprint: HASH,
          diagnostics: [],
          binding: {
            runnerOrigin: config.origin,
            runnerWorkspaceId: config.workspaceId,
            runnerTokenSha256: createHash('sha256').update(config.bearerToken).digest('hex'),
            runnerBuildSha: HASH,
            authorityOrigin: 'http://127.0.0.1:18082',
            authorityCallerId: 'workflow-runner-v2',
            authorityBuildSha: HASH,
            authorityTokenSha256: createHash('sha256').update('a'.repeat(32)).digest('hex'),
          },
        },
      }),
    ).resolves.toEqual(output);

    expect(frozen).toMatchObject({
      runId,
      route: { backend: 'go', authority: 'workflow-control', routingEpoch: 9 },
    });
    expect(authority.accept).toHaveBeenCalledTimes(1);
    expect(authority.read).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(v2Submit).toHaveBeenCalledTimes(1);
    await expect(
      new RunStore({
        baseDir: join(workspaceRoot, '.openslack.local', 'workflows'),
      }).runExists(runId),
    ).resolves.toBe(false);
  });

  it('seals a hash-only JobSpec and returns only the matching durable RunStore result', async () => {
    const value = await fixture('completed');
    const result = await executeWorkflowThroughRunner({
      workspaceRoot: value.workspaceRoot,
      workflowRunId: value.workflowRunId,
      workflowSource: 'openslack-project',
      workflowSourceBytes: Buffer.from('export async function run() {}', 'utf8'),
      manifest,
      confirmationPolicy: {
        mode: 'unattended-explicit',
        actorId: 'operator',
        runId: value.workflowRunId,
        allowUnattended: true,
      },
      config: value.config,
      client: value.client,
      now: () => new Date(NOW),
    });

    expect(result).toEqual(value.output);
    expect(value.submitted()?.spec).toMatchObject({
      workspaceId: value.config.workspaceId,
      workflowRunId: value.workflowRunId,
      workflowId: manifest.name,
    });
    expect(value.submitted()?.exactBody).not.toContain('export async function');
    await expect(
      access(join(value.workspaceRoot, '.openslack.local', 'workflows', 'routes')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns the durable approval pause without treating a failed job as workflow failure', async () => {
    const value = await fixture('paused_waiting_approval');
    const result = await executeWorkflowThroughRunner({
      workspaceRoot: value.workspaceRoot,
      workflowRunId: value.workflowRunId,
      workflowSource: 'openslack-project',
      workflowSourceBytes: Buffer.from('export async function run() {}', 'utf8'),
      manifest,
      confirmationPolicy: {
        mode: 'unattended-explicit',
        actorId: 'operator',
        runId: value.workflowRunId,
        allowUnattended: true,
      },
      config: value.config,
      client: value.client,
      now: () => new Date(NOW),
    });

    expect(result).toEqual<WorkflowRunnerPausedResult>({
      status: 'paused_waiting_approval',
      runId: value.workflowRunId,
    });
  });

  it.each(['failed', 'cancelled', 'timed_out', 'reconciliation_required'] as const)(
    'returns a stable error for the %s terminal instead of masking it with unrelated durable state',
    async (terminalStatus) => {
      const value = await fixture(
        terminalStatus === 'failed' ? 'failed' : 'paused_waiting_approval',
      );
      const client: WorkflowRunnerControlPort = {
        ...value.client,
        async waitForTerminal(jobId, options) {
          const terminal = await value.client.waitForTerminal(jobId, options);
          return terminalStatus === 'reconciliation_required'
            ? {
                ...terminal,
                state: 'reconciliation_required',
                terminalStatus: 'reconciliation_required',
                terminalReason: 'commit_outcome_unknown',
                resultHash: null,
                reconciliationId: 'reconciliation-1',
                reconciliationCode: 'commit_outcome_unknown',
              }
            : {
                ...terminal,
                state: 'terminal',
                terminalStatus,
                terminalReason: `runner_${terminalStatus}`,
                resultHash: null,
              };
        },
      };

      await expect(
        executeWorkflowThroughRunner({
          workspaceRoot: value.workspaceRoot,
          workflowRunId: value.workflowRunId,
          workflowSource: 'openslack-project',
          workflowSourceBytes: Buffer.from('export async function run() {}', 'utf8'),
          manifest,
          confirmationPolicy: {
            mode: 'unattended-explicit',
            actorId: 'operator',
            runId: value.workflowRunId,
            allowUnattended: true,
          },
          config: value.config,
          client,
          now: () => new Date(NOW),
        }),
      ).rejects.toMatchObject({
        code:
          terminalStatus === 'reconciliation_required'
            ? 'WORKFLOW_RUNNER_CONTROL_RECONCILIATION_REQUIRED'
            : terminalStatus === 'timed_out'
              ? 'WORKFLOW_RUNNER_CONTROL_TIMEOUT'
              : 'WORKFLOW_RUNNER_CONTROL_REJECTED',
      });
    },
  );

  it('rejects a terminal view that changes the submitted workflow identity', async () => {
    const value = await fixture('completed');
    const client: WorkflowRunnerControlPort = {
      ...value.client,
      async waitForTerminal(jobId, options) {
        return {
          ...(await value.client.waitForTerminal(jobId, options)),
          correlationId: 'correlation.drifted',
        };
      },
    };
    await expect(
      executeWorkflowThroughRunner({
        workspaceRoot: value.workspaceRoot,
        workflowRunId: value.workflowRunId,
        workflowSource: 'openslack-project',
        workflowSourceBytes: Buffer.from('export async function run() {}', 'utf8'),
        manifest,
        confirmationPolicy: {
          mode: 'unattended-explicit',
          actorId: 'operator',
          runId: value.workflowRunId,
          allowUnattended: true,
        },
        config: value.config,
        client,
        now: () => new Date(NOW),
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID' });
  });
});

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../run-store.js';
import { hashWorkflowRunnerResult } from '../workflow-runner-descriptor.js';
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
                terminalStatus: null,
                terminalReason: null,
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

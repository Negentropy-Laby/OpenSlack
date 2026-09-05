import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../run-store.js';
import { createWorkflowRunStoreRecoveryAccess } from '../internal/workflow-run-store-recovery-access.js';
import {
  executeWorkflowThroughRunner as executePublicWorkflowThroughRunner,
  type ExecuteWorkflowThroughRunnerInput,
} from '../index.js';
import {
  hashWorkflowRunnerV2Input,
  hashWorkflowRunnerV2Manifest,
  hashWorkflowRunnerV2Result,
  hashWorkflowRunnerV2Source,
} from '../workflow-runner-v2-descriptor.js';
import { executeWorkflowThroughRunnerWithRuntime } from '../workflow-runner-execution-client.js';
import type {
  WorkflowRunnerControlConfig,
  WorkflowRunnerJobView,
  WorkflowRunnerStatusPort,
} from '../workflow-runner-control-client.js';
import type { RunResult, WorkflowMeta } from '../types.js';
import { canonicalWorkflowControlAuthorityJson } from '../workflow-control-authority-contract.js';
import { productionJournalSecurity, writeExclusive } from '../workflow-control-shadow.js';
import {
  workflowControlAuthorityInitialRecord,
  type WorkflowControlAuthorityPort,
  type WorkflowControlAuthorityRunRecord,
} from '../workflow-control-authority-client.js';
import {
  WorkflowRunRouteJournal,
  WorkflowRunRouter,
  type WorkflowRunRouteReceipt,
} from '../workflow-run-routing.js';
import type {
  PreparedWorkflowRunnerV2JobSpec,
  WorkflowRunnerV2ControlPort,
} from '../workflow-runner-v2-control-client.js';

const roots: string[] = [];
const NOW = '2026-08-13T00:00:00.000Z';
const HASH = '1'.repeat(64);

function authorityRecordHash(record: WorkflowControlAuthorityRunRecord): string {
  return createHash('sha256')
    .update(`${canonicalWorkflowControlAuthorityJson(record)}\n`, 'utf8')
    .digest('hex');
}
const manifest: WorkflowMeta = {
  name: 'runner-public-test',
  version: '1.0.0',
  description: 'Runner public execution client test.',
  phases: [{ title: 'Run', detail: 'Run once.' }],
  risk: 'low',
};
let windowsSid: string | undefined;

vi.setConfig({ testTimeout: process.platform === 'win32' ? 30_000 : 5_000 });

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
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'openslack-runner-public-'));
  roots.push(workspaceRoot);
  const workflowRunId = 'run.public.retired-typescript';
  const descriptorRoot = join(workspaceRoot, '.runner-descriptors');
  await mkdir(descriptorRoot, { mode: 0o700 });
  hardenWindowsDirectory(descriptorRoot);
  const config: WorkflowRunnerControlConfig = {
    origin: 'http://127.0.0.1:18183',
    workspaceId: 'workspace.test',
    bearerToken: 't'.repeat(32),
    descriptorRoot,
  };
  const client: WorkflowRunnerStatusPort = {
    descriptorRoot,
    async waitForTerminal(): Promise<WorkflowRunnerJobView> {
      throw new Error('retired TypeScript execution must not poll a runner job');
    },
  };
  return { client, config, workflowRunId, workspaceRoot };
}

it('ignores hostile runtime injection fields supplied through the package root', async () => {
  const { workspaceRoot } = await fixture();
  vi.stubEnv('OPENSLACK_WORKFLOW_RUNNER_CONTROL_ORIGIN', 'http://127.0.0.1:18081');
  vi.stubEnv('OPENSLACK_WORKFLOW_RUNNER_CONTROL_WORKSPACE_ID', 'workspace.public');
  vi.stubEnv('OPENSLACK_WORKFLOW_RUNNER_CONTROL_BEARER_TOKEN', 'a'.repeat(32));
  vi.stubEnv('OPENSLACK_WORKFLOW_RUNNER_DESCRIPTOR_ROOT', join(workspaceRoot, 'descriptors'));
  vi.stubEnv('OPENSLACK_WORKFLOW_RUN_ROUTING_MODE', '');

  const injectedNow = vi.fn(() => {
    throw new Error('public runtime injection reached');
  });
  const injectedWait = vi.fn();
  const publicInput = {
    workspaceRoot,
    workflowRunId: 'run.public-injection',
    workflowSource: 'openslack-project',
    workflowSourceBytes: new TextEncoder().encode('export default {}'),
    manifest,
    confirmationPolicy: {
      mode: 'unattended-explicit',
      actorId: 'operator',
      runId: 'run.public-injection',
      allowUnattended: true,
    },
    config: { descriptorRoot: '/hostile' },
    client: { descriptorRoot: '/hostile', waitForTerminal: injectedWait },
    now: injectedNow,
    routing: { mode: 'hostile' },
  } as unknown as ExecuteWorkflowThroughRunnerInput;

  await expect(executePublicWorkflowThroughRunner(publicInput)).rejects.toMatchObject({
    code: 'WORKFLOW_RUNNER_CONTROL_TS_MUTATION_RETIRED',
  });
  expect(injectedNow).not.toHaveBeenCalled();
  expect(injectedWait).not.toHaveBeenCalled();
});

function routeName(runId: string): string {
  return `${createHash('sha256')
    .update('openslack.workflow-run-route.journal.v1\0', 'utf8')
    .update(runId, 'utf8')
    .digest('hex')}.json`;
}

describe('Workflow Runner public execution client', () => {
  it.each([
    'nominal',
    'accept-response-loss-created',
    'transition-response-loss-running',
    'transition-uncommitted',
    'existing-running',
    'existing-paused',
    'existing-paused-waiting-approval',
    'existing-resuming',
    'existing-terminal',
    'existing-identity-drift',
  ] as const)('establishes the initial Go authority boundary for %s', async (scenario) => {
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
    let preparedV2: PreparedWorkflowRunnerV2JobSpec | undefined;
    const output: RunResult = { status: 'completed', value: 'go-owned' };
    let record: WorkflowControlAuthorityRunRecord | undefined;
    const runId = 'run.public.go-canary';
    const workflowSourceBytes = Buffer.from('export async function run() {}', 'utf8');
    const router = new WorkflowRunRouter({
      schema: 'openslack.workflow_run_routing_policy.v1',
      workspaceId: config.workspaceId,
      backend: 'go',
      routingEpoch: 9,
      authorityBuildHash: HASH,
      qualificationEnvironmentId: 'hosted-canary.test',
      workflowAllowlist: [manifest.name],
      runAllowlist: [],
      expiresAt: '2026-08-14T00:00:00.000Z',
    });
    const existing = scenario.startsWith('existing-');
    const existingRoute = existing
      ? router.select({
          workspaceId: config.workspaceId,
          runId,
          workflowId: manifest.name,
          workflowVersion: manifest.version!,
          workflowSourceHash: hashWorkflowRunnerV2Source(workflowSourceBytes),
          manifestHash: hashWorkflowRunnerV2Manifest(manifest),
          inputHash: hashWorkflowRunnerV2Input({}),
          correlationId: 'correlation.go.existing',
          selectedAt: NOW,
        })
      : undefined;
    if (existingRoute) {
      const initial = workflowControlAuthorityInitialRecord(existingRoute);
      const state =
        scenario === 'existing-running'
          ? 'running'
          : scenario === 'existing-paused'
            ? 'paused'
            : scenario === 'existing-paused-waiting-approval'
              ? 'paused_waiting_approval'
              : scenario === 'existing-resuming'
                ? 'resuming'
                : 'completed';
      record = {
        ...initial,
        state,
        revision: 7,
        currentPhaseId: state === 'running' ? null : 'phase-1',
        currentPhaseIndex: state === 'running' ? null : 0,
        resumeGeneration: state === 'resuming' ? 1 : 0,
        ...(scenario === 'existing-identity-drift' ? { workflowId: 'workflow.drifted' } : {}),
      };
    }
    const client: WorkflowRunnerStatusPort = {
      descriptorRoot,
      async waitForTerminal(jobId) {
        const projection = new RunStore({
          access: createWorkflowRunStoreRecoveryAccess(),
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
        record = { ...record!, state: 'completed', revision: record!.revision + 1 };
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
    let frozen: WorkflowRunRouteReceipt | undefined = existingRoute;
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
        if (scenario === 'accept-response-loss-created') {
          throw new Error('accept response lost');
        }
        return {} as never;
      }),
      transition: vi.fn(async (next, expected, correlationId) => {
        expect(expected).toEqual({
          revision: 1,
          state: 'created',
          currentPhaseId: null,
          currentPhaseIndex: null,
          resumeGeneration: 0,
        });
        expect(next).toMatchObject({ state: 'running', revision: 2 });
        expect(correlationId).toBe(frozen!.correlationId);
        if (scenario === 'transition-uncommitted') {
          throw new Error('transition was not committed');
        }
        record = next;
        if (scenario === 'transition-response-loss-running') {
          throw new Error('transition response lost');
        }
        return {} as never;
      }),
      read: vi.fn(async () => ({
        ...record!,
        schema: 'openslack.workflow_control_authority_read.v2' as const,
        recordHash: authorityRecordHash(record!),
        record: record!,
        updatedAt: NOW,
      })),
      readIfExists: vi.fn(async () => ({
        ...record!,
        schema: 'openslack.workflow_control_authority_read.v2' as const,
        recordHash: authorityRecordHash(record!),
        record: record!,
        updatedAt: NOW,
      })),
    };

    const execution = executeWorkflowThroughRunnerWithRuntime({
      workspaceRoot,
      workflowRunId: runId,
      workflowSource: 'openslack-project',
      workflowSourceBytes,
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
        router,
        journal: {
          async load() {
            return existingRoute ?? null;
          },
          async locate() {
            return existingRoute ? { receipt: existingRoute, state: 'active' as const } : null;
          },
          async locateReadOnly() {
            return existingRoute ? { receipt: existingRoute, state: 'active' as const } : null;
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
    });

    if (scenario === 'transition-uncommitted') {
      await expect(execution).rejects.toMatchObject({
        code: 'WORKFLOW_RUNNER_CONTROL_RECONCILIATION_REQUIRED',
        cause: expect.any(Error),
      });
      expect(authority.accept).toHaveBeenCalledTimes(1);
      expect(authority.transition).toHaveBeenCalledTimes(1);
      expect(authority.readIfExists).toHaveBeenCalledTimes(1);
      expect(v2Submit).not.toHaveBeenCalled();
      return;
    }

    if (scenario === 'existing-terminal' || scenario === 'existing-identity-drift') {
      await expect(execution).rejects.toMatchObject({
        code: 'WORKFLOW_RUNNER_CONTROL_RECONCILIATION_REQUIRED',
      });
      expect(authority.accept).not.toHaveBeenCalled();
      expect(authority.transition).not.toHaveBeenCalled();
      expect(authority.readIfExists).toHaveBeenCalledTimes(1);
      expect(v2Submit).not.toHaveBeenCalled();
      return;
    }

    await expect(execution).resolves.toEqual(output);

    expect(frozen).toMatchObject({
      runId,
      route: { backend: 'go', authority: 'workflow-control', routingEpoch: 9 },
    });
    expect(authority.accept).toHaveBeenCalledTimes(existing ? 0 : 1);
    expect(authority.transition).toHaveBeenCalledTimes(existing ? 0 : 1);
    expect(authority.readIfExists).toHaveBeenCalledTimes(
      existing || scenario !== 'nominal' ? 1 : 0,
    );
    expect(authority.read).toHaveBeenCalledTimes(1);
    expect(v2Submit).toHaveBeenCalledTimes(1);
    expect(preparedV2?.spec.runRevision).toBe(existing ? 7 : 2);
    expect(preparedV2?.spec.resumeGeneration).toBe(scenario === 'existing-resuming' ? 1 : 0);
    await expect(
      new RunStore({
        access: createWorkflowRunStoreRecoveryAccess(),
        baseDir: join(workspaceRoot, '.openslack.local', 'workflows'),
      }).runExists(runId),
    ).resolves.toBe(false);
  });

  it('fails closed before v1 submission when no explicit Go route exists', async () => {
    const value = await fixture();
    await expect(
      executeWorkflowThroughRunnerWithRuntime({
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
        routing: {
          mode: 'disabled',
          journal: new WorkflowRunRouteJournal(
            join(value.workspaceRoot, '.openslack.local', 'workflows', 'routes'),
          ),
          fingerprint: HASH,
          diagnostics: [],
        },
      }),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_CONTROL_TS_MUTATION_RETIRED',
      message: 'New workflow execution requires an explicit Go authority route.',
    });
    await expect(
      access(join(value.workspaceRoot, '.openslack.local', 'workflows', 'routes')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an existing TypeScript route without changing its receipt or submitting v1', async () => {
    const value = await fixture();
    const routeRoot = join(value.workspaceRoot, '.openslack.local', 'workflows', 'routes');
    const journal = new WorkflowRunRouteJournal(routeRoot);
    await journal.initialize();
    const router = new WorkflowRunRouter({
      schema: 'openslack.workflow_run_routing_policy.v1',
      workspaceId: value.config.workspaceId,
      backend: 'go',
      routingEpoch: 8,
      authorityBuildHash: HASH,
      qualificationEnvironmentId: 'retired-ts.test',
      workflowAllowlist: [manifest.name],
      runAllowlist: [],
      expiresAt: '2026-08-14T00:00:00.000Z',
    });
    const receipt: WorkflowRunRouteReceipt = {
      schema: 'openslack.workflow_run_route_receipt.v1',
      workspaceId: value.config.workspaceId,
      runId: value.workflowRunId,
      workflowId: manifest.name,
      workflowVersion: manifest.version!,
      workflowSourceHash: HASH,
      manifestHash: HASH,
      inputHash: HASH,
      route: {
        backend: 'ts-local',
        authority: 'typescript',
        routingEpoch: 7,
        authorityBuildHash: HASH,
      },
      policyHash: HASH,
      correlationId: 'correlation.ts.historical',
      qualificationEnvironmentId: 'historical-ts.test',
      selectedAt: NOW,
      expiresAt: '2026-08-14T00:00:00.000Z',
    };
    await writeExclusive(
      join(routeRoot, 'active', routeName(value.workflowRunId)),
      `${canonicalWorkflowControlAuthorityJson(receipt)}\n`,
      productionJournalSecurity(),
    );

    await expect(
      executeWorkflowThroughRunnerWithRuntime({
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
        routing: {
          mode: 'explicit',
          router,
          journal,
          fingerprint: HASH,
          diagnostics: [],
        },
        now: () => new Date(NOW),
      }),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_CONTROL_TS_MUTATION_RETIRED',
      message: 'TypeScript-owned workflow runs are read-only and require operator recovery.',
    });
    await expect(journal.load(value.workflowRunId)).resolves.toEqual(receipt);
  });
});

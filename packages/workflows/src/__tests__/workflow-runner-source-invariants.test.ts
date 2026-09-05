import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateWorkflowRunnerExecutionDescriptor } from '../workflow-runner-descriptor.js';

async function source(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), 'utf8');
}

function commandPath(command: 'bun' | 'node'): string {
  const resolved = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  })
    .split(/\r?\n/u)
    .find((entry) => entry.trim().length > 0);
  if (resolved === undefined) throw new Error(`${command} executable is unavailable.`);
  return resolved.trim();
}

describe('GS9-I TypeScript writer deletion invariants', () => {
  it('physically removes TypeScript writer composition while preserving read-only evidence', async () => {
    const [
      index,
      collaboration,
      tuiExecutors,
      tuiComposition,
      tuiRuns,
      execution,
      runnerServer,
      runnerHandlers,
      workflowRuns,
      workflowControlContract,
      demo,
      routing,
      routingConfig,
      inspection,
      projection,
      goProjection,
      runStore,
      recoveryAccess,
      execute,
      worker,
      workerBin,
      runnerConfig,
      workerRegistry,
      scheduler,
    ] = await Promise.all([
      source('packages/workflows/src/index.ts'),
      source('apps/cli/src/commands/collaboration.ts'),
      source('apps/cli/src/commands/tui-executors.ts'),
      source('apps/cli/src/commands/tui.ts'),
      source('packages/tui/src/views/WorkflowRunsView.tsx'),
      source('packages/workflows/src/workflow-runner-execution-client.ts'),
      source('services/workflow-control/internal/runnerapp/server.go'),
      source('services/workflow-control/internal/runnerapp/handlers.go'),
      source('packages/workflows/src/workflow-runs.ts'),
      source('docs/architecture/contracts/workflow-control.md'),
      source('scripts/demo-ai-org-rehearse.ts'),
      source('packages/workflows/src/workflow-run-routing.ts'),
      source('packages/workflows/src/workflow-run-routing-config.ts'),
      source('packages/workflows/src/workflow-run-readonly-inspection.ts'),
      source('packages/workflows/src/workflow-run-projection.ts'),
      source('packages/workflows/src/workflow-runner-v2-go-projection-store.ts'),
      source('packages/workflows/src/run-store.ts'),
      source('packages/workflows/src/internal/workflow-run-store-recovery-access.ts'),
      source('packages/workflows/src/execute.ts'),
      source('packages/workflows/src/workflow-runner-worker.ts'),
      source('packages/workflows/src/workflow-runner-worker-bin.ts'),
      source('services/workflow-control/internal/runnerconfig/config.go'),
      source('services/workflow-control/internal/workerregistry/registry.go'),
      source('services/workflow-control/internal/runnerscheduler/scheduler.go'),
    ]);
    expect(index).not.toMatch(/\bexecuteRun\b/u);
    expect(index).not.toMatch(/\bexecuteResume\b/u);
    expect(index).not.toMatch(/\bcontrolWorkflowRun\b/u);
    expect(index).not.toMatch(/\bRunStore\b/u);
    expect(index).not.toMatch(/\bRunStoreFs\b/u);
    expect(index).not.toMatch(/\bRunStoreOptions\b/u);
    expect(index).not.toMatch(/\bcreateRuntime\b/u);
    expect(index).not.toMatch(/\bRuntimeOptions\b/u);
    expect(index).not.toMatch(/\bforceResume\b/u);
    expect(index).not.toMatch(/\bcreateWorkflowRunProjectionStore\b/u);
    expect(index).not.toMatch(/\bWorkflowRunnerSession\b/u);
    expect(index).not.toMatch(/\bWorkflowRunnerControlClient\b/u);
    expect(index).not.toMatch(/\bWORKFLOW_RUN_ROUTING_MODE_TS_ROLLBACK\b/u);
    expect(index).toContain('openWorkflowRunReadOnly');
    expect(collaboration).toContain('executeWorkflowThroughRunner');
    expect(collaboration).not.toMatch(/\bexecuteRun\(/u);
    expect(collaboration).not.toMatch(/\bexecuteResume\(/u);
    expect(collaboration).not.toMatch(/\bcontrolWorkflowRun\b/u);
    expect(collaboration).not.toContain('new RunStore');
    expect(collaboration).toContain('journal.locateReadOnly(runId)');
    expect(collaboration).toContain('for the closed authority view');
    expect(collaboration).not.toContain('journal.load(runId)');
    expect(collaboration).not.toContain('journal.locate(runId)');
    expect(tuiExecutors).not.toContain('executeResume');
    expect(tuiExecutors).not.toContain('new RunStore');
    expect(tuiExecutors).not.toContain('controlWorkflowRun');
    expect(tuiExecutors).toContain('WORKFLOW_RUNNER_CONTROL_TS_MUTATION_RETIRED');
    expect(tuiComposition).not.toContain('new RunStore');
    expect(tuiComposition).not.toContain('...pausedRuns.map');
    expect(tuiRuns).not.toContain('controlWorkflowRun');
    expect(tuiRuns).not.toContain("applyAction('resume')");
    expect(execution).toContain('journal.locateReadOnly(workflowRunId)');
    expect(execution).not.toContain('journal.load(workflowRunId)');
    expect(runnerServer).toContain('http.HandlerFunc(service.handleRetiredV1Submit)');
    expect(runnerServer).not.toContain('http.HandlerFunc(service.handleSubmit)');
    expect(runnerHandlers).toContain('WORKFLOW_RUNNER_TS_MUTATION_RETIRED');
    expect(execution).toContain('WORKFLOW_RUNNER_CONTROL_TS_MUTATION_RETIRED');
    expect(workflowControlContract).toContain('`WORKFLOW_RUNNER_TS_MUTATION_RETIRED`');
    expect(workflowControlContract).toContain('`WORKFLOW_RUNNER_CONTROL_TS_MUTATION_RETIRED`');
    expect(workflowRuns).not.toMatch(/\bcontrolWorkflowRun\b/u);
    expect(execution).not.toContain('prepareWorkflowRunnerJobSpec');
    expect(execution).not.toContain('WORKFLOW_RUNNER_JOB_SPEC_SCHEMA');
    expect(runnerHandlers).not.toContain('func (service *Service) handleSubmit(');
    expect(demo).toContain('executeWorkflowThroughRunner');
    expect(demo).not.toMatch(/\bexecuteRun\(/u);
    expect(routing).toContain('export function createWorkflowRunRouteJournal');
    for (const consumer of [collaboration, routingConfig, inspection]) {
      expect(consumer).toContain('createWorkflowRunRouteJournal');
      expect(consumer).not.toContain("'.openslack.local', 'workflows', 'routes'");
    }
    for (const cli of [collaboration, tuiExecutors]) {
      expect(cli).not.toContain('workflow-runner-worker');
      expect(cli).not.toContain('OPENSLACK_WORKFLOW_RUNNER_ENABLED');
    }
    expect(projection).toContain('export function openWorkflowRunReadOnly(');
    expect(projection).toContain("access: 'read-only'");
    expect(projection).not.toContain('createWorkflowRunProjectionStore');
    expect(runStore).not.toContain("'go-recovery-projection'");
    expect(runStore).toContain('isWorkflowRunStoreRecoveryAccess(options.access)');
    expect(recoveryAccess).toContain('new WeakSet<object>()');
    expect(goProjection).toContain('createWorkflowRunStoreRecoveryAccess()');
    expect(index).not.toContain('createWorkflowRunStoreRecoveryAccess');
    expect(execute).toContain('export async function executeGoAuthorityRun(');
    expect(execute).toContain('export async function executeGoAuthorityResume(');
    expect(execute).toContain('WorkflowRunnerV2GoProjectionRunStore');
    expect(execute).not.toMatch(/export async function executeRun\(/u);
    expect(execute).not.toMatch(/export async function executeResume\(/u);
    expect(execute).not.toContain('storeOverride');
    expect(execute).not.toContain('new RunStore');
    for (const retired of [
      'OPENSLACK_WORKFLOW_RUNNER_ENABLED',
      'OPENSLACK_WORKFLOW_RUNNER_V2_QUALIFICATION_ENABLED',
    ]) {
      expect(worker).not.toContain(retired);
      expect(workerBin).not.toContain(retired);
      expect(runnerConfig).not.toContain(retired);
      expect(workerRegistry).toContain(`"${retired}":`);
    }
    expect(worker).not.toContain("mode: 'qualification'");
    expect(worker).not.toContain('new RunStore');
    expect(worker).toContain('executeWorkflowRunnerV2AuthorityJob');
    expect(workerBin).toContain('runWorkflowRunnerV2Worker');
    expect(scheduler).not.toContain('NewSupervisorForProtocol');
    expect(routingConfig).not.toContain('ts-new-record-rollback-v1');
    expect(routing).toContain('New TypeScript workflow routing is retired.');
    expect(routing).toContain('TypeScript route receipts are historical evidence');
  });

  it('keeps wire descriptors closed against command, module-path, URL, and GS9 state', () => {
    const base = {
      schema: 'openslack.workflow_runner_execution_descriptor.v1',
      descriptorRef: 'descriptor.invariant.1',
      workspaceId: 'workspace.test',
      workflowRunId: 'run.invariant.1',
      correlationId: 'correlation.invariant.1',
      workflowId: 'workflow-test',
      workflowVersion: '1.0.0',
      workflowSource: 'openslack-project',
      workflowSourceHash: 'a'.repeat(64),
      manifestHash: 'b'.repeat(64),
      inputHash: 'c'.repeat(64),
      input: {},
      budget: { tokens: 1, costUsd: 0 },
      confirmationPolicy: {
        mode: 'unattended-explicit',
        actorId: 'actor.test',
        runId: 'run.invariant.1',
        allowUnattended: true,
        onUnexpectedEffect: 'fail',
      },
      createdAt: '2026-08-04T01:00:00.000Z',
      expiresAt: '2026-08-04T02:00:00.000Z',
    } as const;
    for (const [field, value] of [
      ['command', 'node'],
      ['modulePath', '/tmp/evil.mjs'],
      ['url', 'https://example.test/worker'],
      ['checkpoint', 4],
      ['resumeCursor', 'cursor'],
      ['authorityEpoch', 9],
    ] as const) {
      expect(() => validateWorkflowRunnerExecutionDescriptor({ ...base, [field]: value })).toThrow(
        /missing or unknown fields/u,
      );
    }
  });

  it('locates workflow module import only behind the accepted v2 receipt gate', async () => {
    const [session, worker, fileLoader] = await Promise.all([
      source('packages/workflows/src/workflow-runner-v2-session.ts'),
      source('packages/workflows/src/workflow-runner-worker.ts'),
      source('packages/workflows/src/internal/workflow-file-loader.ts'),
    ]);
    const accept = session.indexOf("'lease_accept',");
    const execute = session.indexOf('void this.#executeLease().catch', accept);
    const load = session.indexOf('this.#options.sourceLoader.load', execute);
    expect(accept).toBeGreaterThan(-1);
    expect(execute).toBeGreaterThan(accept);
    expect(load).toBeGreaterThan(execute);
    expect(worker).toContain(
      "import { loadWorkflowFile } from './internal/workflow-file-loader.js'",
    );
    expect(worker.indexOf('loadWorkflowFile(prepared.path')).toBeGreaterThan(
      worker.indexOf('async load('),
    );
    expect(fileLoader).toContain('await import(moduleUrl.href)');
    expect(fileLoader).not.toContain('import.meta.dirname');
    expect(fileLoader).not.toContain('builtins');
    expect(fileLoader).not.toContain('templates');
    expect(worker.indexOf("await import('./execute.js')")).toBeGreaterThan(-1);
    expect(worker.indexOf("await import('./execute.js')")).toBeGreaterThan(
      worker.indexOf('execute: (workflow'),
    );
    expect(worker).not.toContain('export async function executeWorkflowRunnerJob');
  });

  it('keeps mutation authority out of every public execution surface', async () => {
    const [index, packageJson, workerPublic, execute, routingConfig, runtime, types] =
      await Promise.all([
        source('packages/workflows/src/index.ts'),
        source('packages/workflows/package.json'),
        source('packages/workflows/src/workflow-runner-worker-public.ts'),
        source('packages/workflows/src/execute.ts'),
        source('packages/workflows/src/workflow-run-routing-config.ts'),
        source('packages/workflows/src/runtime.ts'),
        source('packages/workflows/src/types.ts'),
      ]);
    expect(index).not.toContain('createWorkflowCheckpointLeaseAuthority');
    expect(index).not.toContain('WorkflowCheckpointLeaseAuthority');
    expect(JSON.parse(packageJson).exports).toEqual({
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
      },
      './workflow-runner-worker': {
        types: './dist/workflow-runner-worker-public.d.ts',
        import: './dist/workflow-runner-worker-public.js',
      },
    });
    expect(workerPublic).toContain('runWorkflowRunnerV2Worker');
    expect(workerPublic).toContain('loadWorkflowRunnerV2WorkerConfig');
    expect(workerPublic).not.toContain('executeWorkflowRunnerV2AuthorityJob');
    expect(workerPublic).not.toContain('createWorkflowRunnerV2ProviderAttemptPort');
    expect(index).not.toContain('GoAuthorityWorkflowExecutionOptions');
    expect(index).not.toContain('executeGoAuthorityRun');
    expect(index).not.toContain('executeGoAuthorityResume');
    expect(index).not.toContain('executeWorkflowThroughRunnerWithRuntime');
    expect(index).not.toContain('WorkflowRunnerExecutionRuntimeInput');
    for (const internalWorkerComposition of [
      'WorkflowRunnerAuthorityBindingRuntime',
      'WorkflowRunnerV2RuntimeDelivery',
      'WorkflowRunnerV2Session',
      'createWorkflowRunnerAuthorityBindingClient',
      'createWorkflowRunnerV2RuntimeAdmissionClient',
      'createWorkflowRunnerBudgetAuthorityClient',
      'createWorkflowRunnerV2EffectAuthorizationPort',
      'createWorkflowRunnerCheckpointSourceAdapter',
      'createWorkflowRunnerEffectSourceAdapter',
      'createWorkflowRunnerResumeSourceAdapter',
    ]) {
      expect(index).not.toContain(internalWorkerComposition);
    }
    const publicExecutionInput = execute.slice(
      execute.indexOf('export interface ExecuteWorkflowThroughRunnerInput'),
      execute.indexOf('/** @internal Closed test/runtime seam'),
    );
    expect(publicExecutionInput).not.toMatch(/readonly (?:config|client|routing|now)\??:/u);
    const publicRoutingFactory = routingConfig.slice(
      routingConfig.indexOf('export function createWorkflowRunRoutingExecutionContext'),
      routingConfig.length,
    );
    expect(publicRoutingFactory).not.toMatch(/input\.(?:authority|v2Client|journal)/u);
    expect(execute).toContain('checkpointAuthority: WorkflowCheckpointLeaseAuthority');
    expect(execute).toContain('effectAuthorizationPort: WorkflowEffectAuthorizationPort');
    expect(
      runtime.slice(
        runtime.indexOf('export function createRuntime('),
        runtime.indexOf('/** @internal Accepted worker path'),
      ),
    ).not.toMatch(
      /WorkflowCheckpointLeaseAuthority|WorkflowEffectAuthorizationPort|claimStore|approvalRecord|humanDecision|attestationNonce/u,
    );
    const runtimeOptions = runtime.slice(
      runtime.indexOf('export interface RuntimeOptions'),
      runtime.indexOf('export interface RuntimeWithPersistence'),
    );
    expect(runtimeOptions).not.toMatch(
      /authorizationPort|claimStore|approvalRecord|humanDecision|attestationNonce/u,
    );
    expect(types).not.toMatch(
      /WorkflowEffectAuthorizationPort|WorkflowEffectClaimAuthorization|LocalWorkflowEffectAuthorityStore/u,
    );
    expect(index).not.toMatch(
      /createWorkflowEffectAuthorizationPort|WorkflowEffectAuthorizationPort|LocalWorkflowEffectAuthorityStore/u,
    );
  });

  it('enforces source closure only in GS8 prepare and delegates the bundle recipe', async () => {
    const [worker, legacyLoader, packageJson, bundleTool] = await Promise.all([
      source('packages/workflows/src/workflow-runner-worker.ts'),
      source('packages/workflows/src/loader.ts'),
      source('packages/workflows/package.json'),
      source('scripts/qualification/workflow-runner-bundle.ts'),
    ]);
    const prepare = worker.indexOf('async prepare(');
    const policy = worker.indexOf('assertWorkflowRunnerSourceIsSelfContained(source.bytes)');
    const load = worker.indexOf('async load(', prepare);
    expect(prepare).toBeGreaterThan(-1);
    expect(policy).toBeGreaterThan(prepare);
    expect(policy).toBeLessThan(load);
    expect(legacyLoader).not.toContain('assertWorkflowRunnerSourceIsSelfContained');

    const packageDocument = JSON.parse(packageJson) as {
      scripts?: Record<string, string>;
    };
    expect(packageDocument.scripts?.['build:runner-worker']).toBe(
      'bun ../../scripts/qualification/workflow-runner-bundle.ts build',
    );
    expect(bundleTool).toContain("const STAGED_ENTRYPOINT = 'workflow-runner-worker.cjs'");
    expect(bundleTool).toContain('await chmod(executablePath, 0o700)');
    expect(bundleTool).toContain('Staged Node executable must be owner-executable.');
  });

  it('builds and starts the path-free CJS artifact under a type-module ancestor', () => {
    const nodeExecutable = realpathSync(commandPath('node'));
    const output = execFileSync(
      commandPath('bun'),
      [
        resolve(process.cwd(), 'scripts/qualification/workflow-runner-bundle.ts'),
        'verify-local',
        '--node-executable',
        nodeExecutable,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(output).toMatch(/workflow-runner-bundle sha256=[0-9a-f]{64} bytes=[1-9][0-9]*/u);
  }, 130_000);
});

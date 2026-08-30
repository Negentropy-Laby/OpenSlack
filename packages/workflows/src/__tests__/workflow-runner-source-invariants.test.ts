import { execFileSync } from 'node:child_process';
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

describe('GS8-B source and authority invariants', () => {
  it('keeps public CLI execution behind runner control and legacy TUI gates nonauthorizing', async () => {
    const [collaboration, tuiExecutors] = await Promise.all([
      source('apps/cli/src/commands/collaboration.ts'),
      source('apps/cli/src/commands/tui-executors.ts'),
    ]);
    expect(collaboration).toContain('executeWorkflowThroughRunner');
    expect(collaboration).not.toMatch(/\bexecuteRun\(/u);
    expect(collaboration).not.toMatch(/\bexecuteResume\(/u);
    expect(tuiExecutors).not.toContain('executeResume');
    expect(tuiExecutors).toContain('effectDecisionAuthority: false');
    for (const cli of [collaboration, tuiExecutors]) {
      expect(cli).not.toContain('workflow-runner-worker');
      expect(cli).not.toContain('OPENSLACK_WORKFLOW_RUNNER_ENABLED');
    }
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

  it('locates workflow module import only behind the accepted-receipt session gate', async () => {
    const [session, worker, fileLoader] = await Promise.all([
      source('packages/workflows/src/workflow-runner-session.ts'),
      source('packages/workflows/src/workflow-runner-worker.ts'),
      source('packages/workflows/src/internal/workflow-file-loader.ts'),
    ]);
    const accept = session.indexOf("await this.#emitReceiptable('lease_accept'");
    const execute = session.indexOf('void this.#executeLease()');
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
    expect(worker.indexOf("await import('./execute.js')")).toBeGreaterThan(
      worker.indexOf('execute: async'),
    );
    expect(worker).not.toContain('export async function executeWorkflowRunnerJob');
  });

  it('keeps checkpoint lease authority out of every public execution surface', async () => {
    const [index, packageJson, execute, runtime, types] = await Promise.all([
      source('packages/workflows/src/index.ts'),
      source('packages/workflows/package.json'),
      source('packages/workflows/src/execute.ts'),
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
        types: './dist/workflow-runner-worker.d.ts',
        import: './dist/workflow-runner-worker.js',
      },
    });
    const publicRun = execute.slice(
      execute.indexOf('export async function executeRun('),
      execute.indexOf('/** @internal Worker authority path'),
    );
    const publicResume = execute.slice(
      execute.indexOf('export async function executeResume('),
      execute.indexOf('/** @internal Worker authority path', execute.indexOf('executeResume(')),
    );
    expect(publicRun).not.toContain('checkpointAuthority');
    expect(publicResume).not.toContain('checkpointAuthority');
    expect(publicRun).not.toMatch(/effectAuthorization|executionClaim|approvalStore/u);
    expect(publicResume).not.toMatch(/effectAuthorization|executionClaim|approvalStore/u);
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
    const nodeExecutable = commandPath('node');
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

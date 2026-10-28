import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChildProcess, execFileSync } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as HarnessRead from '../harness-read.js';
import { readHarnessFile } from '../harness-read.js';
import { createHarnessTaskExecution, inspectHarnessTaskExecution, hashHarnessDeployment, hashHarnessRuntimeArtifacts } from '../harness-task-execution.js';
import { hashHarnessNodeExecutable, hashHarnessPluginArtifacts } from '../harness-artifacts.js';
import { hashHarnessInput } from '../harness-admission.js';
import { createRunStore } from '../run-store.js';
import { buildHarnessTaskPermissionProfile } from '../harness-permissions.js';
import { HarnessTaskHost, hashHarnessTask, type ApprovedHarnessTask } from '../harness-task-host.js';
import { createHarnessTaskEligibility } from '../harness-eligibility.js';
import { createHarnessTaskAuthority } from '../harness-task-authority.js';
import { resolveAgentPrincipal } from '@openslack/runtime';

vi.mock('../harness-read.js', async original => {
  const actual = await original<typeof HarnessRead>();
  return { ...actual, readHarnessFile: vi.fn(actual.readHarnessFile) };
});
const reads = vi.mocked(readHarnessFile);
const nativeRead = reads.getMockImplementation()!;
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); reads.mockReset().mockImplementation(nativeRead); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('fresh phase-local deployment observations', () => {
  it.runIf(process.env.DEEPSEEK_HARNESS_CHECKOUT)('keeps a production required lease effective across concrete deployment observation before any peer, SDK or model starts', async () => {
    const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const pluginRoot = join(repository, 'integrations/deepseek-harness');
    const harnessRoot = resolve(process.env.DEEPSEEK_HARNESS_CHECKOUT!);
    const { prepareSdkFixture } = await import(pathToFileURL(join(pluginRoot, 'tests/fixtures/sdk-profile.ts')).href) as {
      prepareSdkFixture(root: string, script: string[]): { home: string; patch: string; workspace: string };
    };
    const root = mkdtempSync(join(tmpdir(), 'harness-start-lease-')); roots.push(root);
    const profile = prepareSdkFixture(root, ['Keyless fixture; no real credential or network model.']);
    const workspaceRoot = profile.workspace;
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: workspaceRoot, encoding: 'utf8' }).trim();
    git('init', '--initial-branch=main'); git('add', 'fixture.txt');
    git('-c', 'user.name=Keyless Harness Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture baseline');
    const baseline = git('rev-parse', 'HEAD');
    // Synthetic files are confined to this test's temporary root. The production
    // resolver/authority read them; they are not a provisioned integration identity.
    const agentId = 'fixture', principalId = 'principal:fixture', uid = 'fixture-uid', runtimeRunId = 'RUN-start-lease-fixture';
    const registry = join(workspaceRoot, '.openslack/agents/registry');
    const identity = join(workspaceRoot, '.openslack.local/agents', agentId);
    mkdirSync(registry, { recursive: true }); mkdirSync(identity, { recursive: true });
    writeFileSync(join(registry, `${agentId}.yaml`), JSON.stringify({
      schema: 'openslack.agent_registry.v2', agent_id: agentId, display_name: 'Synthetic start lease fixture',
      identity: { uid, principal_id: principalId, public_key_jwk: null, key_id: null,
        key_rotation: { last_rotated_at: null, rotation_interval_days: 90 }, status: 'active' },
      vendor: { provider: 'test', runtime: 'cli' }, employment: { status: 'active', hired_at: '2026-01-01T00:00:00.000Z' },
      capabilities: { primary: ['harness_fixture'], secondary: [] },
      repositories: { workspace_repo: { owner: 'test', repo: 'OpenSlack', default_branch: 'main' } },
      permissions: { paths: { allow: ['fixture.txt'], deny: [] }, actions: { 'harness.task.dispatch': 'allow', 'harness.task.report': 'allow' },
        github: { can_create_pr: false, can_comment: false, can_approve: false, can_merge: false }, max_risk_zone: 'yellow' },
      execution: {}, output_contract: { must_create: [], may_create: [], must_not_create: [] }, approval_rules: { require_human_approval_for: [] },
    }));
    writeFileSync(join(identity, 'identity.yaml'), JSON.stringify({ schema: 'openslack.agent_runtime_identity.v1', agent_id: agentId,
      agent_uid: uid, run_id: runtimeRunId, public_key_jwk: null, key_id: null, key_generated_at: null, provider: 'cli', started_at: '2026-07-28T00:00:00.000Z' }));
    const principal = resolveAgentPrincipal({ root: workspaceRoot, agentId, provider: 'cli' });
    if ('error' in principal) throw new Error('Synthetic phase fixture production principal did not resolve');
    const deployment = { harnessRoot, pluginRoot, pluginBuildHash: hashHarnessPluginArtifacts(pluginRoot),
      nodeExecutable: process.execPath, nodeVersion: '24.18.1' as const, nodeSha256: hashHarnessNodeExecutable(process.execPath),
      dshHome: profile.home, agentId, provider: 'openslack-fixture', model: 'fixture', workerPatch: profile.patch, exitGraceMs: 30_000 };
    const verification = { resultMode: 'text' as const, requireReport: false, checks: [{ path: 'fixture.txt', expectedText: 'before' }] };
    const config = { agentId, source: 'fixture', runtimeProvider: 'deepseek-harness', model: 'fixture', tools: ['Read', 'Write', 'Edit'], permissionMode: 'acceptEdits' as const };
    const definition: Omit<ApprovedHarnessTask, 'principalHash'> = { taskId: 'TASK-START-LEASE', baseline, timeoutMs: 240_000,
      request: { agentId, prompt: 'Return the fixed keyless fixture result.', resolvedConfig: config, permissionProfile: buildHarnessTaskPermissionProfile(config) },
      scope: { readPaths: ['fixture.txt'], writePaths: ['fixture.txt'], forbiddenPaths: ['.git/**'] }, outputSchema: { type: 'object' },
      executionBuildHash: hashHarnessRuntimeArtifacts(harnessRoot), verificationHash: hashHarnessInput(verification), deploymentHash: hashHarnessDeployment(deployment) };
    const base = Date.now(), leaseExpiresAt = base + 100;
    let expired = false, executing = false, observedNode = false, executionFailure: unknown;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => expired ? leaseExpiresAt + 1 : base);
    const authority = createHarnessTaskAuthority({ identityRoot: workspaceRoot, agentId, uid, principalId, runtimeRunId, provider: 'cli', claimMode: 'required', source: {
      read: async () => ({ task: definition, allowedPaths: ['fixture.txt'], forbiddenPaths: ['.git/**'], claimRequired: true, sourceDigest: 'c'.repeat(64) }),
      readLease: async () => ({ owners: [principal.principal], expiresAt: new Date(leaseExpiresAt).toISOString(), claimRef: 'refs/heads/openslack/claims/fixture' }),
    } });
    const store = createRunStore(workspaceRoot, { sweepOrphans: false });
    const prepare = createHarnessTaskExecution({ workspaceRoot, identityRoot: workspaceRoot, store, deployment, authorizeTool: authority.authorizeTool, verification: () => verification });
    let peerStarts = 0;
    const diagnostic = channel('child_process');
    const observe = (value: unknown) => {
      if (!value || typeof value !== 'object' || !('process' in value) || !(value.process instanceof ChildProcess)) return;
      const child = value.process;
      child.once('spawn', () => { if (child.spawnargs.includes(join(pluginRoot, 'dist/startup.js'))) peerStarts++; });
    };
    diagnostic.subscribe(observe);
    reads.mockImplementation((path, ...args) => {
      const result = nativeRead(path, ...args);
      if (executing && path === process.execPath) { observedNode = true; expired = true; }
      return result;
    });
    const host = new HarnessTaskHost({ identityRoot: workspaceRoot, workspaceId: 'start-lease-fixture', principalId, store,
      readTask: authority.readTask, authorize: authority.authorize, publish: async () => {},
      prepare: async (...args) => {
        const execution = await prepare(...args);
        return { ...execution, execute: async (...executeArgs) => {
          executing = true;
          try { return await execution.execute(...executeArgs); }
          catch (error) { executionFailure = error; throw error; }
        } };
      } });
    try {
      const planId = 'GPLAN-start-lease-fixture', executionId = 'GEXEC-start-lease-fixture', confirmationAttemptId = 'start-lease-attempt';
      const receipt = await host.dispatch(definition.taskId, 'start-lease-request', true, { planId, executionId, confirmationAttemptId });
      // Only this trusted test invokes the existing settlement observer. The
      // actual durable governed service is independently covered by MCP tests.
      host.settleConfirmedAdmissions(planId, { state: 'succeeded', executionId, confirmationAttemptId });
      await vi.waitFor(() => expect(store.getRun(receipt.runId)?.status).toBe('failed'), { timeout: 30_000 });
      expect(observedNode).toBe(true);
      expect(executionFailure).toBeInstanceOf(Error);
      expect((executionFailure as Error).message).toMatch(/eligibility observation.*lease expired/);
      const requests = join(root, 'requests.jsonl');
      expect({ peerStarts, modelRequests: existsSync(requests) ? readFileSync(requests, 'utf8').trim().split('\n').filter(Boolean).length : 0 })
        .toEqual({ peerStarts: 0, modelRequests: 0 });
      expect(readFileSync(join(store.getRun(receipt.runId)!.worktreePath!, 'fixture.txt'), 'utf8')).toBe('before');
      expect(store.getRun(receipt.runId)?.harnessExecution?.acceptance).not.toBe('verified');
    } finally {
      await host.close(30_000); diagnostic.unsubscribe(observe); clock.mockRestore(); reads.mockImplementation(nativeRead);
    }
  }, 60_000);

  // Each behavioral probe owns its complete profile, worktree and run. Sharing
  // setup code must not share mutable state or cache a prior phase's authority.
  async function phaseFixture() {
    const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const pluginRoot = join(repository, 'integrations/deepseek-harness');
    const harnessRoot = resolve(process.env.DEEPSEEK_HARNESS_CHECKOUT!);
    const { prepareSdkFixture } = await import(pathToFileURL(join(pluginRoot, 'tests/fixtures/sdk-profile.ts')).href) as {
      prepareSdkFixture(root: string, script: string[]): { home: string; patch: string; workspace: string };
    };
    const root = mkdtempSync(join(tmpdir(), 'harness-phase-observation-')); roots.push(root);
    // This public test fixture prepares only an isolated keyless profile. No SDK,
    // peer or model is started; original Harness/lib must already be built.
    const profile = prepareSdkFixture(root, ['unused; no model request']);
    const workspaceRoot = profile.workspace;
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: workspaceRoot, encoding: 'utf8' }).trim();
    git('init', '--initial-branch=main'); git('add', 'fixture.txt');
    git('-c', 'user.name=Keyless Harness Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture baseline');
    const baseline = git('rev-parse', 'HEAD');
    const deployment = { harnessRoot, pluginRoot, pluginBuildHash: hashHarnessPluginArtifacts(pluginRoot),
      nodeExecutable: process.execPath, nodeVersion: '24.18.1' as const, nodeSha256: hashHarnessNodeExecutable(process.execPath),
      dshHome: profile.home, agentId: 'fixture', provider: 'openslack-fixture', model: 'fixture', workerPatch: profile.patch, exitGraceMs: 30_000 };
    const verification = { resultMode: 'text' as const, requireReport: false, checks: [{ path: 'fixture.txt', expectedText: 'after' }] };
    const config = { agentId: 'fixture', source: 'fixture', runtimeProvider: 'deepseek-harness', model: 'fixture', tools: ['Read', 'Write', 'Edit'], permissionMode: 'acceptEdits' as const };
    const task: ApprovedHarnessTask = { taskId: 'TASK-PHASE-OBSERVATION', principalId: 'fixture-principal', principalHash: 'a'.repeat(64), baseline, timeoutMs: 240_000,
      request: { agentId: 'fixture', prompt: 'Update the approved fixture.', resolvedConfig: config, permissionProfile: buildHarnessTaskPermissionProfile(config) },
      scope: { readPaths: ['fixture.txt'], writePaths: ['fixture.txt'], forbiddenPaths: ['.git/**'] }, outputSchema: { type: 'object' },
      executionBuildHash: hashHarnessRuntimeArtifacts(harnessRoot), verificationHash: hashHarnessInput(verification), deploymentHash: hashHarnessDeployment(deployment) };
    const store = createRunStore(workspaceRoot, { sweepOrphans: false });
    const runId = 'RUN-PHASE-OBSERVATION';
    const initial = store.createRun({ ...task.request, runId });
    store.updateRun(runId, { harnessExecution: { schema: 'openslack.harness_execution.v1', taskId: task.taskId, requestHash: hashHarnessTask(task), principalHash: task.principalHash,
      baseline, acceptance: 'pending', summary: 'fixture', reports: {}, evidenceRefs: [],
      lifecycle: { phase: 'authorized', ownerGeneration: 'fixture-owner', deadlineAt: new Date(Date.parse(initial.startedAt) + task.timeoutMs).toISOString() } } });
    const prepare = createHarnessTaskExecution({ workspaceRoot, identityRoot: workspaceRoot, store, deployment,
      authorizeTool: async () => { throw new Error('Preparation cannot invoke a tool'); }, verification: () => verification });
    reads.mockClear();
    const prepared = await prepare(task, runId, new AbortController().signal);
    return { workspaceRoot, harnessRoot, store, runId, initial, task, deployment, verification, prepared };
  }

  it.runIf(process.env.DEEPSEEK_HARNESS_CHECKOUT)('measures real phase-local reads and rejects execute cutoffs before and during deployment observation', async () => {
    const { harnessRoot, store, runId, initial, task, prepared } = await phaseFixture();
    expect(prepared).toHaveProperty('execute');
    const observed = reads.mock.calls.map(([path]) => path);
    // These are observed reader calls, not inferred timing/cost estimates.
    expect(observed.filter(path => path === process.execPath)).toHaveLength(1);
    expect(observed.filter(path => path === join(harnessRoot, 'packages/sdk/server/package.json'))).toHaveLength(1);
    expect(store.getRun(runId)?.harnessExecution?.lifecycle?.executionDeadlineAt)
      .toBe(new Date(Date.parse(initial.startedAt) + task.timeoutMs - 30_000).toISOString());
    expect(store.getRun(runId)?.status).toBe('pending');
    const cutoff = Date.parse(store.getRun(runId)!.harnessExecution!.lifecycle!.executionDeadlineAt!);
    // Direct concrete phase probes explicitly model the already-started host
    // boundary; the real production start/CAS path is covered above.
    store.withRunTransaction(runId, current => ({ patch: { status: 'running', harnessExecution: { ...current.harnessExecution!,
      lifecycle: { ...current.harnessExecution!.lifecycle!, phase: 'started' } } } }));
    const executeEligibility = createHarnessTaskEligibility({ taskId: task.taskId, taskHash: hashHarnessTask(task), principalId: task.principalId!, principalHash: task.principalHash, phase: 'execute' }, { mode: 'not_applicable' });
    const clock = vi.spyOn(Date, 'now');
    // A stale relative duration cannot authorize a launch after later awaits.
    clock.mockReturnValue(cutoff + 1);
    await expect(prepared.execute(new AbortController().signal, executeEligibility)).rejects.toThrow('cutoff elapsed before deployment observation');
    clock.mockRestore();
    const duringObservation = vi.spyOn(Date, 'now');
    reads.mockImplementation((path, ...args) => {
      const result = nativeRead(path, ...args);
      if (path === process.execPath) duringObservation.mockReturnValue(cutoff + 1);
      return result;
    });
    await expect(prepared.execute(new AbortController().signal, executeEligibility)).rejects.toThrow('cutoff elapsed during deployment observation');
    expect(store.getRun(runId)?.status).toBe('running');
    duringObservation.mockRestore(); reads.mockImplementation(nativeRead);
  }, 60_000);

  it.runIf(process.env.DEEPSEEK_HARNESS_CHECKOUT)('rejects expired and unmatched acceptance before verifying the same fixture after its tool evidence is balanced', async () => {
    const { workspaceRoot, store, runId, task, prepared } = await phaseFixture();
    store.withRunTransaction(runId, current => ({ patch: { status: 'running', harnessExecution: { ...current.harnessExecution!,
      lifecycle: { ...current.harnessExecution!.lifecycle!, phase: 'started' } } } }));
    // Verifier-entry fixtures only: no SDK, peer or model was started. The
    // explicit observation restricts this synthetic accept phase, not a live identity.
    const eligibility = createHarnessTaskEligibility({ taskId: task.taskId, taskHash: hashHarnessTask(task), principalId: task.principalId!, principalHash: task.principalHash, phase: 'accept' }, { mode: 'not_applicable' });
    writeFileSync(join(store.getRun(runId)!.worktreePath!, 'fixture.txt'), 'after');
    const totalClock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(store.getRun(runId)!.harnessExecution!.lifecycle!.deadlineAt) + 1);
    await expect(prepared.accept({}, new AbortController().signal, eligibility)).rejects.toThrow('total deadline expired before acceptance evidence publication');
    totalClock.mockRestore();
    store.withRunTransaction(runId, () => ({ events: [{ timestamp: new Date().toISOString(), type: 'tool_call',
      data: { toolName: 'Write', callId: 'evidence-call', input: { file_path: 'fixture.txt', content: 'after' } } }] }));
    const acceptanceFile = join(workspaceRoot, '.openslack.local/agents/runs', runId, 'acceptance.json');
    await expect(prepared.accept({}, new AbortController().signal, eligibility)).rejects.toThrow('Unmatched tool call evidence');
    expect(existsSync(acceptanceFile)).toBe(false);
    store.withRunTransaction(runId, () => ({ events: [{ timestamp: new Date().toISOString(), type: 'tool_result',
      data: { toolName: 'Write', callId: 'evidence-call', output: { message: 'changed' } } }] }));
    expect((await prepared.accept({}, new AbortController().signal, eligibility)).outcome).toBe('verified');
  }, 60_000);

  it.runIf(process.env.DEEPSEEK_HARNESS_CHECKOUT)('matches its own verified receipt then rejects rehashed unbalanced evidence without rewriting retained inputs', async () => {
    const { workspaceRoot, store, runId, task, deployment, verification, prepared } = await phaseFixture();
    store.withRunTransaction(runId, current => ({ patch: { status: 'running', harnessExecution: { ...current.harnessExecution!,
      lifecycle: { ...current.harnessExecution!.lifecycle!, phase: 'started' } } } }));
    const eligibility = createHarnessTaskEligibility({ taskId: task.taskId, taskHash: hashHarnessTask(task), principalId: task.principalId!, principalHash: task.principalHash, phase: 'accept' }, { mode: 'not_applicable' });
    writeFileSync(join(store.getRun(runId)!.worktreePath!, 'fixture.txt'), 'after');
    store.withRunTransaction(runId, () => ({ events: [{ timestamp: new Date().toISOString(), type: 'tool_call',
      data: { toolName: 'Write', callId: 'evidence-call', input: { file_path: 'fixture.txt', content: 'after' } } }] }));
    store.withRunTransaction(runId, () => ({ events: [{ timestamp: new Date().toISOString(), type: 'tool_result',
      data: { toolName: 'Write', callId: 'evidence-call', output: { message: 'changed' } } }] }));
    expect((await prepared.accept({}, new AbortController().signal, eligibility)).outcome).toBe('verified');
    const state = store.getRun(runId)!;
    const inspection = { workspaceRoot, identityRoot: workspaceRoot, deployment, verification: () => verification };
    expect((await inspectHarnessTaskExecution(inspection, task, state)).workspace).toBe('matched');
    const acceptanceFile = join(workspaceRoot, '.openslack.local/agents/runs', runId, 'acceptance.json');
    const transcript = readFileSync(state.transcriptPath), receipt = readFileSync(acceptanceFile);
    const runBytes = readFileSync(join(workspaceRoot, '.openslack.local/agents/runs', runId, 'run.json'));
    const unbalanced = transcript.toString('utf8').replace('"callId":"evidence-call"', '"callId":"mismatch-call"');
    const tamperedReceipt = { ...JSON.parse(receipt.toString('utf8')), toolEvidenceHash: hashHarnessInput(unbalanced.trim().split('\n').map(line => JSON.parse(line))) };
    try {
      writeFileSync(state.transcriptPath, unbalanced); writeFileSync(acceptanceFile, JSON.stringify(tamperedReceipt));
      expect((await inspectHarnessTaskExecution(inspection, task, state)).workspace).not.toBe('matched');
      expect(readFileSync(state.transcriptPath, 'utf8')).toBe(unbalanced);
      expect(readFileSync(join(workspaceRoot, '.openslack.local/agents/runs', runId, 'run.json')).equals(runBytes)).toBe(true);
    } finally { writeFileSync(state.transcriptPath, transcript); writeFileSync(acceptanceFile, receipt); }
  }, 60_000);
});

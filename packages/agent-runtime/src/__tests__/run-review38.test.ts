import { test, vi, onTestFinished, type TestContext } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRunStore } from '../run-store.js';
import { inspectRunRepair, authorizeRunRepair, applyRunRepair, createRunRepairAuthorityPort } from '../run-repair.js';
import { acquireRunTransactionLock } from '../run-ownership.js';
import { readRunBytes } from '../run-files.js';
import { HarnessAdmissionStore } from '../harness-admission.js';
import { getAgentRuntimeMcpStatus } from '../agent-runtime-mcp-status.js';
import { runOpenAICompatibleRuntimeSmoke } from '../openai-compatible-diagnostics.js';
import type { AgentRunRequest } from '../types.js';

const checkout = fileURLToPath(new URL('../../../../', import.meta.url));
function fixture(t?: TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), 'pr426-review38-isolated-'));
  (t?.onTestFinished ?? onTestFinished)(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function request(runId: string): AgentRunRequest {
  return { runId, agentId: 'isolated-fixture', prompt: 'offline-only',
    resolvedConfig: { agentId: 'isolated-fixture', source: 'test' },
    permissionProfile: { allowedTools: ['Read'], deniedTools: [], permissionMode: 'default',
      canApprovePR: false, canMerge: false, canReadSecrets: false, canBypassRulesets: false,
      acceptEdits: false, isReadOnly: true } };
}

test('38-30: a captured file identity cannot be replaced by identical bytes at another inode', () => {
  const root = fixture(), path = join(root, 'owned.json'), bytes = Buffer.from('{"fixture":true}');
  fs.writeFileSync(path, bytes);
  const stamp = fs.lstatSync(path, { bigint: true });
  const identity = [stamp.dev, stamp.ino, stamp.mode, stamp.uid, stamp.gid, stamp.nlink, stamp.size, stamp.mtimeNs, stamp.ctimeNs].join(':');
  fs.renameSync(path, join(root, 'retired.json')); fs.writeFileSync(path, bytes);
  assert.equal(readRunBytes(path, bytes.length, 'RUN-CAPTURED-FILE').equals(bytes), true);
  assert.throws(() => readRunBytes(path, bytes.length, 'RUN-CAPTURED-FILE', 1, identity), /changed during read/);
});

test.each(['before-completion', 'terminal-unlock'] as const)('38-01: archives acceptance after a real %s crash without promoting its outcome', stage => {
  const root = fixture(), runId = 'RUN-ACCEPTANCE-CRASH';
  const source = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    import { createRunStore, publishRunAcceptanceEvidence } from ${JSON.stringify(pathToFileURL(join(checkout, 'packages/agent-runtime/src/run-store.ts')).href)};
    const root = ${JSON.stringify(root)}, runId = ${JSON.stringify(runId)};
    const store = createRunStore(root, { sweepOrphans: false });
    store.createRun(${JSON.stringify(request(runId))});
    store.updateRun(runId, { status: 'running', harnessExecution: {
      schema: 'openslack.harness_execution.v1', taskId: 'TASK-ACCEPTANCE',
      requestHash: 'c'.repeat(64), principalHash: 'a'.repeat(64), baseline: 'b'.repeat(40),
      acceptance: 'pending', summary: 'isolated host acceptance', reports: {}, evidenceRefs: [],
      evidence: { reservedBytes: 0, calls: {} }, processExit: 'confirmed',
      lifecycle: { phase: 'started', ownerGeneration: 'isolated-owner', deadlineAt: new Date(Date.now()+60000).toISOString() }
    } });
    const receipt = Buffer.from(JSON.stringify({
      schema: 'openslack.harness_acceptance.v1', taskId: 'TASK-ACCEPTANCE', runId,
      requestHash: 'c'.repeat(64), baseline: 'b'.repeat(40), head: 'b'.repeat(40),
      indexHash: 'e'.repeat(64), files: [], toolEvidenceHash: 'f'.repeat(64), observedAt: new Date().toISOString()
    }));
    const descriptors = new Map(), open = fs.openSync, sync = fs.fsyncSync;
    fs.openSync = (path, ...args) => { const fd = open(path, ...args); descriptors.set(fd, String(path)); return fd; };
    fs.fsyncSync = fd => { sync(fd); if (${JSON.stringify(stage)} === 'before-completion' && descriptors.get(fd)?.endsWith('acceptance.json')) process.exit(73); };
    const unlink = fs.unlinkSync;
    syncBuiltinESMExports();
    await publishRunAcceptanceEvidence(store, runId, receipt, () => {});
    fs.unlinkSync = path => { if (String(path).endsWith('run.transaction.lock')) process.exit(73); return unlink(path); };
    syncBuiltinESMExports();
    store.withRunTransaction(runId, state => ({ patch: { status: 'completed', completedAt: new Date().toISOString(), harnessExecution: { ...state.harnessExecution, acceptance: 'verified' } },
      events: [{ type: 'complete', timestamp: new Date().toISOString(), data: { isolatedFixture: true } }] }));
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-'],
    { cwd: checkout, input: source, encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 73, child.stderr);
  const directory = join(root, '.openslack.local/agents/runs', runId), original = fs.readFileSync(join(directory, 'acceptance.json'));
  const inspection = inspectRunRepair(root, runId);
  assert.equal(inspection.plan, stage === 'terminal-unlock' ? 'preserve_committed' : 'fail_incomplete');
  const authority = createRunRepairAuthorityPort(scope => scope.runId === runId && scope.inspectionSha256 === inspection.inspectionSha256 && scope.workspaceIdentity === inspection.workspaceIdentity);
  const receipt = applyRunRepair(inspection, authorizeRunRepair(inspection, authority));
  assert.deepEqual(fs.readFileSync(join(receipt.archivePath, 'acceptance.json')), original);
  assert.deepEqual(fs.readFileSync(join(directory, 'acceptance.json')), original);
  const state = createRunStore(root, { sweepOrphans: false }).readRun(runId)!;
  assert.equal(state.status, stage === 'terminal-unlock' ? 'completed' : 'failed');
  assert.equal(state.harnessExecution!.acceptance, stage === 'terminal-unlock' ? 'verified' : 'indeterminate');
});



test('38-03: an exact local publication pair preserves the original admission without replay', t => {
  const root = fixture(t), key = 'a'.repeat(64), input = 'b'.repeat(64);
  const store = new HarnessAdmissionStore(root);
  const first = store.admit(key, input);
  const dir = join(root, '.openslack.local/agents/harness-admissions');
  fs.linkSync(join(dir, key + '.json'), join(dir, key + '.' + randomUUID() + '.tmp'));
  const second = store.admit(key, input);
  assert.equal(second.created, false);
  assert.equal(second.record.runId, first.record.runId);
});

test('38-04: a requested nonexistent run fails MCP status even with available descriptors', t => {
  const report = getAgentRuntimeMcpStatus({ rootDir: fixture(t), runId: 'RUN-NOPE', availableServers: ['github'] });
  assert.equal(report.runRead!.kind, 'missing');
  assert.equal(report.status, 'FAIL');
});

test('38-05: a successful isolated smoke is not contradicted by an unrelated preserved lock', async t => {
  const root = fixture(t), local = join(root, '.openslack.local');
  fs.mkdirSync(local);
  fs.writeFileSync(join(local, 'agent-runtime.json'), JSON.stringify({ schema: 'openslack.agent_runtime.v1',
    providers: { 'openai-compatible': { baseUrl: 'https://example.test/v1', model: 'isolated-model', credentialRef: 'env:OFFLINE_FIXTURE' } } }));
  const unrelated = join(local, 'agents/runs/RUN-UNRELATED'); fs.mkdirSync(unrelated, { recursive: true });
  fs.writeFileSync(join(unrelated, 'run.transaction.lock'), 'isolated preserved lock');
  const report = await runOpenAICompatibleRuntimeSmoke({ rootDir: root,
    env: { OFFLINE_FIXTURE: 'offline-fixture-value' },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"summary":"connected"}' } }],
      usage: { total_tokens: 4 } }), { status: 200 }) });
  assert.equal(report.status, 'PASS');
  assert.deepEqual(report.checks.filter(check => check.status === 'FAIL'), []);
});

test('38-06: a retained lock refuses a synchronous writer without synchronous thread waits', t => {
  const root = fixture(t), lock = join(root, 'isolated.lock'); fs.writeFileSync(lock, 'preserved fixture');
  const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
  let calls = 0;
  try { assert.throws(() => acquireRunTransactionLock(lock, () => {}), { code: 'RUN_STATE_BUSY' }); }
  finally { calls = wait.mock.calls.length; wait.mockRestore(); }
  assert.equal(calls, 0, 'The synchronous writer must not sleep the shared event loop');
});

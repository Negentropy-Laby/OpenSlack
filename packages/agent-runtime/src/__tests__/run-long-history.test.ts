import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { platformTestTimeout } from '../../../../scripts/testing/process-fixture.mjs';
import { createRunStore } from '../run-store.js';
import { inspectRunRepair, authorizeRunRepair, applyRunRepair, createRunRepairAuthorityPort,
  type RunRepairInspection, type RunRepairAuthorityPort } from '../run-repair.js';
import type { RunStorageIntent } from '../run-ownership.js';
import type { AgentRunRequest } from '../types.js';
const checkout = fileURLToPath(new URL('../../../../', import.meta.url));
function request(runId: string): AgentRunRequest {
  return { runId, agentId: 'isolated-fixture', prompt: 'offline-only',
    resolvedConfig: { agentId: 'isolated-fixture', source: 'test' },
    permissionProfile: { allowedTools: ['Read'], deniedTools: [], permissionMode: 'default',
      canApprovePR: false, canMerge: false, canReadSecrets: false, canBypassRulesets: false,
      acceptEdits: false, isReadOnly: true } };
}

describe('38-02: recoverability beyond the old member limit', () => {
  let root: string, inspection: RunRepairInspection, authority: RunRepairAuthorityPort;
  // Keep setup under its existing hook bound. Recovery correctness uses the
  // shared platform test watchdog; elapsed repair time is reported separately.
  // Neither watchdog changes production deadlines or durability requirements.
  beforeAll(() => {
    // This is a membership/process-crash proof, not a power-loss or filesystem
    // latency benchmark. Keep real fsync calls and every independent readback;
    // Linux can use an owned tmpfs fixture to avoid thousands of host disk flush
    // latencies consuming the unchanged test deadline. Other suites retain the
    // caller's normal temporary directory and its path trust checks.
    const temporaryRoot = process.platform === 'linux' && fs.existsSync('/dev/shm') ? '/dev/shm' : tmpdir();
    root = fs.mkdtempSync(join(temporaryRoot, 'long-run-repair-'));
    const runId = 'RUN-LONG-INTENT-HISTORY';
    const store = createRunStore(root, { sweepOrphans: false });
    let state = store.createRun(request(runId));
    const dir = join(root, '.openslack.local/agents/runs', runId);
    const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
    let previousBytes = fs.readFileSync(join(dir, 'run.json'));
    // Construct inert, valid history directly: this capacity test does not claim
    // that fixture writes prove fsync durability or an actual tool was executed.
    for (let n = 1; n <= 4096; n++) {
      const transactionId = randomUUID(), previous = state.persistence!;
      state = { ...state, tokensUsed: n, persistence: { ...previous, revision: n, transactionId } };
      const bytes = Buffer.from(JSON.stringify(state, null, 2));
      const intent: RunStorageIntent = { schema: 'openslack.run_intent.v2', runId, transactionId,
        ownerGeneration: randomUUID(), ownershipSha256: 'a'.repeat(64), operation: 'update', creationId: previous.creationId,
        metadataSha256: previous.metadataSha256!, base: { stateSha256: hash(previousBytes), transactionId: previous.transactionId!, revision: n - 1, transcriptBytes: 0 },
        target: { stateSha256: hash(bytes), revision: n, transcriptBytes: 0, stateFile: `run.json.${transactionId}.tmp` },
        append: { bytes: 0, sha256: hash('') } };
      fs.writeFileSync(join(dir, `run.intent.${transactionId}.json`), JSON.stringify(intent), { flag: 'wx', mode: 0o600 });
      previousBytes = bytes;
    }
    fs.writeFileSync(join(dir, 'run.json'), previousBytes);
    const names = fs.readdirSync(dir);
    assert.ok(names.length > 4096);
    assert.ok(names.reduce((sum, name) => sum + fs.statSync(join(dir, name)).size, 0) < 94 * 1024 * 1024);
    assert.equal(store.readRun(runId)!.tokensUsed, 4096);
    assert.equal(inspectRunRepair(root, runId).plan, 'not_needed');
    const source = `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';
      import{createRunStore}from${JSON.stringify(pathToFileURL(join(checkout, 'packages/agent-runtime/src/run-store.ts')).href)};
      const store=createRunStore(${JSON.stringify(root)},{sweepOrphans:false}),unlink=fs.unlinkSync;
      fs.unlinkSync=path=>{if(String(path).endsWith('run.transaction.lock'))process.exit(73);return unlink(path)};syncBuiltinESMExports();
      store.withRunTransaction(${JSON.stringify(runId)},()=>({patch:{status:'completed',completedAt:new Date().toISOString()},events:[{type:'complete',timestamp:new Date().toISOString(),data:{isolatedFixture:true}}]}));`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-'], { cwd: checkout, input: source, encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 73, child.stderr);
    inspection = inspectRunRepair(root, runId);
    assert.equal(inspection.plan, 'preserve_committed');
    authority = createRunRepairAuthorityPort(scope => scope.runId === runId && scope.inspectionSha256 === inspection.inspectionSha256);

  });
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });
  test('archives a real abandoned chain without replay, with every immutable intent retained', () => {
    const runId = 'RUN-LONG-INTENT-HISTORY';
    const directory = join(root, '.openslack.local/agents/runs', runId);
    const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    // Independently capture fixture bytes in the test body, not the setup hook
    // or the production inspection's own manifest.
    const originals = fs.readdirSync(directory).sort().map(name => {
      const bytes = fs.readFileSync(join(directory, name));
      return { name, bytes: bytes.length, sha256: hash(bytes) };
    });
    const runNames = fs.readdirSync(join(root, '.openslack.local/agents/runs'))
      .filter(name => name.startsWith('RUN-')).sort();
    const started = performance.now();
    const receipt = applyRunRepair(inspection, authorizeRunRepair(inspection, authority));
    const repairElapsedMs = performance.now() - started;
    assert.equal(receipt.outcome, 'preserved_commit');
    assert.equal(receipt.requiresReconciliation, true);
    assert.equal(receipt.resources, 'unknown');
    assert.deepEqual(fs.readdirSync(receipt.archivePath).sort(),
      [...originals.map(file => file.name), 'before-manifest.json'].sort());
    for (const file of originals) {
      const archived = fs.readFileSync(join(receipt.archivePath, file.name));
      assert.equal(archived.length, file.bytes, file.name);
      assert.equal(hash(archived), file.sha256, file.name);
      if (file.name !== 'run.transaction.lock') {
        assert.equal(hash(fs.readFileSync(join(directory, file.name))), file.sha256, file.name);
      }
    }
    const manifestBytes = fs.readFileSync(join(receipt.archivePath, 'before-manifest.json'));
    assert.equal(hash(manifestBytes), receipt.archiveManifestSha256);
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
      schema: string; runId: string; inspectionSha256: string;
      files: Array<{ name: string; bytes: number; sha256: string }>;
    };
    assert.equal(manifest.schema, 'openslack.run_repair_archive.v1');
    assert.equal(manifest.runId, runId);
    assert.equal(manifest.inspectionSha256, inspection.inspectionSha256);
    assert.deepEqual(manifest.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })), originals);
    assert.throws(() => fs.lstatSync(join(directory, 'run.transaction.lock')), { code: 'ENOENT' });
    assert.throws(() => fs.lstatSync(join(directory, 'run.maintenance.json')), { code: 'ENOENT' });
    assert.deepEqual(fs.readdirSync(join(root, '.openslack.local/agents/runs'))
      .filter(name => name.startsWith('RUN-')).sort(), runNames);
    assert.equal(createRunStore(root, { sweepOrphans: false }).readRun(runId)!.status, 'completed');
    assert.equal(fs.readdirSync(receipt.archivePath).filter(name => name.startsWith('run.intent.')).length, 4098);
    console.info(JSON.stringify({ code: 'RUN_REPAIR_HISTORY_TIMING', platform: process.platform,
      intentCount: 4098, memberCount: originals.length, repairElapsedMs,
      testTimeoutMs: platformTestTimeout(20_000) }));
  }, platformTestTimeout(20_000));
});

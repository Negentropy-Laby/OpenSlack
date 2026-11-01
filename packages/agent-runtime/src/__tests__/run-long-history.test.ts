import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
  // Synthetic history and the abandoned-writer input are prepared once under
  // the normal bounded hook. Hook failures fail the suite. The actual repair
  // keeps its original 20-second test bound, fsync and complete archive checks.
  beforeAll(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'long-run-repair-'));
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
    const receipt = applyRunRepair(inspection, authorizeRunRepair(inspection, authority));
    assert.equal(createRunStore(root, { sweepOrphans: false }).readRun(runId)!.status, 'completed');
    assert.equal(fs.readdirSync(receipt.archivePath).filter(name => name.startsWith('run.intent.')).length, 4098);
  }, 20_000);
});

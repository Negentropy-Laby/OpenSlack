import { describe, expect, it, onTestFinished } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRunStore, HARNESS_TRANSCRIPT_MAX_BYTES } from '../run-store.js';
import { inspectRunRepair, authorizeRunRepair, applyRunRepair, createRunRepairAuthorityPort } from '../run-repair.js';

const checkout = fileURLToPath(new URL('../../../../', import.meta.url));
describe('recoverability at per-file publication boundaries', () => {
  it.each(['snapshot', 'transcript'] as const)('archives and resolves a real nonterminal %s-boundary crash', kind => {
    const root = mkdtempSync(join(tmpdir(), 'run-recovery-boundary-')), runId = 'RUN-RECOVERY-BOUNDARY';
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const source = `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';
      import{createRunStore}from${JSON.stringify(pathToFileURL(join(checkout, 'packages/agent-runtime/src/run-store.ts')).href)};
      const root=${JSON.stringify(root)},runId=${JSON.stringify(runId)},kind=${JSON.stringify(kind)};
      const store=createRunStore(root,{sweepOrphans:false});
      store.createRun({runId,agentId:'offline',prompt:'offline',resolvedConfig:{agentId:'offline',source:'test'},permissionProfile:{allowedTools:[],deniedTools:[],permissionMode:'default'}});
      const base={type:'progress',timestamp:new Date().toISOString(),data:{text:''}};
      const make=bytes=>({...base,data:{text:'x'.repeat(bytes-Buffer.byteLength(JSON.stringify(base))-1)}});
      if(kind==='transcript')for(let n=0;n<3;n++)store.appendEvent(runId,make(16*1024*1024));
      const unlink=fs.unlinkSync;fs.unlinkSync=path=>{if(String(path).endsWith('run.transaction.lock'))process.exit(73);return unlink(path)};syncBuiltinESMExports();
      store.withRunTransaction(runId,()=>kind==='snapshot'?{patch:{status:'running',model:'x'.repeat(500*1024)}}:{patch:{status:'running'},events:[make(16*1024*1024-64*1024)]});`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-'], {
      cwd: checkout, input: source, encoding: 'utf8', timeout: 15_000,
    });
    expect({ code: child.status, stderr: child.stderr }).toEqual({ code: 73, stderr: '' });
    const directory = join(root, '.openslack.local/agents/runs', runId), original = readFileSync(join(directory, kind === 'snapshot' ? 'run.json' : 'transcript.jsonl'));
    const inspection = inspectRunRepair(root, runId);
    expect(inspection.plan).toBe('fail_incomplete');
    const permission = authorizeRunRepair(inspection, createRunRepairAuthorityPort(scope => scope.runId === runId && scope.inspectionSha256 === inspection.inspectionSha256));
    const receipt = applyRunRepair(inspection, permission);
    expect(readFileSync(join(receipt.archivePath, kind === 'snapshot' ? 'run.json' : 'transcript.jsonl')).equals(original)).toBe(true);
    const state = createRunStore(root, { sweepOrphans: false }).readRun(runId)!;
    expect(state.status).toBe('failed');
    expect(state.persistence!.transcriptBytes).toBeLessThanOrEqual(HARNESS_TRANSCRIPT_MAX_BYTES);
    expect(readFileSync(join(directory, 'run.json')).length).toBeLessThanOrEqual(512 * 1024);
    expect(readdirSync(directory)).not.toContain('run.transaction.lock');
  }, 20_000);
});

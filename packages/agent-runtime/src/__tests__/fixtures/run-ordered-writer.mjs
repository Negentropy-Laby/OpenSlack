// Real independent storage writer. Only synthetic root/control files are touched.
// Preparation: node node_modules/typescript/bin/tsc --build packages/agent-runtime/tsconfig.json
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createRunStore } from '../../../dist/run-store.js';
import { appendTranscriptEvent } from '../../../dist/transcript.js';
const [root, runId, operation, marker, release] = process.argv.slice(2);
const nativeOpen = fs.openSync;
fs.openSync = (path, flags, ...args) => {
  const target = String(path).endsWith('run.transaction.lock') && flags === 'wx';
  if (target) fs.writeFileSync(`${marker}.attempt`, 'attempt');
  const fd = nativeOpen(path, flags, ...args);
  if (target && release) {
    fs.writeFileSync(`${marker}.acquired`, 'acquired');
    const deadline = performance.now() + 15_000;
    while (!fs.existsSync(release)) {
      if (performance.now() >= deadline) throw new Error('Parent did not release the controlled fixture owner');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
  return fd;
};
syncBuiltinESMExports();
try {
  if (operation === 'create') createRunStore(root, { sweepOrphans: false }).createRun({ runId, agentId: 'ordered-create-fixture',
    prompt: 'never sent', resolvedConfig: { agentId: 'ordered-create-fixture', source: 'test' },
    permissionProfile: { allowedTools: [], deniedTools: [], permissionMode: 'default' } });
  else appendTranscriptEvent(runId, { type: 'progress', timestamp: new Date().toISOString(), data: { independentAppend: true } }, root);
  process.stdout.write(JSON.stringify({ operation, outcome: 'committed' }));
} catch (error) {
  process.stdout.write(JSON.stringify({ operation, outcome: 'rejected', code: error.code ?? null,
    alreadyExists: error.message.includes('Run already exists') }));
}

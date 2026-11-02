// Isolated storage writer only: no model, identity, credentials or task effects.
// Preparation: node node_modules/typescript/bin/tsc --build packages/agent-runtime/tsconfig.json
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { createRunStore } from '../../../dist/run-store.js';
const [root, runId, stage] = process.argv.slice(2);
const native = { openSync: fs.openSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, linkSync: fs.linkSync,
  unlinkSync: fs.unlinkSync, renameSync: fs.renameSync };
const descriptors = new Map();
let armed = stage.startsWith('create-');
fs.openSync = (path, flags, ...args) => {
  if (armed && stage === 'update-before-append' && String(path).endsWith('transcript.jsonl') && flags !== 'r') process.exit(79);
  const fd = native.openSync(path, flags, ...args); descriptors.set(fd, String(path)); return fd;
};
fs.writeFileSync = (path, bytes, ...args) => {
  if (armed && stage === 'update-partial-append' && descriptors.get(path)?.endsWith('transcript.jsonl')) {
    native.writeFileSync(path, Buffer.from(bytes).subarray(0, Math.floor(Buffer.byteLength(bytes) / 2)), ...args); process.exit(79);
  }
  return native.writeFileSync(path, bytes, ...args);
};
fs.fsyncSync = fd => {
  const path = descriptors.get(fd) ?? '';
  native.fsyncSync(fd);
  if (armed && ((stage === 'create-lock-fsync' && path.endsWith('run.transaction.lock')) ||
    (stage === 'create-metadata-temp-fsync' && /metadata\.json\..+\.tmp$/.test(path)) ||
    (stage === 'create-state-temp-fsync' && /run\.json\..+\.tmp$/.test(path)))) process.exit(79);
  if (armed && ((stage.endsWith('intent-fsync') && path.includes('run.intent.')) ||
    (stage === 'update-after-append' && path.endsWith('transcript.jsonl')) ||
    (stage === 'update-temp-fsync' && /run\.json\..+\.tmp$/.test(path)))) process.exit(79);
};
fs.linkSync = (from, to, ...args) => {
  if (armed && ((stage === 'create-second-link' && String(to).endsWith('run.json')) ||
    (stage === 'create-metadata-link' && String(to).endsWith('metadata.json')))) process.exit(stage === 'create-second-link' ? 71 : 79);
  return native.linkSync(from, to, ...args);
};
fs.unlinkSync = path => {
  if (armed && ((stage === 'create-metadata-unlink' && /metadata\.json\..+\.tmp$/.test(String(path))) ||
    (stage === 'create-run-unlink' && /run\.json\..+\.tmp$/.test(String(path))) ||
    (stage === 'create-lock-unlink' && String(path).endsWith('run.transaction.lock')))) process.exit(79);
  if (armed && ['terminal-unlock', 'live-lock'].includes(stage) && String(path).endsWith('run.transaction.lock')) {
    if (stage === 'live-lock') {
      process.stdout.write('locked\n');
      while (true) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    process.exit(73);
  }
  return native.unlinkSync(path);
};
fs.renameSync = (from, to) => {
  if (armed && stage === 'update-before-rename' && String(to).endsWith('run.json')) process.exit(72);
  return native.renameSync(from, to);
};
syncBuiltinESMExports();
const store = createRunStore(root, { sweepOrphans: false });
const request = { runId, agentId: 'isolated-crash-fixture', prompt: 'never sent to a model',
  resolvedConfig: { agentId: 'isolated-crash-fixture', source: 'test' },
  permissionProfile: { allowedTools: ['Read'], deniedTools: [], permissionMode: 'default',
    canApprovePR: false, canMerge: false, canReadSecrets: false, canBypassRulesets: false,
    acceptEdits: false, isReadOnly: true } };
store.createRun(request);
if (!stage.startsWith('create-')) {
  armed = true;
  store.withRunTransaction(runId, () => ({ patch: { status: 'completed', completedAt: new Date().toISOString() },
    events: [{ timestamp: new Date().toISOString(), type: 'complete', data: { fixtureOnly: true } }] }));
}
throw new Error(`Crash fixture missed ${stage}: ${join(root, runId)}`);

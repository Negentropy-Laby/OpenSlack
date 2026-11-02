// Isolated maintenance of synthetic storage only. This is not a production authority port.
// Preparation: node node_modules/typescript/bin/tsc --build packages/agent-runtime/tsconfig.json
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { inspectRunRepair, authorizeRunRepair, applyRunRepair, createRunRepairAuthorityPort } from '../../../dist/run-repair.js';
const [root, runId, stage] = process.argv.slice(2);
const native = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, unlinkSync: fs.unlinkSync };
const descriptors = new Map();
fs.openSync = (path, ...args) => { const fd = native.openSync(path, ...args); descriptors.set(fd, String(path)); return fd; };
fs.fsyncSync = fd => {
  native.fsyncSync(fd);
  const path = descriptors.get(fd) ?? '';
  if ((stage === 'barrier' && path.endsWith('run.maintenance.json')) ||
    (stage === 'archive-manifest' && path.endsWith('before-manifest.json'))) process.exit(83);
};
fs.renameSync = (from, to) => {
  native.renameSync(from, to);
  if (stage === 'recovery-state' && String(to).endsWith('run.json')) process.exit(83);
};
fs.unlinkSync = path => {
  if (stage === 'before-unlock' && String(path).endsWith('run.transaction.lock')) process.exit(83);
  native.unlinkSync(path);
  if (stage === 'after-unlock' && String(path).endsWith('run.transaction.lock')) process.exit(83);
};
syncBuiltinESMExports();
const inspection = inspectRunRepair(root, runId);
const port = createRunRepairAuthorityPort(scope => scope.runId === runId && scope.workspaceIdentity === inspection.workspaceIdentity &&
  scope.inspectionSha256 === inspection.inspectionSha256);
applyRunRepair(inspection, authorizeRunRepair(inspection, port));
throw new Error('Maintenance crash injection missed its boundary');

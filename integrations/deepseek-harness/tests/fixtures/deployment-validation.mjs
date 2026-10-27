/** Private verification child. No SDK/model execution; every check freshly observes production bytes. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// The same existing formal dist entry exported as internal/harness. A clean
// root does not declare a bare @openslack/agent-runtime dependency or alias.
import { hashHarnessDeployment } from '../../../../packages/agent-runtime/dist/harness.js';

assert.equal(process.argv.length, 3, 'One host-owned fixture input is required');
const { root, deployment } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
function check(name, assertion) {
  assertion();
  process.stdout.write(JSON.stringify({ check: name, passed: true }) + '\n');
}

check('valid', () => assert.match(hashHarnessDeployment(deployment), /^[a-f0-9]{64}$/));
const outside = join(root, 'outside.js');
writeFileSync(outside, 'throw new Error("must not execute");');
const patch = readFileSync(deployment.workerPatch);
for (const [name, file] of [['outside-root', outside], ['unexported-source', join(deployment.pluginRoot, 'src/index.ts')]]) {
  writeFileSync(deployment.workerPatch, JSON.stringify([{ insert: [{ id: 'not-approved', name: pathToFileURL(file).href }] }]));
  check(name, () => assert.throws(() => hashHarnessDeployment(deployment), /separately bound/));
}
writeFileSync(deployment.workerPatch, patch);
writeFileSync(deployment.workerPatch, JSON.stringify([
  { insert: [{ id: 'not-bound', name: '@deepseek-ai/dsh-sdk-jsonrpc-server/src/index.ts' }] },
]));
check('private-subpath', () => assert.throws(() => hashHarnessDeployment(deployment), /package or subpath/));
writeFileSync(deployment.workerPatch, patch);
check('bad-plugin-hash', () => assert.throws(
  () => hashHarnessDeployment({ ...deployment, pluginBuildHash: '0'.repeat(64) }), /approved deployment/));
check('bad-node-hash', () => assert.throws(
  () => hashHarnessDeployment({ ...deployment, nodeSha256: '0'.repeat(64) }), /approved deployment/));
const shadow = join(deployment.dshHome, 'profiles/sdk/node_modules/@deepseek-ai/schemastery');
assert.equal(existsSync(shadow), false, 'The synthetic peer shadow must never replace an installed peer');
mkdirSync(shadow, { recursive: true });
writeFileSync(join(shadow, 'package.json'), JSON.stringify({ name: '@deepseek-ai/schemastery', version: '4.0.0', main: 'index.js' }));
writeFileSync(join(shadow, 'index.js'), 'throw new Error("must never load an unapproved same-name peer")');
check('peer-shadow', () => assert.throws(() => hashHarnessDeployment(deployment), /runtime peer override/));

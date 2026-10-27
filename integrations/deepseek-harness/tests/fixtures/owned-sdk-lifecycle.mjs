import { channel } from 'node:diagnostics_channel';
import { createOwnedSdk } from '../../dist/owned-sdk.js';
import { loadPublicHarness } from '../../dist/runtime.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
const [harnessRoot, home, workspace, patch, mode] = process.argv.slice(2);
let runtime = await loadPublicHarness(harnessRoot);
const expiresAt = Date.now() + 60_000, realNow = Date.now;
let startEligibility = { mode: 'not_applicable' }, patches = [patch];
if (mode === 'expired-after-initialize') {
  startEligibility = { mode: 'required', expiresAt };
  const binding = JSON.parse(readFileSync(join(dirname(home), 'binding.json'), 'utf8'));
  const overlay = join(dirname(home), 'owned-host.patch.json');
  writeFileSync(overlay, JSON.stringify([
    { id: 'sdk-jsonrpc-server', disabled: true },
    { insert: [{ id: 'fixture-sdk-host', name: new URL('../../dist/sdk-host.js', import.meta.url).href, config: {
      generation: 'fixture-g1', runtimeEntries: JSON.stringify(binding.runtimeEntries), startEligibility: JSON.stringify(startEligibility),
    } }] },
  ]), { flag: 'wx' });
  patches.push(overlay);
  // Test-only public subclass: the real SDK spawns/initializes its real dsh,
  // then this parent-process clock advances at that exact fulfilled boundary.
  // No Harness source, installed export, private field or protocol is patched.
  const Original = runtime.sdk.DeepSeekHarness;
  class ExpireAfterInitialize extends Original {
    async start() { await super.start(); Date.now = () => expiresAt; }
  }
  runtime = { ...runtime, sdk: { ...runtime.sdk, DeepSeekHarness: ExpireAfterInitialize } };
}
let spawnCount = 0;
const observe = ({ process: child }) => child.once('spawn', () => {
  if (child.spawnargs[1] === runtime.dshBin) spawnCount++;
});
channel('child_process').subscribe(observe);
const port = createOwnedSdk({ runtime, generation: 'fixture-g1', requireMcp: false, startEligibility,
  launch: { dshBin: runtime.dshBin, profile: 'sdk', dshHome: home, patches,
    cwd: workspace, processCwd: workspace, provider: mode === 'expired-after-initialize' ? 'openslack-fixture' : 'missing-provider-for-initialize-negative', model: 'fixture',
    initializeTimeoutMs: 5_000, env: { PATH: process.env.PATH } },
  authorize: async () => { throw new Error('No fixture authorization'); } });
let rejected = false, failure;
try {
  if (mode === 'before-start') await port.close();
  try { await port.run('must never reach a model', 'not-started', () => {}); } catch (error) { rejected = true; failure = error.message; }
  // Only the owner's fulfilled-initialize boundary uses the deterministic
  // parent clock. Restore it before sending an absolute cleanup deadline to
  // the child, which has its own real clock and did not undergo that test jump.
  Date.now = realNow;
  const receipt = await port.close();
  try { await port.wait('not-started'); throw new Error('unexpected wait'); } catch (error) {
    if (error.message === 'unexpected wait') throw error;
  }
  try { await port.run('must not retry', 'not-started', () => {}); throw new Error('unexpected retry'); } catch (error) {
    if (error.message === 'unexpected retry') throw error;
  }
  const builtInputs = ['owned-sdk', 'sdk-host'].map(name => { const bytes = readFileSync(new URL(`../../dist/${name}.js`, import.meta.url));
    return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; });
  process.stdout.write(JSON.stringify({ spawnCount, rejected, receipt, failure, builtInputs }));
} finally { await port.close(); Date.now = realNow; channel('child_process').unsubscribe(observe); }

import { channel } from 'node:diagnostics_channel';
import { createOwnedSdk } from '../../dist/owned-sdk.js';
import { loadPublicHarness } from '../../dist/runtime.js';
const [harnessRoot, home, workspace, patch, mode] = process.argv.slice(2);
const runtime = await loadPublicHarness(harnessRoot);
let spawnCount = 0;
const observe = ({ process: child }) => child.once('spawn', () => {
  if (child.spawnargs[1] === runtime.dshBin) spawnCount++;
});
channel('child_process').subscribe(observe);
const port = createOwnedSdk({ runtime, generation: 'fixture-g1', requireMcp: false,
  launch: { dshBin: runtime.dshBin, profile: 'sdk', dshHome: home, patches: [patch],
    cwd: workspace, processCwd: workspace, provider: 'missing-provider-for-initialize-negative', model: 'fixture',
    initializeTimeoutMs: 5_000, env: { PATH: process.env.PATH } },
  authorize: async () => { throw new Error('No fixture authorization'); } });
let rejected = false;
try {
  if (mode === 'before-start') await port.close();
  try { await port.run('must never reach a model', 'not-started', () => {}); } catch { rejected = true; }
  const receipt = await port.close();
  try { await port.wait('not-started'); throw new Error('unexpected wait'); } catch (error) {
    if (error.message === 'unexpected wait') throw error;
  }
  try { await port.run('must not retry', 'not-started', () => {}); throw new Error('unexpected retry'); } catch (error) {
    if (error.message === 'unexpected retry') throw error;
  }
  process.stdout.write(JSON.stringify({ spawnCount, rejected, receipt }));
} finally { await port.close(); channel('child_process').unsubscribe(observe); }

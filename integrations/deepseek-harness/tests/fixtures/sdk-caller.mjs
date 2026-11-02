import { createOwnedSdk } from '../../dist/owned-sdk.js';
import { loadPublicHarness } from '../../dist/runtime.js';
const [harnessRoot, home, workspace, patch, prompt = 'Dispatch the approved task and read its verified result.', generation = 'fixture-caller'] = process.argv.slice(2);
const runtime = await loadPublicHarness(harnessRoot);
// Caller/readonly fixture only: not a dispatched worker or local file authority.
const port = createOwnedSdk({ runtime, generation, requireMcp: true, startEligibility: { mode: 'not_applicable' },
  launch: { dshBin: runtime.dshBin, dshHome: home, profile: 'sdk', patches: [patch],
    cwd: workspace, processCwd: workspace, provider: 'openslack-fixture', model: 'fixture',
    initializeTimeoutMs: 120_000, requestTimeoutMs: 240_000, env: { PATH: process.env.PATH } },
  authorize: async () => { throw new Error('The initiator has no file effects'); } });
process.once('SIGTERM', () => { process.exitCode = 1; void port.close().catch(() => { process.exitCode = 1; }); });
try {
  const result = await port.run(prompt, 'openslack-caller', () => {});
  await port.wait('openslack-caller');
  const receipt = await port.close();
  if (!receipt.shutdownAcknowledged || !receipt.resourcesStopped || receipt.code !== 0 || receipt.signal !== null || receipt.terminationRequested) {
    throw new Error('Caller shutdown is unconfirmed');
  }
  process.stdout.write(JSON.stringify({ finalResponse: result.finalResponse, events: result.events }));
} finally { await port.close(); }

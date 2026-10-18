// TEST ONLY child adapter: no socket or external request can be made.
import { appendFileSync } from 'node:fs';
import { createCleanupExecutorHttpFixture } from './cleanup-executor-http.js';
globalThis.fetch = async () => {
  throw new Error('FIXTURE_EXTERNAL_NETWORK_FORBIDDEN');
};
export class Agent {
  async close() {}
}
export class ProxyAgent extends Agent {}
const fixture = createCleanupExecutorHttpFixture({
  sha: process.env.CLEANUP_FIXTURE_SHA!,
  protected: process.env.CLEANUP_FIXTURE_PROTECTED === '1',
  onCall: (call) => {
    appendFileSync(
      process.env.CLEANUP_FIXTURE_LOG!,
      `api:${call.path}\nhttp:${JSON.stringify(call)}\n`,
    );
  },
});
export const fetch = fixture.fetch;

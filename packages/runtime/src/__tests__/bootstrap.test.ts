import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ localIdentity: false, generate: vi.fn() }));
vi.mock('node:fs', () => ({
  existsSync: (path: string) => (path.includes('.openslack.local') ? mocks.localIdentity : true),
}));
vi.mock('@openslack/workspace', () => ({
  validateWorkspace: () => ({ valid: true }),
  parseAgentRegistry: () => ({
    permissions: { paths: { allow: [], deny: [] } },
    _source_schema: 'openslack.agent_registry.v2',
  }),
}));
vi.mock('../identity.js', () => ({
  loadRuntimeIdentity: () => ({ run_id: 'isolated-fixture' }),
  generateRuntimeIdentity: mocks.generate,
}));
import { bootstrapAgent } from '../bootstrap.js';
afterEach(() => {
  vi.unstubAllEnvs();
  mocks.localIdentity = false;
  vi.clearAllMocks();
});
describe('bootstrap administrator identity prerequisite', () => {
  it.each([undefined, 'true'])('fails without local identity, including CI=%s', (ci) => {
    vi.stubEnv('CI', ci);
    const result = bootstrapAgent('isolated-fixture');
    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.name)).toEqual([
      'local_identity',
    ]);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('accepts a configured fixture after all structural checks pass', () => {
    mocks.localIdentity = true;
    expect(bootstrapAgent('isolated-fixture').passed).toBe(true);
  });
});

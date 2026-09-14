import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  localIdentity: false,
  provider: 'openai',
  runtime: 'codex',
  generate: vi.fn(),
}));
vi.mock('node:fs', () => ({
  existsSync: (path: string) => (path.includes('.openslack.local') ? mocks.localIdentity : true),
}));
vi.mock('@openslack/workspace', () => ({
  validateWorkspace: () => ({ valid: true }),
  parseAgentRegistry: () => ({
    vendor: { provider: mocks.provider, runtime: mocks.runtime },
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
  mocks.provider = 'openai';
  mocks.runtime = 'codex';
  vi.clearAllMocks();
});
describe('bootstrap administrator identity prerequisite', () => {
  it('blocks an unconfigured custom runner independently of local identity', () => {
    mocks.localIdentity = true;
    mocks.runtime = 'custom_runner';
    mocks.provider = 'unconfigured';
    const result = bootstrapAgent('isolated-fixture');
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.name === 'runtime_configuration')).toMatchObject({
      passed: false,
      detail: expect.stringContaining('CUSTOM_RUNTIME_UNCONFIGURED'),
    });
    mocks.provider = 'configured-provider';
    expect(bootstrapAgent('isolated-fixture').passed).toBe(true);
  });
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

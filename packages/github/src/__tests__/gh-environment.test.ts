import { describe, expect, it } from 'vitest';
import { createGhEnvironment, ghProcessEnvironment, validateGhGoDebug } from '../gh-environment.js';

describe('gh process environment boundary', () => {
  it.each([undefined, '', ' \t', 'tlsmlkem=0', ' tlsmlkem=0 '])(
    'handles supported input %j',
    (value) => {
      const parent = {
        GODEBUG: 'ambient-canary',
        OPENSLACK_BOT_GH_GODEBUG: value,
        GH_TOKEN: 'fixture-token',
      };
      const env = ghProcessEnvironment(parent);
      expect(env.GODEBUG).toBe(value?.trim() ? 'tlsmlkem=0' : undefined);
      expect(env.GH_TOKEN).toBe('fixture-token');
      expect(env.OPENSLACK_BOT_GH_GODEBUG).toBeUndefined();
      expect(parent.GODEBUG).toBe('ambient-canary');
    },
  );
  it.each(['unknown-canary', 'tlsmlkem=0,x=1', 'tlsmlkem=0,tlsmlkem=0'])(
    'rejects unsupported input without echoing it',
    (value) => {
      for (const build of [
        validateGhGoDebug,
        ghProcessEnvironment,
        (env: NodeJS.ProcessEnv) => createGhEnvironment({ value: 'fixture-token' }, env),
      ]) {
        try {
          build({ OPENSLACK_BOT_GH_GODEBUG: value });
          expect.fail('Expected invalid configuration');
        } catch (error) {
          expect(error).toMatchObject({ code: 'BOT_GH_GODEBUG_INVALID' });
          expect(String(error)).not.toContain(value);
        }
      }
    },
  );
  it('removes case aliases of ambient Go settings', () => {
    expect(ghProcessEnvironment({ godebug: 'canary', GoDebug: 'canary' })).toEqual({});
  });
});

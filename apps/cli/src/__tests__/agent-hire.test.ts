import { onboardingFixture } from './onboarding-fixture.js';
import { AGENT_ONBOARDING_DOCUMENTS } from '@openslack/runtime';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentCommands } from '../commands/agent.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('agent hire', () => {
  it('keeps runtime identity local instead of copying it into tracked onboarding', async () => {
    const root = onboardingFixture(roots);
    process.exitCode = 1;

    const previousCwd = process.cwd();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      process.chdir(root);
      await agentCommands().parseAsync(
        ['node', 'openslack', 'hire', '--agent-id', 'fixture-agent', '--runtime', 'codex'],
        { from: 'node' },
      );
    } finally {
      process.chdir(previousCwd);
    }

    const onboardingDir = join(root, '.openslack', 'agents', 'onboarding', 'fixture-agent');
    expect(readdirSync(onboardingDir).sort()).toEqual([...AGENT_ONBOARDING_DOCUMENTS].sort());
    expect(existsSync(join(onboardingDir, 'identity.yaml'))).toBe(false);
    expect(existsSync(join(root, '.openslack', 'agents', 'registry', 'fixture-agent.yaml'))).toBe(
      true,
    );
    expect(existsSync(join(root, '.openslack', 'agents', 'prompts'))).toBe(true);
    expect(process.exitCode).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      '  1. Create local identity in .openslack.local/agents/fixture-agent/identity.yaml',
    );
  });
});

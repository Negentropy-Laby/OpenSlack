import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentCommands } from '../commands/agent.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('agent hire', () => {
  it('keeps runtime identity local instead of copying it into tracked onboarding', async () => {
    const sourceRoot = process.cwd();
    const root = mkdtempSync(join(tmpdir(), 'openslack-agent-hire-'));
    roots.push(root);

    writeFileSync(join(root, 'openslack.yaml'), 'schema: openslack.workspace.v1\n');
    mkdirSync(join(root, 'templates'), { recursive: true });
    cpSync(join(sourceRoot, 'templates', 'new-agent'), join(root, 'templates', 'new-agent'), {
      recursive: true,
    });

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
    expect(readdirSync(onboardingDir)).toHaveLength(8);
    expect(existsSync(join(onboardingDir, 'identity.yaml'))).toBe(false);
    expect(existsSync(join(root, '.openslack', 'agents', 'registry', 'fixture-agent.yaml'))).toBe(
      true,
    );
    expect(existsSync(join(root, '.openslack', 'agents', 'prompts'))).toBe(true);
    expect(log).toHaveBeenCalledWith(
      '  1. Create local identity in .openslack.local/agents/fixture-agent/identity.yaml',
    );
  });
});

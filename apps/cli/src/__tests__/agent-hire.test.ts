import {
  copyFileSync,
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
    mkdirSync(join(root, 'templates', 'new-agent'));
    for (const name of [
      'START_HERE.md',
      'first_day_checklist.md',
      'codex_automation_prompt.md',
      'claude_routine_prompt.md',
    ]) {
      copyFileSync(
        join(sourceRoot, 'templates', 'new-agent', name),
        join(root, 'templates', 'new-agent', name),
      );
    }

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
    expect(readdirSync(onboardingDir)).toEqual(
      expect.arrayContaining(['START_HERE.md', 'codex_automation_prompt.md']),
    );
    expect(existsSync(join(onboardingDir, 'identity.yaml'))).toBe(false);
    expect(existsSync(join(root, '.openslack', 'agents', 'registry', 'fixture-agent.yaml'))).toBe(
      true,
    );
    expect(existsSync(join(root, '.openslack', 'agents', 'prompts'))).toBe(false);
    expect(log).toHaveBeenCalledWith(
      '  1. Create local identity in .openslack.local/agents/fixture-agent/identity.yaml',
    );
  });
});

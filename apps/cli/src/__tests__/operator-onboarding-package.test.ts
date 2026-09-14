import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { obsoleteOnboarding } from './onboarding-fixture.js';

describe('maintained operator onboarding', () => {
  it('has manual guidance, current commands and resolvable references', () => {
    const root = process.cwd();
    const folder = join(root, '.openslack/agents/onboarding/operator');
    expect(readdirSync(folder).sort()).toEqual([
      'START_HERE.md',
      'claude_routine_prompt.md',
      'codex_automation_prompt.md',
      'first_day_checklist.md',
    ]);
    for (const name of readdirSync(folder)) {
      const content = readFileSync(join(folder, name), 'utf8');
      expect(content).not.toMatch(obsoleteOnboarding);
      expect(content).not.toMatch(
        /Project #|called on a schedule|every 10 minutes|claim_policy\.yaml|agents\/prompts\/operator\.md/,
      );
      for (const [, path] of content.matchAll(
        /`((?:\.openslack\/(?:agents|policies)\/|docs\/)[^`]+)`/g,
      ))
        expect(existsSync(join(root, path)), `${name}: ${path}`).toBe(true);
    }
  });
});

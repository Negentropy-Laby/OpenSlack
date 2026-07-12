import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EvalSuite } from '../types.js';
import { runEvalSuite } from '../runner.js';

function findRepoRoot(): string {
  let current = process.cwd();
  while (!existsSync(join(current, 'openslack.yaml'))) {
    const parent = dirname(current);
    if (parent === current) throw new Error('OpenSlack repository root not found');
    current = parent;
  }
  return current;
}

const repoRoot = findRepoRoot();
const markerPaths = [
  join(repoRoot, '.openslack.local', 'eval-command-canary.txt'),
  join(repoRoot, '.openslack.local', 'eval-command-redirect.txt'),
];

function suiteFor(check: string): EvalSuite {
  return {
    name: 'eval-command-policy',
    cases: [
      {
        id: 'EV-COMMAND-POLICY',
        title: 'Eval command policy',
        goal: 'Only allow explicit in-process eval commands',
        onFailure: 'block_pr_notify_human',
        assertions: [{ description: 'rejects unsafe command', check }],
      },
    ],
  };
}

afterEach(() => {
  for (const markerPath of markerPaths) {
    rmSync(markerPath, { force: true });
  }
});

describe('eval command assertions', () => {
  it.each([
    'command(openslack workspace validate; echo injected)',
    'command(openslack workspace validate && echo injected)',
    'command(openslack workspace validate | echo injected)',
    'command(openslack workspace validate $(echo injected))',
    'command(openslack workspace validate `echo injected`)',
    'command(openslack workspace validate > .openslack.local/eval-command-redirect.txt)',
  ])('rejects shell syntax without executing it: %s', (check) => {
    const [result] = runEvalSuite(suiteFor(check));

    expect(result.passed).toBe(false);
    expect(result.details).toEqual([
      'FAIL: rejects unsafe command — unsupported command assertion',
    ]);
    expect(markerPaths.some((markerPath) => existsSync(markerPath))).toBe(false);
  });

  it('does not execute a command payload that would create a marker file', () => {
    const [result] = runEvalSuite(
      suiteFor('command(echo compromised > .openslack.local/eval-command-canary.txt)'),
    );

    expect(result.passed).toBe(false);
    expect(result.details[0]).toContain('unsupported command assertion');
    expect(existsSync(markerPaths[0])).toBe(false);
  });

  it.each([
    'command(openslack workspace validate)',
    'command(bun run openslack workspace validate)',
  ])('keeps the allowlisted workspace validation command in process: %s', (check) => {
    const [result] = runEvalSuite(suiteFor(check));

    expect(result.passed).toBe(true);
    expect(result.details[0]).toContain('workspace validate: PASS');
  });
});

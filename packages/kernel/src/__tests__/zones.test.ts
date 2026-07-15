import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import type { RiskZone } from '../types.js';
import { DEFAULT_RISK_ZONE, ZONE_PATTERNS } from '../zone-policy.js';
import { classifyPaths } from '../zones.js';

interface SelfEvolutionPolicyFile {
  zones: {
    fallback_zone: RiskZone;
    green: { paths: string[] };
    yellow: { paths: string[] };
    red: { paths: string[] };
    black: { paths: string[] };
  };
}

const POLICY_PATH = new URL('../../../../.openslack/policies/self_evolution.yaml', import.meta.url);

describe('classifyPaths', () => {
  it('classifies docs changes as green', () => {
    expect(classifyPaths(['docs/product.md'])).toBe('green');
  });

  it('classifies template changes as green', () => {
    expect(classifyPaths(['templates/new-agent/START_HERE.md'])).toBe('green');
  });

  it('classifies task state as green', () => {
    expect(classifyPaths(['.openslack/tasks/open/TASK-001.yaml'])).toBe('green');
  });

  it('classifies every explicit generated-state allowlist as green', () => {
    expect(classifyPaths(['.openslack/audit/pr-42.yaml'])).toBe('green');
    expect(classifyPaths(['.openslack/self/scorecards/2026/07/report.yaml'])).toBe('green');
    expect(classifyPaths(['.openslack/self/experiments/EXP-001.yaml'])).toBe('green');
  });

  it('classifies package core changes as yellow', () => {
    expect(classifyPaths(['packages/core/src/claim-broker.ts'])).toBe('yellow');
  });

  it('classifies workspace package changes as yellow', () => {
    expect(classifyPaths(['packages/workspace/src/validate.ts'])).toBe('yellow');
  });

  it('classifies runtime package changes as yellow', () => {
    expect(classifyPaths(['packages/runtime/src/evals/runner.ts'])).toBe('yellow');
  });

  it('classifies agent runtime package changes as yellow', () => {
    expect(classifyPaths(['packages/agent-runtime/src/launcher.ts'])).toBe('yellow');
    expect(classifyPaths(['packages/agent-runtime/package.json'])).toBe('yellow');
  });

  it('classifies TUI package changes as yellow', () => {
    expect(classifyPaths(['packages/tui/src/views/HomeView.tsx'])).toBe('yellow');
  });

  it('classifies workflow package changes as yellow', () => {
    expect(classifyPaths(['packages/workflows/src/runtime.ts'])).toBe('yellow');
  });

  it('classifies operator package changes as yellow', () => {
    expect(classifyPaths(['packages/operator/src/planner.ts'])).toBe('yellow');
  });

  it('classifies GitHub workflow changes as red', () => {
    expect(classifyPaths(['.github/workflows/test.yml'])).toBe('red');
  });

  it('classifies kernel source changes as red', () => {
    expect(classifyPaths(['packages/kernel/src/zones.ts'])).toBe('red');
  });

  it('classifies agent prompt changes as red', () => {
    expect(classifyPaths(['.openslack/agents/prompts/codex_agent.md'])).toBe('red');
  });

  it('classifies agent registry changes as red', () => {
    expect(classifyPaths(['.openslack/agents/registry/codex_agent.yaml'])).toBe('red');
  });

  it('classifies plugin host implementation paths as red without requiring the path to exist', () => {
    expect(classifyPaths(['packages/plugin-host/package.json'])).toBe('red');
    expect(classifyPaths(['packages/plugin-host/src/runtime.ts'])).toBe('red');
    expect(classifyPaths(['packages/plugin-host/src/future/not-yet-created.ts'])).toBe('red');
  });

  it('classifies plugin manifests and configuration as red', () => {
    expect(classifyPaths(['.openslack/plugins/github-watch/plugin.json'])).toBe('red');
    expect(classifyPaths(['.openslack/plugins/github-watch/config.yaml'])).toBe('red');
  });

  it('classifies the plugin lockfile as red', () => {
    expect(classifyPaths(['.openslack/plugins.lock'])).toBe('red');
  });

  it('classifies canonical agent instructions as red', () => {
    expect(classifyPaths(['AGENTS.md'])).toBe('red');
    expect(classifyPaths(['CLAUDE.md'])).toBe('red');
  });

  it('classifies constitution.md change as red', () => {
    expect(classifyPaths(['.openslack/self/constitution.md'])).toBe('red');
  });

  it('classifies invariants.yaml change as red', () => {
    expect(classifyPaths(['.openslack/self/invariants.yaml'])).toBe('red');
  });

  it('classifies .env as black', () => {
    expect(classifyPaths(['.env'])).toBe('black');
  });

  it('classifies private key as black', () => {
    expect(classifyPaths(['certs/server.key'])).toBe('black');
  });

  it('classifies pem file as black', () => {
    expect(classifyPaths(['ca.pem'])).toBe('black');
  });

  it('classifies secrets directory as black', () => {
    expect(classifyPaths(['secrets/token.txt'])).toBe('black');
  });

  it('returns most restrictive zone for mixed paths (red + green → red)', () => {
    expect(classifyPaths(['docs/readme.md', '.github/workflows/test.yml'])).toBe('red');
  });

  it('returns black for any black path mixed with others', () => {
    expect(classifyPaths(['docs/readme.md', '.env'])).toBe('black');
  });

  it('returns red for yellow + red mixed', () => {
    expect(classifyPaths(['packages/core/src/foo.ts', '.github/workflows/test.yml'])).toBe('red');
  });

  it('returns the maximum plugin risk for mixed green, yellow, and red paths', () => {
    expect(
      classifyPaths([
        'docs/plugins.md',
        'packages/operator/src/planner.ts',
        '.openslack/plugins/github-watch/plugin.json',
      ]),
    ).toBe('red');
  });

  it('defaults unmatched paths to yellow', () => {
    expect(classifyPaths(['package.json'])).toBe('yellow');
    expect(classifyPaths(['packages/future-provider/src/index.ts'])).toBe('yellow');
    expect(classifyPaths(['packages/future-provider/package.json'])).toBe('yellow');
  });

  it('does not let an explicit green path hide an unmatched path', () => {
    expect(classifyPaths(['docs/readme.md', 'new-root-config.yaml'])).toBe('yellow');
  });

  it('fails safe to yellow for an empty path set', () => {
    expect(classifyPaths([])).toBe('yellow');
  });
});

describe('risk zone policy synchronization', () => {
  it('keeps the declarative YAML policy aligned with the runtime classifier', () => {
    const policy = parse(readFileSync(POLICY_PATH, 'utf8')) as SelfEvolutionPolicyFile;

    expect(policy.zones.fallback_zone).toBe(DEFAULT_RISK_ZONE);
    for (const zone of ['green', 'yellow', 'red', 'black'] as const) {
      const runtimeDefinition = ZONE_PATTERNS.find((definition) => definition.zone === zone);
      expect(runtimeDefinition, `runtime definition for ${zone}`).toBeDefined();
      expect(policy.zones[zone].paths).toEqual(runtimeDefinition?.globs);
    }
  });
});

import type { RiskZone } from './types.js';

export interface ZonePatternDefinition {
  zone: RiskZone;
  globs: readonly string[];
}

export const DEFAULT_RISK_ZONE: RiskZone = 'yellow';

export const ZONE_PATTERNS: readonly ZonePatternDefinition[] = [
  {
    zone: 'black',
    globs: [
      '.env',
      '**/*.pem',
      '**/*.key',
      'secrets/**',
      'credentials/**',
      'private/**',
      'production-tokens/**',
    ],
  },
  {
    zone: 'red',
    globs: [
      'AGENTS.md',
      'CLAUDE.md',
      '.github/**',
      '.openslack/policies/**',
      '.openslack/agents/registry/**',
      '.openslack/agents/prompts/**',
      '.openslack/self/constitution.md',
      '.openslack/self/invariants.yaml',
      'packages/kernel/src/**',
    ],
  },
  {
    zone: 'yellow',
    globs: [
      'apps/**',
      'packages/core/**',
      'packages/workspace/**',
      'packages/runtime/**',
      'packages/github/**',
      'packages/pr/**',
      'packages/operator/**',
      'packages/chat-gateway/**',
      'packages/collaboration/**',
      'packages/agent-runtime/**',
      'packages/tui/**',
      'packages/workflows/**',
      '.openslack/self/eval_suites/**',
    ],
  },
  {
    zone: 'green',
    globs: [
      'docs/**',
      'templates/**',
      '.openslack/tasks/**',
      '.openslack/audit/**',
      '.openslack/self/scorecards/**',
      '.openslack/self/experiments/**',
    ],
  },
];

import type { RiskZone } from './types.js';

export interface ZonePatternDefinition {
  zone: RiskZone;
  globs: readonly string[];
}

export const DEFAULT_RISK_ZONE: RiskZone = 'yellow';

export const PLUGIN_TRUST_RED_PATHS = [
  '.openslack/plugins/**',
  '.openslack/plugins.lock',
  // Deliberately protects package metadata, exports, and build wiring in addition to src/**.
  'packages/plugin-host/**',
] as const;

const [PLUGIN_CONFIG_GLOB, PLUGIN_LOCK_PATH, PLUGIN_HOST_GLOB] = PLUGIN_TRUST_RED_PATHS;

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
      PLUGIN_CONFIG_GLOB,
      PLUGIN_LOCK_PATH,
      '.openslack/self/constitution.md',
      '.openslack/self/invariants.yaml',
      'packages/kernel/src/**',
      PLUGIN_HOST_GLOB,
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

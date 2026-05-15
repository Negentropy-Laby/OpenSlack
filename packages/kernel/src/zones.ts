import type { RiskZone } from './types.js';

const ZONE_PATTERNS: Array<{ zone: RiskZone; globs: string[] }> = [
  {
    zone: 'black',
    globs: ['.env', '**/*.pem', '**/*.key', 'secrets/**', 'credentials/**', 'private/**', 'production-tokens/**'],
  },
  {
    zone: 'red',
    globs: [
      '.github/**',
      '.openslack/policies/**',
      '.openslack/agents/registry/**',
      '.openslack/agents/prompts/**',
      '.openslack/self/constitution.md',
      '.openslack/self/invariants.yaml',
      'packages/policy/src/**',
      'packages/self-evolution/src/core/**',
    ],
  },
  {
    zone: 'yellow',
    globs: [
      'apps/**',
      'packages/core/**',
      'packages/workspace-engine/**',
      'packages/github-provider/**',
      'packages/agent-runtime/**',
      'packages/chat-gateway/**',
      'packages/git-sync/**',
      'packages/evals/**',
      'packages/self-evolution/src/ops/**',
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
      '.openslack/self/experiments/**',
      '.openslack/self/scorecards/**',
    ],
  },
];

function matchesGlob(path: string, glob: string): boolean {
  // Simple glob matching: ** matches any depth, * matches within a segment
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '<<GLOBSTAR_SLASH>>')
    .replace(/\*\*/g, '<<GLOBSTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<GLOBSTAR_SLASH>>/g, '(.*/)?')
    .replace(/<<GLOBSTAR>>/g, '.*');
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(path);
}

export function classifyPaths(changedPaths: string[]): RiskZone {
  let highestZone: RiskZone = 'green';
  const zoneOrder: RiskZone[] = ['green', 'yellow', 'red', 'black'];

  for (const path of changedPaths) {
    for (const { zone, globs } of ZONE_PATTERNS) {
      for (const glob of globs) {
        if (matchesGlob(path, glob)) {
          if (zoneOrder.indexOf(zone) > zoneOrder.indexOf(highestZone)) {
            highestZone = zone;
          }
        }
      }
    }
  }

  return highestZone;
}

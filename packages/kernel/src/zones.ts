import type { RiskZone } from './types.js';
import { DEFAULT_RISK_ZONE, ZONE_PATTERNS } from './zone-policy.js';

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
  if (changedPaths.length === 0) return 'yellow';

  let highestZone: RiskZone = 'green';
  const zoneOrder: RiskZone[] = ['green', 'yellow', 'red', 'black'];

  for (const path of changedPaths) {
    let pathZone: RiskZone | undefined;

    for (const { zone, globs } of ZONE_PATTERNS) {
      for (const glob of globs) {
        if (matchesGlob(path, glob)) {
          if (!pathZone || zoneOrder.indexOf(zone) > zoneOrder.indexOf(pathZone)) {
            pathZone = zone;
          }
        }
      }
    }

    // Only explicitly enumerated Green paths are auto-merge eligible. New,
    // misspelled, or otherwise unclassified paths fail safe to Yellow so a
    // future package cannot silently bypass independent review.
    const effectiveZone = pathZone ?? DEFAULT_RISK_ZONE;
    if (zoneOrder.indexOf(effectiveZone) > zoneOrder.indexOf(highestZone)) {
      highestZone = effectiveZone;
    }
  }

  return highestZone;
}

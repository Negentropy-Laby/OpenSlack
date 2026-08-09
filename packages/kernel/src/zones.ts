import type { RiskZone } from './types.js';
import { DEFAULT_RISK_ZONE, ZONE_PATTERNS } from './zone-policy.js';
import { compilePathGlob } from './path-glob.js';

const COMPILED_ZONE_PATTERNS = ZONE_PATTERNS.flatMap(({ zone, globs }) =>
  globs.map((glob) => ({ zone, matches: compilePathGlob(glob) })),
);

export function classifyPaths(changedPaths: string[]): RiskZone {
  if (changedPaths.length === 0) return 'yellow';

  let highestZone: RiskZone = 'green';
  const zoneOrder: RiskZone[] = ['green', 'yellow', 'red', 'black'];

  for (const path of changedPaths) {
    let pathZone: RiskZone | undefined;

    for (const { zone, matches } of COMPILED_ZONE_PATTERNS) {
      if (matches(path) && (!pathZone || zoneOrder.indexOf(zone) > zoneOrder.indexOf(pathZone))) {
        pathZone = zone;
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

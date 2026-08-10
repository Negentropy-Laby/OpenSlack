import type { RiskZone } from './types.js';
import { DEFAULT_RISK_ZONE, ZONE_PATTERNS } from './zone-policy.js';
import { compilePathGlob, pathGlobCovers, pathGlobsIntersect } from './path-glob.js';

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

/**
 * Classify declared path globs by the highest canonical repository area they can cover.
 * Suffix-only Black rules apply when they cover the whole declaration; rooted Black and
 * Red rules apply on any overlap. This preserves docs/** as Green while refusing universal
 * or protected-subtree declarations such as ** and packages/**.
 */
export function classifyDeclaredScopes(declaredScopes: string[]): RiskZone {
  if (declaredScopes.length === 0) return 'yellow';
  let highestZone: RiskZone = 'green';
  const zoneOrder: RiskZone[] = ['green', 'yellow', 'red', 'black'];

  for (const scope of declaredScopes) {
    let scopeZone: RiskZone | undefined;
    for (const definition of ZONE_PATTERNS) {
      for (const glob of definition.globs) {
        const suffixOnlyBlack = definition.zone === 'black' && glob.startsWith('**/');
        const matchesZone = suffixOnlyBlack
          ? pathGlobCovers(glob, scope)
          : pathGlobsIntersect(scope, glob);
        if (
          matchesZone &&
          (!scopeZone || zoneOrder.indexOf(definition.zone) > zoneOrder.indexOf(scopeZone))
        ) {
          scopeZone = definition.zone;
        }
      }
    }
    if (!scopeZone) {
      const coveredByGreen = ZONE_PATTERNS.find(({ zone }) => zone === 'green')!.globs.some(
        (glob) => pathGlobCovers(glob, scope),
      );
      scopeZone = coveredByGreen ? 'green' : DEFAULT_RISK_ZONE;
    }
    if (zoneOrder.indexOf(scopeZone) > zoneOrder.indexOf(highestZone)) highestZone = scopeZone;
  }
  return highestZone;
}

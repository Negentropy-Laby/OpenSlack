import { classifyPaths } from '@openslack/kernel';

export interface ClassifiedPathGroups {
  green: string[];
  yellow: string[];
  red: string[];
}

export interface ExactClassifiedPathGroups extends ClassifiedPathGroups {
  black: string[];
}

function classifyEachPath(paths: string[]) {
  return paths.map((path) => ({ path, zone: classifyPaths([path]) }));
}

/**
 * Classify each path through the kernel policy and retain the existing
 * three-bucket workflow API. Black paths share the red bucket because both are
 * blocked from ordinary workflow mutation; callers that need the exact zone
 * must invoke the kernel classifier directly.
 */
export function classifyPathGroups(paths: string[]): ClassifiedPathGroups {
  const groups: ClassifiedPathGroups = { green: [], yellow: [], red: [] };

  for (const { path, zone } of classifyEachPath(paths)) {
    if (zone === 'green') groups.green.push(path);
    else if (zone === 'yellow') groups.yellow.push(path);
    else groups.red.push(path);
  }

  return groups;
}

/**
 * Classify paths without collapsing Black into Red. Use this variant when a
 * caller must distinguish an escalatable Red change from a forbidden Black
 * path. The existing three-bucket API remains unchanged for compatibility.
 */
export function classifyPathGroupsExact(paths: string[]): ExactClassifiedPathGroups {
  const groups: ExactClassifiedPathGroups = { green: [], yellow: [], red: [], black: [] };

  for (const { path, zone } of classifyEachPath(paths)) {
    groups[zone].push(path);
  }

  return groups;
}

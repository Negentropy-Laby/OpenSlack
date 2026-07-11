import { classifyPaths } from '@openslack/kernel';

export interface ClassifiedPathGroups {
  green: string[];
  yellow: string[];
  red: string[];
}

/**
 * Classify each path through the kernel policy and retain the existing
 * three-bucket workflow API. Black paths share the red bucket because both are
 * blocked from ordinary workflow mutation; callers that need the exact zone
 * must invoke the kernel classifier directly.
 */
export function classifyPathGroups(paths: string[]): ClassifiedPathGroups {
  const groups: ClassifiedPathGroups = { green: [], yellow: [], red: [] };

  for (const path of paths) {
    const zone = classifyPaths([path]);
    if (zone === 'green') groups.green.push(path);
    else if (zone === 'yellow') groups.yellow.push(path);
    else groups.red.push(path);
  }

  return groups;
}

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Package dependency boundary guard.
 *
 * `@openslack/runtime` depends on `@openslack/pr`. If `@openslack/pr` ever
 * imported `@openslack/runtime`, the two packages would form a cycle. This
 * guard fails if that edge appears, directly or transitively, so the cycle
 * cannot be introduced silently.
 *
 * A plain "does pr import runtime" grep is not enough: the edge could arrive
 * through an intermediate package, which is why the whole closure is walked.
 */
const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const packagesRoot = join(repositoryRoot, 'packages');

function packageDirectory(packageName: string): string {
  return join(packagesRoot, packageName.replace('@openslack/', ''));
}

/** Workspace-local dependency edges declared by a package. */
function workspaceDependencies(packageName: string): string[] {
  let parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    parsed = JSON.parse(readFileSync(join(packageDirectory(packageName), 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  return Object.keys({ ...parsed.dependencies, ...parsed.devDependencies })
    .filter((name) => name.startsWith('@openslack/'))
    .sort();
}

/** Every workspace package reachable from `start`, excluding `start` itself. */
function reachableFrom(start: string): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const next of workspaceDependencies(current)) {
      if (next === start || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mts|cts)$/.test(entry)) found.push(full);
  }
  return found;
}

describe('package dependency boundary', () => {
  it('has no pr -> runtime edge', () => {
    expect(workspaceDependencies('@openslack/pr')).not.toContain('@openslack/runtime');
  });

  it('cannot reach runtime transitively from pr', () => {
    // The closure is what would actually create the cycle.
    expect([...reachableFrom('@openslack/pr')]).not.toContain('@openslack/runtime');
  });

  it('keeps the guard meaningful: runtime does depend on pr', () => {
    // This is the other half of the cycle. If it ever stops being true, the
    // guard above is checking for an edge that could no longer form a cycle,
    // and this test says so instead of leaving a silently vacuous check.
    expect(workspaceDependencies('@openslack/runtime')).toContain('@openslack/pr');
  });

  it('has no runtime import anywhere in pr production source', () => {
    // Only production source is scanned: test files legitimately assert this
    // boundary, so a raw text search over the whole tree would flag the guard
    // itself. A real import in shipped code must still be caught.
    const offenders: string[] = [];
    for (const file of sourceFiles(join(packagesRoot, 'pr', 'src'))) {
      if (file.includes(`${sep}__tests__${sep}`)) continue;
      const text = readFileSync(file, 'utf8');
      if (/@openslack\/runtime|runtime\/src\//.test(text)) {
        offenders.push(file.slice(repositoryRoot.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('allows the standalone client script to use runtime, as designed', () => {
    // The client is a script, not the package: resolving the fixed identity is
    // explicitly its job, so this edge must remain permitted.
    const client = readFileSync(join(repositoryRoot, 'scripts', 'cleanup-broker', 'client.ts'), 'utf8');
    expect(client).toContain('runtime/src/identity.js');
  });
});

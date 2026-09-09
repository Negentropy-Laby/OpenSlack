const pathParts = (path: string): string[] => {
  if (!/^\/(?:[A-Za-z][A-Za-z0-9]*)(?:\/[A-Za-z][A-Za-z0-9]*)*$/.test(path))
    throw new Error('Invalid corpus path.');
  const keys = path.slice(1).split('/');
  if (keys.some((key) => ['constructor', 'prototype', '__proto__'].includes(key)))
    throw new Error('Unsafe corpus path.');
  return keys;
};

/** Parent writes precede children; all deletions happen after writes. */
export function applyBindingCorpus(
  value: Record<string, unknown>,
  set: Record<string, unknown>,
  remove: readonly string[],
): void {
  const paths = Object.keys(set);
  for (const path of [...paths, ...remove]) pathParts(path);
  paths.sort((a, b) => pathParts(a).length - pathParts(b).length || (a < b ? -1 : a > b ? 1 : 0));
  const parent = (path: string) => {
    const keys = pathParts(path);
    const key = keys.pop()!;
    let record = value;
    for (const part of keys) {
      if (
        !Object.hasOwn(record, part) ||
        record[part] === null ||
        typeof record[part] !== 'object' ||
        Array.isArray(record[part])
      )
        throw new Error('Unknown corpus parent.');
      record = record[part] as Record<string, unknown>;
    }
    return { record, key };
  };
  for (const path of paths) {
    const { record, key } = parent(path);
    record[key] = structuredClone(set[path]);
  }
  for (const path of remove) {
    const { record, key } = parent(path);
    delete record[key];
  }
}

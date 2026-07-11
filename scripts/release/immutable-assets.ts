import { lstatSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArg, sha256File } from './lib.js';

export interface ImmutableAssetSet {
  files: Array<{ name: string; sha256: string }>;
}

export function readImmutableAssetSet(directoryInput: string): ImmutableAssetSet {
  const directory = resolve(directoryInput);
  const files = readdirSync(directory)
    .sort()
    .map((name) => {
      if (name !== basename(name)) throw new Error('Release asset has an unsafe file name.');
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Release asset set contains a non-regular file: ${name}`);
      }
      return { name, sha256: sha256File(path) };
    });
  if (files.length === 0) throw new Error('Release asset set is empty.');
  return { files };
}

export function assertImmutableAssetSetsMatch(expectedDir: string, actualDir: string): void {
  const expected = readImmutableAssetSet(expectedDir);
  const actual = readImmutableAssetSet(actualDir);
  const expectedNames = expected.files.map((file) => file.name);
  const actualNames = actual.files.map((file) => file.name);
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
    throw new Error(
      `Published release asset set differs from the candidate. Expected [${expectedNames.join(', ')}], got [${actualNames.join(', ')}].`,
    );
  }
  for (let index = 0; index < expected.files.length; index += 1) {
    const expectedFile = expected.files[index]!;
    const actualFile = actual.files[index]!;
    if (expectedFile.sha256 !== actualFile.sha256) {
      throw new Error(`Published release asset differs from the candidate: ${expectedFile.name}`);
    }
  }
}

if (import.meta.main) {
  const expected = parseArg('--expected');
  const actual = parseArg('--actual');
  if (!expected || !actual) {
    throw new Error(
      'Usage: bun scripts/release/immutable-assets.ts --expected <dir> --actual <dir>',
    );
  }
  assertImmutableAssetSetsMatch(expected, actual);
  console.log(
    'PASS: published release assets are byte-identical to the candidate; no upload required.',
  );
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as HarnessRead from '../harness-read.js';
import { readHarnessFile } from '../harness-read.js';
import { HarnessHostSourceObserver } from '../harness-source.js';

vi.mock('../harness-read.js', async original => {
  const actual = await original<typeof HarnessRead>();
  return { ...actual, readHarnessFile: vi.fn(actual.readHarnessFile) };
});
const roots: string[] = [];
const reads = vi.mocked(readHarnessFile);
afterEach(() => { reads.mockClear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-source-')); roots.push(root);
  mkdirSync(join(root, 'internal/nested'), { recursive: true });
  writeFileSync(join(root, 'index.ts'), 'export const main = 1;');
  writeFileSync(join(root, 'internal/nested/helper.ts'), 'export const helper = 1;');
  return root;
}

describe('complete Harness production module observations', () => {
  it('hashes nested production modules once while excluding tests, fixtures and declarations', () => {
    const root = fixture();
    for (const directory of ['__tests__', '__fixtures__', 'fixtures', 'fixture']) {
      mkdirSync(join(root, directory)); writeFileSync(join(root, directory, 'ignored.ts'), 'ignored');
    }
    writeFileSync(join(root, 'contract.d.ts'), 'ignored declaration');
    writeFileSync(join(root, 'local.test.ts'), 'ignored test');
    const observer = new HarnessHostSourceObserver(root, '.ts');
    const first = observer.observe();
    const rows = [['index.ts', 'export const main = 1;'], ['internal/nested/helper.ts', 'export const helper = 1;']];
    const expected = createHash('sha256').update('openslack.harness_host_source.v1:typescript-source\n')
      .update(rows.map(([path, text]) => JSON.stringify([path, createHash('sha256').update(text!).digest('hex')]) + '\n').join('')).digest('hex');
    expect(first).toMatchObject({ hash: expected, domain: 'typescript-source' });
    expect(reads.mock.calls.map(([path]) => path)).toEqual([join(root, 'index.ts'), join(root, 'internal/nested/helper.ts')]);
    expect(observer.observe()).toBe(first);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it.each(['add', 'change', 'rename'] as const)('invalidates a cached proof after a nested production module %s', operation => {
    const root = fixture(), observer = new HarnessHostSourceObserver(root, '.ts');
    observer.observe();
    const path = join(root, 'internal/nested/helper.ts');
    if (operation === 'add') writeFileSync(join(root, 'internal/nested/added.ts'), 'new module');
    if (operation === 'change') writeFileSync(path, 'export const helper = 2;');
    if (operation === 'rename') renameSync(path, join(root, 'internal/nested/renamed.ts'));
    expect(() => observer.observe()).toThrow('build changed during observation');
  });

  it('keeps compiled-JavaScript and TypeScript-source identities in explicit distinct domains', () => {
    const root = fixture();
    writeFileSync(join(root, 'index.js'), 'export const main = 1;');
    expect(new HarnessHostSourceObserver(root, '.js').observe().domain).toBe('javascript-artifact');
    expect(new HarnessHostSourceObserver(root, '.ts').observe().domain).toBe('typescript-source');
  });

  it('frames paths and bodies so different production file sets cannot share concatenated input bytes', () => {
    const first = mkdtempSync(join(tmpdir(), 'harness-source-framing-a-')), second = mkdtempSync(join(tmpdir(), 'harness-source-framing-b-'));
    roots.push(first, second);
    writeFileSync(join(first, 'a.ts'), 'b.ts');
    writeFileSync(join(second, 'a.tsb.ts'), '');
    expect(new HarnessHostSourceObserver(first, '.ts').observe().hash).not.toBe(new HarnessHostSourceObserver(second, '.ts').observe().hash);
  });

  it('rejects a nested directory link rather than silently excluding executable modules', () => {
    const root = fixture();
    symlinkSync(join(root, 'internal'), join(root, 'linked'), 'junction');
    expect(() => new HarnessHostSourceObserver(root, '.ts').observe()).toThrow('module links');
  });
});

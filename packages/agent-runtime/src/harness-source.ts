import { createHash } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readHarnessFile } from './harness-read.js';

const NON_EXECUTION_DIRECTORIES = new Set(['__tests__', '__fixtures__', '__snapshots__', 'fixture', 'fixtures', 'node_modules']);
type SourceDomain = 'typescript-source' | 'javascript-artifact';
interface SourceObservation { readonly hash: string; readonly domain: SourceDomain; readonly stamps: readonly string[] }

/** One closed production module tree; callers cannot supply a replacement cached proof. */
export class HarnessHostSourceObserver {
  private cached?: SourceObservation;
  constructor(private readonly root: string, private readonly extension: '.ts' | '.js') {
    if (!isAbsolute(root)) throw new TypeError('Harness source root must be absolute');
  }

  observe(): Readonly<{ hash: string; domain: SourceDomain }> {
    const files: string[] = [];
    const walk = (directory: string, prefix: string): void => {
      const actual = lstatSync(directory);
      if (!actual.isDirectory() || actual.isSymbolicLink()) throw new Error('Harness host build cannot traverse directory links');
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Harness host build cannot traverse module links');
        if (entry.isDirectory()) {
          if (!NON_EXECUTION_DIRECTORIES.has(entry.name)) walk(path, `${prefix}${entry.name}/`);
        } else if (entry.name.endsWith(this.extension) && !entry.name.endsWith('.d.ts') && !/\.(?:test|spec)\.[jt]s$/.test(entry.name)) {
          if (!entry.isFile()) throw new Error('Harness host module is not an ordinary file');
          files.push(`${prefix}${entry.name}`);
        }
      }
    };
    walk(this.root, '');
    files.sort();
    const stamps = files.map(path => {
      const value = lstatSync(join(this.root, path), { bigint: true });
      return `${path}:${value.dev}:${value.ino}:${value.mode}:${value.nlink}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
    });
    if (this.cached) {
      if (stamps.length !== this.cached.stamps.length || stamps.some((stamp, index) => stamp !== this.cached!.stamps[index])) {
        throw new Error('Harness host build changed during observation');
      }
      return this.cached;
    }
    const domain = this.extension === '.ts' ? 'typescript-source' : 'javascript-artifact';
    const digest = createHash('sha256').update(`openslack.harness_host_source.v1:${domain}\n`);
    for (const path of files) {
      const body = readHarnessFile(join(this.root, path), 16 * 1024 * 1024, { trustedArtifact: true, allowEmpty: true });
      digest.update(JSON.stringify([path, createHash('sha256').update(body).digest('hex')]) + '\n');
    }
    this.cached = Object.freeze({ hash: digest.digest('hex'), domain,
      stamps: Object.freeze(stamps) });
    return this.cached;
  }
}

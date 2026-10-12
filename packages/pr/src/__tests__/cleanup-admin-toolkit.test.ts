import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { declareLinuxCleanupTests } from './helpers/cleanup-platform-qualification.js';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as Fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLEANUP_ADMIN_TOOLKIT_FILES,
  CLEANUP_ADMIN_TOOLKIT_SCHEMAS,
  CleanupAdminToolkitError,
  parseCleanupAdminToolkitBuildReport,
  parseCleanupAdminToolkitManifest,
  prepareCleanupAdminToolkit,
  readCleanupAdminToolkitPreparationInput,
  verifyCleanupAdminToolkit,
} from '../cleanup-admin-toolkit.js';
import type {
  CleanupAdminToolkitBuildReport,
  PrepareCleanupAdminToolkitInput,
  PrepareCleanupAdminToolkitResult,
} from '../cleanup-admin-toolkit.js';

const faults = vi.hoisted(() => {
  const defaults = {
    maxWrite: 0,
    zeroWrite: false,
    fileSync: false,
    fstatAt: 0,
    fstatCalls: 0,
    writes: 0,
    drift: '',
  };
  return { defaults, active: { ...defaults } };
});
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof Fs>();
  return {
    ...actual,
    writeSync(
      fd: number,
      data: Uint8Array,
      offset: number,
      length: number,
      position?: number | null,
    ): number {
      faults.active.writes++;
      if (faults.active.zeroWrite) return 0;
      return actual.writeSync(
        fd,
        data,
        offset,
        faults.active.maxWrite ? Math.min(length, faults.active.maxWrite) : length,
        position,
      );
    },
    fsyncSync(fd: number): void {
      if (faults.active.fileSync && actual.fstatSync(fd).isFile())
        throw Object.assign(new Error('fixture fsync'), { code: 'EIO' });
      actual.fsyncSync(fd);
    },
    fstatSync(fd: number): Fs.Stats {
      if (++faults.active.fstatCalls === faults.active.fstatAt)
        throw Object.assign(new Error('fixture fstat'), { code: 'EIO' });
      return actual.fstatSync(fd);
    },
    readSync(
      fd: number,
      data: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ): number {
      const count = actual.readSync(fd, data, offset, length, position);
      if (
        faults.active.drift &&
        actual.readlinkSync(`/proc/self/fd/${fd}`) === faults.active.drift
      ) {
        actual.appendFileSync(faults.active.drift, '# changed during read\n');
        faults.active.drift = '';
      }
      return count;
    },
  };
});
const raw = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const HEAD = 'a'.repeat(40);
function report(head = HEAD, checkout = '/var/tmp/independent-a'): CleanupAdminToolkitBuildReport {
  return {
    schema: CLEANUP_ADMIN_TOOLKIT_SCHEMAS.build,
    candidateHead: head,
    checkout,
    checkoutCleanAfterBuild: true,
    independentCloneNoHardlinks: true,
    tools: {
      bun: '1.4.0',
      go: 'go version go1.26.5 linux/amd64',
      node: 'v24.18.1',
      git: 'git version 2.43.0',
    },
    lockfileSHA256: 'b'.repeat(64),
    commands: ['bun build <entry> --target=node'],
    artifacts: CLEANUP_ADMIN_TOOLKIT_FILES.map((path) => ({
      path,
      sha256: 'c'.repeat(64),
      bytes: 12,
    })),
  };
}
function caught(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(CleanupAdminToolkitError);
    return (error as CleanupAdminToolkitError).code;
  }
}

afterEach(() => {
  Object.assign(faults.active, faults.defaults);
});

describe('admin toolkit closed pure contracts, on every platform', () => {
  it('includes all runtime dependencies and returns immutable validated values', () => {
    expect(CLEANUP_ADMIN_TOOLKIT_FILES).toContain('_safety.py');
    const value = parseCleanupAdminToolkitBuildReport(raw(report()), HEAD);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.artifacts[0])).toBe(true);
    expect(Object.isFrozen(value.tools)).toBe(true);
    expect(value.artifacts).toHaveLength(CLEANUP_ADMIN_TOOLKIT_FILES.length);
  });
  it.each([
    ['unknown root field', { ...report(), authorization: true }],
    ['missing clean proof', { ...report(), checkoutCleanAfterBuild: undefined }],
    ['dirty claim', { ...report(), checkoutCleanAfterBuild: false }],
    ['missing clone proof', { ...report(), independentCloneNoHardlinks: undefined }],
    ['shared clone claim', { ...report(), independentCloneNoHardlinks: false }],
    ['relative checkout', { ...report(), checkout: 'relative' }],
    ['parent traversal', { ...report(), checkout: '/var/tmp/../outside' }],
    ['external descriptor', { ...report(), checkout: '/proc/self/fd/99/repo' }],
    ['empty commands', { ...report(), commands: [] }],
    ['control in command', { ...report(), commands: ['bun\ninstall'] }],
    ['unknown tool field', { ...report(), tools: { ...report().tools, arbitrary: 'tool' } }],
    ['non-Linux Node pin', { ...report(), tools: { ...report().tools, node: 'v22.0.0' } }],
    ['missing artifact', { ...report(), artifacts: report().artifacts.slice(1) }],
    [
      'duplicate artifact',
      { ...report(), artifacts: [...report().artifacts.slice(0, -1), report().artifacts[0]] },
    ],
    [
      'traversal artifact',
      {
        ...report(),
        artifacts: report().artifacts.map((file, i) =>
          i ? file : { ...file, path: '../target-observation.py' },
        ),
      },
    ],
    [
      'empty declared tool',
      {
        ...report(),
        artifacts: report().artifacts.map((file, i) => (i ? file : { ...file, bytes: 0 })),
      },
    ],
    [
      'oversize tool',
      {
        ...report(),
        artifacts: report().artifacts.map((file, i) =>
          i ? file : { ...file, bytes: 17 * 1024 * 1024 },
        ),
      },
    ],
    [
      'false digest',
      {
        ...report(),
        artifacts: report().artifacts.map((file, i) =>
          i ? file : { ...file, sha256: 'REQUIRED_SHA256' },
        ),
      },
    ],
  ])('rejects %s', (_label, value) => {
    expect(caught(() => parseCleanupAdminToolkitBuildReport(raw(value), HEAD))).toBe(
      'ADMIN_TOOLKIT_BUILD_INVALID',
    );
  });
  it.each([
    Buffer.from('{"schema":"x","schema":"x"}'),
    Buffer.from('{"schema":"x","\\u0073chema":"x"}'),
    Buffer.from('{"schema":'),
  ])('rejects ambiguous or incomplete JSON, not bare JSON.parse', (value) => {
    expect(caught(() => parseCleanupAdminToolkitBuildReport(value, HEAD))).toBe(
      'ADMIN_TOOLKIT_BUILD_INVALID',
    );
  });
  it('rejects invalid UTF-8 before parsing', () => {
    expect(caught(() => parseCleanupAdminToolkitBuildReport(Buffer.from([0xff]), HEAD))).toBe(
      'ADMIN_TOOLKIT_UTF8_INVALID',
    );
  });
  it('rejects oversized reports before decoding their payload', () => {
    expect(
      caught(() => parseCleanupAdminToolkitBuildReport(Buffer.alloc(256 * 1024 + 1, 32), HEAD)),
    ).toBe('ADMIN_TOOLKIT_BUILD_INVALID');
  });
  it('rejects manifest schema downgrade, missing files and unknown fields', () => {
    const files = [
      ...report().artifacts,
      ...['evidence/build-a.json', 'evidence/build-b.json'].map((path) => ({
        path,
        sha256: 'd'.repeat(64),
        bytes: 100,
      })),
    ];
    const manifest = { schema: CLEANUP_ADMIN_TOOLKIT_SCHEMAS.manifest, candidateHead: HEAD, files };
    expect(parseCleanupAdminToolkitManifest(raw(manifest), HEAD).files).toHaveLength(
      CLEANUP_ADMIN_TOOLKIT_FILES.length + 2,
    );
    for (const value of [
      { ...manifest, schema: 'v0' },
      { ...manifest, files: files.slice(1) },
      { ...manifest, installed: true },
    ])
      expect(caught(() => parseCleanupAdminToolkitManifest(raw(value), HEAD))).toBe(
        'ADMIN_TOOLKIT_MANIFEST_INVALID',
      );
  });
  it.each(['win32', 'darwin'] as const)(
    'refuses %s IO before writes or source inspection',
    (platform) => {
      const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
      try {
        const input: PrepareCleanupAdminToolkitInput = {
          sourceRoot: '/not-an-existing-source',
          candidateHead: HEAD,
          outputDirectory: '/not-an-existing-output',
          builds: [
            { reportPath: '/a', toolDirectory: '/a' },
            { reportPath: '/b', toolDirectory: '/b' },
          ],
        };
        expect(caught(() => prepareCleanupAdminToolkit(input))).toBe(
          'ADMIN_TOOLKIT_PLATFORM_UNSUPPORTED',
        );
        expect(
          verifyCleanupAdminToolkit({
            packageDirectory: '/not-existing',
            candidateHead: HEAD,
            manifestSHA256: 'b'.repeat(64),
          }).errors,
        ).toEqual(['ADMIN_TOOLKIT_PLATFORM_UNSUPPORTED']);
        expect(faults.active.writes).toBe(0);
        expect(faults.active.fstatCalls).toBe(0);
      } finally {
        Object.defineProperty(process, 'platform', descriptor);
      }
    },
  );
});

if (declareLinuxCleanupTests) {
  describe('real descriptor-bound independent toolkit on Linux', () => {
    let base: string,
      source: string,
      candidate: string,
      clones: [string, string],
      serial = 0;
    let input: PrepareCleanupAdminToolkitInput, caseRoot: string, bundle: Buffer, preparer: string;
    function git(root: string, args: readonly string[]): string {
      return execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          LANG: 'C',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      }).trim();
    }
    function updateReport(
      index: number,
      mutate?: (value: CleanupAdminToolkitBuildReport) => unknown,
    ): void {
      const build = input.builds[index]!;
      const value: CleanupAdminToolkitBuildReport = {
        ...report(candidate, clones[index]!),
        lockfileSHA256: hash(readFileSync(join(source, 'bun.lock'))),
        artifacts: CLEANUP_ADMIN_TOOLKIT_FILES.map((path) => {
          const data = readFileSync(join(build.toolDirectory, path));
          return { path, bytes: data.length, sha256: hash(data) };
        }),
      };
      writeFileSync(build.reportPath, raw(mutate ? mutate(value) : value));
    }
    function prepare(): PrepareCleanupAdminToolkitResult {
      return prepareCleanupAdminToolkit(input);
    }
    function verify(value: PrepareCleanupAdminToolkitResult) {
      return verifyCleanupAdminToolkit({
        packageDirectory: value.packageDirectory,
        candidateHead: candidate,
        manifestSHA256: value.manifestSHA256,
      });
    }
    function expectRefusal(code: string): void {
      expect(caught(prepare)).toBe(code);
      expect(existsSync(input.outputDirectory)).toBe(false);
    }
    function rebindPackage(
      result: PrepareCleanupAdminToolkitResult,
    ): PrepareCleanupAdminToolkitResult {
      const paths = [
        ...CLEANUP_ADMIN_TOOLKIT_FILES,
        'evidence/build-a.json',
        'evidence/build-b.json',
      ].sort();
      const manifest = {
        schema: CLEANUP_ADMIN_TOOLKIT_SCHEMAS.manifest,
        candidateHead: candidate,
        files: paths.map((path) => {
          const data = readFileSync(join(result.packageDirectory, path));
          return { path, sha256: hash(data), bytes: data.length };
        }),
      };
      writeFileSync(join(result.packageDirectory, 'manifest.json'), raw(manifest));
      const sums = Buffer.from(
        [...paths, 'manifest.json']
          .sort()
          .map((path) => `${hash(readFileSync(join(result.packageDirectory, path)))}  ./${path}\n`)
          .join(''),
      );
      writeFileSync(join(result.packageDirectory, 'SHA256SUMS'), sums);
      return { ...result, manifestSHA256: hash(sums) };
    }
    beforeAll(() => {
      base = mkdtempSync(join(tmpdir(), 'cleanup admin toolkit fixtures '));
      source = join(base, 'source');
      mkdirSync(join(source, 'services/cleanup-broker'), { recursive: true });
      writeFileSync(
        join(source, 'package.json'),
        raw({ devDependencies: { 'bun-types': '1.4.0' } }),
      );
      writeFileSync(join(source, 'bun.lock'), 'fixture lock\n');
      writeFileSync(
        join(source, 'services/cleanup-broker/go.mod'),
        'module fixture\n\ngo 1.26.5\n',
      );
      git(source, ['init', '--quiet']);
      git(source, ['config', 'user.name', 'Fixture']);
      git(source, ['config', 'user.email', 'fixture@example.invalid']);
      git(source, ['add', '.']);
      git(source, ['commit', '--quiet', '-m', 'fixture']);
      candidate = git(source, ['rev-parse', 'HEAD']);
      clones = [join(base, 'checkout-a'), join(base, 'checkout-b')];
      for (const clone of clones) git(base, ['clone', '--quiet', '--no-local', source, clone]);
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
      const verifier = join(base, 'bundle/verify-toolkit.mjs');
      preparer = join(base, 'bundle/prepare-toolkit.mjs');
      for (const [entry, out] of [
        ['verify-toolkit.ts', verifier],
        ['prepare-toolkit.ts', preparer],
      ])
        execFileSync(
          'bun',
          [
            'build',
            join(root, 'scripts/cleanup-broker/administration', entry!),
            '--target=node',
            '--format=esm',
            '--outfile',
            out!,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } },
        );
      bundle = readFileSync(verifier);
    }, 30_000);
    beforeEach(() => {
      caseRoot = join(base, `case-${++serial}`);
      mkdirSync(caseRoot);
      const builds = [0, 1].map((index) => {
        const buildRoot = join(caseRoot, `build-${index}`),
          tools = join(buildRoot, 'admin-toolkit');
        mkdirSync(tools, { recursive: true });
        for (const name of CLEANUP_ADMIN_TOOLKIT_FILES)
          writeFileSync(
            join(tools, name),
            name === 'verify-toolkit.mjs' ? bundle : Buffer.from(`# fixture ${name}\n`),
            { mode: 0o664 },
          );
        return {
          reportPath: join(buildRoot, 'admin-toolkit-build-report.json'),
          toolDirectory: tools,
        };
      });
      input = {
        sourceRoot: source,
        candidateHead: candidate,
        outputDirectory: join(caseRoot, 'new toolkit package'),
        builds: builds as [(typeof builds)[number], (typeof builds)[number]],
      };
      updateReport(0);
      updateReport(1);
    });
    afterAll(() => {
      if (base) rmSync(base, { recursive: true, force: true });
    });

    it('publishes a complete fixed sibling package with external binding and no authorization', () => {
      const result = prepare(),
        verified = verify(result);
      expect(result.fileCount).toBe(CLEANUP_ADMIN_TOOLKIT_FILES.length + 4);
      expect(verified).toMatchObject({
        valid: true,
        errors: [],
        fileCount: CLEANUP_ADMIN_TOOLKIT_FILES.length + 4,
        installationAuthorized: false,
        executionAuthorized: false,
      });
      expect(result.manifestSHA256).toBe(
        hash(readFileSync(join(result.packageDirectory, 'SHA256SUMS'))),
      );
      expect(statSync(result.packageDirectory).mode & 0o777).toBe(0o700);
      const sums = readFileSync(join(result.packageDirectory, 'SHA256SUMS'), 'utf8');
      expect(sums.split('\n').filter(Boolean)).toHaveLength(CLEANUP_ADMIN_TOOLKIT_FILES.length + 3);
      expect(readdirSync(join(result.packageDirectory, 'evidence')).sort()).toEqual([
        'build-a.json',
        'build-b.json',
      ]);
    });
    it('requires the external expected digest and exact candidate; self assertions cannot pass', () => {
      const value = prepare();
      expect(
        verifyCleanupAdminToolkit({
          packageDirectory: value.packageDirectory,
          candidateHead: candidate,
          manifestSHA256: '0'.repeat(64),
        }).errors,
      ).toEqual(['ADMIN_TOOLKIT_DIGEST_MISMATCH']);
      expect(
        verifyCleanupAdminToolkit({
          packageDirectory: value.packageDirectory,
          candidateHead: HEAD,
          manifestSHA256: value.manifestSHA256,
        }).valid,
      ).toBe(false);
    });
    it('does not overwrite an existing or partial output', () => {
      mkdirSync(input.outputDirectory);
      writeFileSync(join(input.outputDirectory, 'keep'), 'existing evidence');
      expect(caught(prepare)).toBe('ADMIN_TOOLKIT_OUTPUT_EXISTS');
      expect(readFileSync(join(input.outputDirectory, 'keep'), 'utf8')).toBe('existing evidence');
      expect(readdirSync(input.outputDirectory)).toEqual(['keep']);
    });
    it('classifies the existing source parent as an existing output, never a fresh install directory', () => {
      const value = { ...input, outputDirectory: dirname(source) };
      expect(caught(() => prepareCleanupAdminToolkit(value))).toBe('ADMIN_TOOLKIT_OUTPUT_EXISTS');
      expect(statSync(source).isDirectory()).toBe(true);
    });
    it('rejects the actual dirty source despite both reports claiming clean', () => {
      const path = join(source, 'unexpected');
      writeFileSync(path, 'untracked');
      try {
        expectRefusal('ADMIN_TOOLKIT_SOURCE_DIRTY');
      } finally {
        unlinkSync(path);
      }
    });
    it('rejects the actual dirty build checkout despite a clean proof boolean', () => {
      const path = join(clones[0], 'unexpected');
      writeFileSync(path, 'untracked');
      try {
        expectRefusal('ADMIN_TOOLKIT_SOURCE_DIRTY');
      } finally {
        unlinkSync(path);
      }
    });
    it('refuses actual candidate mismatch before output creation', () => {
      input = { ...input, candidateHead: HEAD };
      expectRefusal('ADMIN_TOOLKIT_CANDIDATE_MISMATCH');
    });
    it('requires each tool directory to belong to its own report layout', () => {
      input = {
        ...input,
        builds: [
          { ...input.builds[0], toolDirectory: input.builds[1].toolDirectory },
          input.builds[1],
        ],
      };
      expectRefusal('ADMIN_TOOLKIT_BUILD_INVALID');
    });
    it('refuses outputs inside source, either independent checkout, or active install paths', () => {
      for (const root of [
        source,
        ...clones,
        '/etc/openslack-cleanup',
        '/usr/lib/openslack-cleanup',
        '/run/openslack-cleanup',
        '/var/lib/openslack-cleanup',
      ]) {
        const value = { ...input, outputDirectory: join(root, 'should not exist') };
        expect(caught(() => prepareCleanupAdminToolkit(value))).toBe('ADMIN_TOOLKIT_PATH_UNSAFE');
        expect(existsSync(value.outputDirectory)).toBe(false);
      }
    });
    it('requires both reports, all fields, and actual per-build proof', () => {
      updateReport(1, (value) => ({ ...value, independentCloneNoHardlinks: false }));
      expectRefusal('ADMIN_TOOLKIT_BUILD_INVALID');
      updateReport(1, (value) => ({ ...value, artifacts: value.artifacts.slice(1) }));
      expectRefusal('ADMIN_TOOLKIT_BUILD_INVALID');
    });
    it('rejects a zero-byte tool even if a report claims a non-empty digest', () => {
      writeFileSync(join(input.builds[0].toolDirectory, 'verify-toolkit.mjs'), '');
      expectRefusal('ADMIN_TOOLKIT_EMPTY_TOOL');
    });
    it('checks actual two-build byte equality even when each report accurately hashes different bytes', () => {
      appendFileSync(join(input.builds[1].toolDirectory, 'README.md'), 'different');
      updateReport(1);
      expectRefusal('ADMIN_TOOLKIT_BUILD_MISMATCH');
    });
    it('refuses stale or mismatched proof after a tool changes', () => {
      appendFileSync(join(input.builds[0].toolDirectory, 'README.md'), 'changed');
      expectRefusal('ADMIN_TOOLKIT_DIGEST_MISMATCH');
    });
    it('refuses extra files and incomplete tool directories', () => {
      const extra = join(input.builds[0].toolDirectory, 'not-a-shipped-file');
      writeFileSync(extra, 'extra');
      expectRefusal('ADMIN_TOOLKIT_FILE_SET_INVALID');
      unlinkSync(extra);
      unlinkSync(join(input.builds[0].toolDirectory, '_safety.py'));
      expectRefusal('ADMIN_TOOLKIT_FILE_SET_INVALID');
    });
    it('allows ordinary shared-CI readable bytes, but refuses links and hardlinks', () => {
      chmodSync(join(input.builds[0].toolDirectory, 'README.md'), 0o666);
      const result = prepare();
      expect(verify(result).valid).toBe(true);
      const target = join(input.builds[0].toolDirectory, 'target-observation.py');
      const original = readFileSync(target);
      unlinkSync(target);
      symlinkSync(join(input.builds[1].toolDirectory, 'target-observation.py'), target);
      input = { ...input, outputDirectory: join(caseRoot, 'linked-output') };
      expectRefusal('ADMIN_TOOLKIT_FILE_UNSAFE');
      unlinkSync(target);
      writeFileSync(target, original);
      linkSync(target, join(caseRoot, 'hardlink'));
      expectRefusal('ADMIN_TOOLKIT_FILE_UNSAFE');
    });
    it('refuses a replaced parent directory before any outside output', () => {
      const alias = join(caseRoot, 'alias');
      symlinkSync(dirname(caseRoot), alias);
      input = { ...input, outputDirectory: join(alias, 'must not exist') };
      expect(caught(prepare)).toBe('ADMIN_TOOLKIT_FILE_UNSAFE');
      expect(existsSync(join(dirname(caseRoot), 'must not exist'))).toBe(false);
    });
    it('refuses invalid UTF-8 without synthesizing replacement characters', () => {
      writeFileSync(join(input.builds[0].toolDirectory, 'README.md'), Buffer.from([0xff]));
      updateReport(0);
      expectRefusal('ADMIN_TOOLKIT_UTF8_INVALID');
    });
    it('proves the actual object store has no shared hardlinks, not merely a claimed boolean', () => {
      const directory = join(clones[0], '.git/objects/pack');
      const sourceObject = join(directory, readdirSync(directory)[0]!);
      const duplicate = join(clones[1], '.git/objects/fixture-hardlink');
      linkSync(sourceObject, duplicate);
      try {
        expectRefusal('ADMIN_TOOLKIT_BUILD_INVALID');
      } finally {
        unlinkSync(duplicate);
      }
    });
    it('refuses alternates in an otherwise clean independent object store', () => {
      const alternate = join(clones[0], '.git/objects/info/alternates');
      writeFileSync(alternate, join(source, '.git/objects') + '\n');
      try {
        expectRefusal('ADMIN_TOOLKIT_BUILD_INVALID');
      } finally {
        unlinkSync(alternate);
      }
    });
    it.each([1, 2, 7, 20, 40])('closes acquired descriptors when fstat #%i fails', (number) => {
      const before = readdirSync('/proc/self/fd').length;
      faults.active.fstatAt = number;
      faults.active.fstatCalls = 0;
      expectRefusal('ADMIN_TOOLKIT_IO_FAILED');
      expect(readdirSync('/proc/self/fd')).toHaveLength(before);
    });
    it('refuses bytes changed during a descriptor-bound read', () => {
      faults.active.drift = join(input.builds[0].toolDirectory, 'README.md');
      expectRefusal('ADMIN_TOOLKIT_FILE_CHANGED');
    });
    it('completes short writes without truncation and establishes file/directory durability', () => {
      faults.active.maxWrite = 7;
      const result = prepare();
      expect(faults.active.writes).toBeGreaterThan(result.fileCount);
      expect(verify(result).valid).toBe(true);
    });
    it.each(['zero progress', 'file fsync failure'])(
      'does not report success after %s and preserves partial output',
      (kind) => {
        faults.active.zeroWrite = kind === 'zero progress';
        faults.active.fileSync = kind === 'file fsync failure';
        expect(caught(prepare)).toBe('ADMIN_TOOLKIT_IO_FAILED');
        expect(existsSync(input.outputDirectory)).toBe(true);
        Object.assign(faults.active, faults.defaults);
        expect(caught(prepare)).toBe('ADMIN_TOOLKIT_OUTPUT_EXISTS');
      },
    );
    it('verifies exact file sets and refuses extra files after preparation', () => {
      const value = prepare();
      writeFileSync(join(value.packageDirectory, 'extra.json'), '{}');
      expect(verify(value).errors).toEqual(['ADMIN_TOOLKIT_FILE_SET_INVALID']);
    });
    it('refuses extra directories and missing shared dependencies in a published package', () => {
      const value = prepare(),
        extra = join(value.packageDirectory, 'unused directory');
      mkdirSync(extra);
      expect(verify(value).errors).toEqual(['ADMIN_TOOLKIT_FILE_SET_INVALID']);
      rmSync(extra, { recursive: true });
      unlinkSync(join(value.packageDirectory, '_safety.py'));
      expect(verify(value).errors).toEqual(['ADMIN_TOOLKIT_FILE_SET_INVALID']);
    });
    it('independently refuses a zero-byte required tool even after hashes are rebound', () => {
      const value = prepare();
      writeFileSync(join(value.packageDirectory, 'verify-toolkit.mjs'), '');
      const rebound = rebindPackage(value);
      expect(verify(rebound)).toMatchObject({
        valid: false,
        errors: ['ADMIN_TOOLKIT_MANIFEST_INVALID'],
      });
    });
    it('refuses hardlinked and linked published artifacts, not only source artifacts', () => {
      const value = prepare(),
        path = join(value.packageDirectory, 'README.md'),
        copy = join(caseRoot, 'readme-copy');
      linkSync(path, copy);
      expect(verify(value).errors).toEqual(['ADMIN_TOOLKIT_FILE_UNSAFE']);
      unlinkSync(copy);
      const data = readFileSync(path);
      unlinkSync(path);
      writeFileSync(copy, data);
      symlinkSync(copy, path);
      expect(verify(value).errors).toEqual(['ADMIN_TOOLKIT_FILE_UNSAFE']);
    });
    it('refuses a non-regular report before opening, without blocking on a FIFO', () => {
      const path = input.builds[0].reportPath;
      unlinkSync(path);
      execFileSync('mkfifo', [path]);
      expectRefusal('ADMIN_TOOLKIT_FILE_UNSAFE');
    });
    it('refuses tampering even when package paths still match', () => {
      const value = prepare();
      appendFileSync(join(value.packageDirectory, 'README.md'), 'changed');
      expect(verify(value).errors).toEqual(['ADMIN_TOOLKIT_DIGEST_MISMATCH']);
    });
    it('verifies both report proofs against actual bytes, not only manifest digests', () => {
      const value = prepare(),
        path = join(value.packageDirectory, 'evidence/build-b.json');
      const changed = JSON.parse(readFileSync(path, 'utf8')) as CleanupAdminToolkitBuildReport;
      writeFileSync(
        path,
        raw({
          ...changed,
          artifacts: changed.artifacts.map((file, i) =>
            i ? file : { ...file, sha256: '0'.repeat(64) },
          ),
        }),
      );
      const rebound = rebindPackage(value);
      expect(verify(rebound).errors).toEqual(['ADMIN_TOOLKIT_DIGEST_MISMATCH']);
    });
    it('refuses same-checkout build proofs during standalone verification', () => {
      const value = prepare(),
        path = join(value.packageDirectory, 'evidence/build-b.json');
      const changed = JSON.parse(readFileSync(path, 'utf8')) as CleanupAdminToolkitBuildReport;
      writeFileSync(path, raw({ ...changed, checkout: clones[0] }));
      expect(verify(rebindPackage(value)).errors).toEqual(['ADMIN_TOOLKIT_BUILD_INVALID']);
    });
    it('reads preparation recipes strictly from descriptors', () => {
      const path = join(caseRoot, 'recipe.json');
      writeFileSync(path, raw(input));
      expect(readCleanupAdminToolkitPreparationInput(path)).toEqual(input);
      writeFileSync(path, '{"sourceRoot":"one","sourceRoot":"two"}');
      expect(caught(() => readCleanupAdminToolkitPreparationInput(path))).toBe(
        'ADMIN_TOOLKIT_INPUT_INVALID',
      );
    });
    it('rejects unknown recipe keys and arbitrary per-file fill paths before output', () => {
      expect(
        caught(() =>
          prepareCleanupAdminToolkit({
            ...input,
            verifierPath: '/arbitrary/verify-toolkit.mjs',
          } as PrepareCleanupAdminToolkitInput),
        ),
      ).toBe('ADMIN_TOOLKIT_INPUT_INVALID');
      expect(existsSync(input.outputDirectory)).toBe(false);
    });
    it('runs the bundled verifier under real Node without a development checkout or Git on PATH', () => {
      const value = prepare(),
        executable = join(value.packageDirectory, 'verify-toolkit.mjs');
      const result = spawnSync(
        process.execPath,
        [
          executable,
          '--package',
          value.packageDirectory,
          '--candidate',
          candidate,
          '--manifest-sha256',
          value.manifestSHA256,
        ],
        {
          cwd: value.packageDirectory,
          encoding: 'utf8',
          env: { PATH: '/does-not-have-git' },
          timeout: 10_000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        valid: true,
        installationAuthorized: false,
        executionAuthorized: false,
      });
      appendFileSync(join(value.packageDirectory, 'README.md'), 'tampered');
      const refusal = spawnSync(
        process.execPath,
        [
          executable,
          '--package',
          value.packageDirectory,
          '--candidate',
          candidate,
          '--manifest-sha256',
          value.manifestSHA256,
        ],
        {
          cwd: value.packageDirectory,
          encoding: 'utf8',
          env: { PATH: '/does-not-have-git' },
          timeout: 10_000,
        },
      );
      expect(refusal.status).toBe(2);
      expect(JSON.parse(refusal.stdout).valid).toBe(false);
    });
    it('standalone verifier refuses unknown/duplicate options and caller-selected time', () => {
      const value = prepare(),
        executable = join(value.packageDirectory, 'verify-toolkit.mjs');
      for (const additional of [
        ['--now', '2099-01-01'],
        ['--package', value.packageDirectory],
      ]) {
        const child = spawnSync(
          process.execPath,
          [
            executable,
            '--package',
            value.packageDirectory,
            '--candidate',
            candidate,
            '--manifest-sha256',
            value.manifestSHA256,
            ...additional,
          ],
          { encoding: 'utf8', env: { PATH: '/no-git' }, timeout: 10_000 },
        );
        expect(child.status).toBe(2);
        expect(child.stderr).toContain('ADMIN_TOOLKIT_INPUT_INVALID');
      }
    });
    it('bundled preparation writes only a new sibling toolkit and rejects invalid input without output', () => {
      const path = join(caseRoot, 'recipe.json');
      writeFileSync(path, raw(input));
      const child = spawnSync(process.execPath, [preparer, '--input', path], {
        encoding: 'utf8',
        timeout: 10_000,
        env: { PATH: process.env.PATH },
      });
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toMatchObject({
        installationAuthorized: false,
        executionAuthorized: false,
      });
      const rejected = spawnSync(process.execPath, [preparer, '--input', path, '--now', '2099'], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(rejected.status).toBe(2);
      expect(rejected.stderr).toContain('ADMIN_TOOLKIT_INPUT_INVALID');
    });
  });
}

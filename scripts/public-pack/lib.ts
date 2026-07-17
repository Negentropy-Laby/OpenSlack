import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { relative, resolve, sep } from 'node:path';

export const PUBLIC_VERSION = '0.2.0';
export const PUBLIC_PACKAGES = Object.freeze([
  { name: '@openslack/plugin-api', directory: 'packages/plugin-api' },
  { name: '@openslack/plugin-host', directory: 'packages/plugin-host' },
  { name: '@openslack/sdk', directory: 'packages/sdk' },
  { name: '@openslack/plugin-testkit', directory: 'packages/plugin-testkit' },
] as const);

const PUBLIC_PACKAGE_NAMES = new Set<string>(PUBLIC_PACKAGES.map((item) => item.name));
const DEPENDENCY_FIELDS = Object.freeze([
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
] as const);
const RUNTIME_DEPENDENCY_FIELDS = Object.freeze([
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
] as const);
const LIFECYCLE_SCRIPTS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepack',
  'postpack',
  'prepublish',
  'prepublishOnly',
  'publish',
  'postpublish',
]);
const NATIVE_FILE = /\.(?:node|dll|dylib|so)$/iu;

export interface CanonicalFileEntry {
  readonly path: string;
  readonly mode: '0644' | '0755';
  readonly size: number;
  readonly sha256: string;
}

export interface PublicPackArtifact {
  readonly name: string;
  readonly version: string;
  readonly tarball: string;
  readonly tarballSha256: string;
  readonly manifestSha256: string;
  readonly files: readonly CanonicalFileEntry[];
}

export function readJson(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function dependencyRecord(
  manifest: Record<string, unknown>,
  field: (typeof DEPENDENCY_FIELDS)[number],
): Record<string, string> {
  const value = manifest[field];
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${String(manifest.name)} has a non-object ${field}.`);
  }
  const result: Record<string, string> = {};
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== 'string' || !version.trim()) {
      throw new Error(`${String(manifest.name)} has an invalid ${field} entry for ${name}.`);
    }
    result[name] = version;
  }
  return result;
}

export function validatePublicManifest(
  manifest: Record<string, unknown>,
  expected: { readonly name: string; readonly directory: string },
): void {
  if (manifest.name !== expected.name) {
    throw new Error(`Public package name mismatch for ${expected.directory}.`);
  }
  if (manifest.version !== PUBLIC_VERSION) {
    throw new Error(`${expected.name} must use version ${PUBLIC_VERSION}.`);
  }
  if (manifest.private === true) {
    throw new Error(`${expected.name} remains private.`);
  }
  if (manifest.type !== 'module') {
    throw new Error(`${expected.name} must be ESM.`);
  }
  if (manifest.license !== 'Apache-2.0') {
    throw new Error(`${expected.name} must declare Apache-2.0.`);
  }
  const engines = manifest.engines as Record<string, unknown> | undefined;
  if (engines?.node !== '>=22.0.0') {
    throw new Error(`${expected.name} must require Node >=22.0.0.`);
  }
  const publishConfig = manifest.publishConfig as Record<string, unknown> | undefined;
  if (publishConfig?.access !== 'public') {
    throw new Error(`${expected.name} must publish with public access.`);
  }
  if (!manifest.exports || !manifest.types || !Array.isArray(manifest.files)) {
    throw new Error(`${expected.name} must define exports, types, and files.`);
  }
  const files = manifest.files;
  for (const required of ['dist', 'README.md', 'LICENSE', 'NOTICE']) {
    if (!files.includes(required)) {
      throw new Error(`${expected.name} files is missing ${required}.`);
    }
  }

  const scripts = manifest.scripts as Record<string, unknown> | undefined;
  for (const script of Object.keys(scripts ?? {})) {
    if (LIFECYCLE_SCRIPTS.has(script)) {
      throw new Error(`${expected.name} declares forbidden lifecycle script ${script}.`);
    }
  }

  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, version] of Object.entries(dependencyRecord(manifest, field))) {
      if (/react|node-gyp|napi|prebuild/iu.test(name)) {
        throw new Error(`${expected.name} has forbidden ${field} dependency ${name}.`);
      }
      if (version.startsWith('workspace:') && version !== 'workspace:*') {
        throw new Error(`${expected.name} has unsupported workspace range ${version}.`);
      }
    }
  }

  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    for (const name of Object.keys(dependencyRecord(manifest, field))) {
      if (!PUBLIC_PACKAGE_NAMES.has(name)) {
        throw new Error(`${expected.name} has unexpected runtime dependency ${name}.`);
      }
    }
  }
}

export function stageManifest(
  manifest: Record<string, unknown>,
): Record<string, unknown> {
  const staged = structuredClone(manifest);
  delete staged.private;
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = dependencyRecord(staged, field);
    if (Object.keys(dependencies).length === 0) continue;
    for (const [name, version] of Object.entries(dependencies)) {
      if (version === 'workspace:*') dependencies[name] = PUBLIC_VERSION;
      if (dependencies[name]?.startsWith('workspace:')) {
        throw new Error(`${String(staged.name)} retained workspace protocol for ${name}.`);
      }
    }
    staged[field] = dependencies;
  }
  return staged;
}

function normalizedRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function assertContained(root: string, path: string): void {
  const relation = relative(root, path);
  if (relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..')) return;
  throw new Error(`Path escapes public package staging root: ${path}`);
}

export function copyPackagePayload(source: string, destination: string): void {
  const sourceRoot = resolve(source);
  const destinationRoot = resolve(destination);
  mkdirSync(destinationRoot, { recursive: true });
  copyTree(resolve(sourceRoot, 'dist'), resolve(destinationRoot, 'dist'), sourceRoot);
  copyRegularFile(resolve(sourceRoot, 'README.md'), resolve(destinationRoot, 'README.md'), sourceRoot);
}

function copyTree(source: string, destination: string, sourceRoot: string): void {
  assertContained(sourceRoot, source);
  const info = lstatSync(source);
  if (info.isSymbolicLink()) throw new Error(`Symlink is forbidden in public payload: ${source}`);
  if (!info.isDirectory()) throw new Error(`Expected public payload directory: ${source}`);
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === '__fixtures__') continue;
    const childSource = resolve(source, entry.name);
    const childDestination = resolve(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Symlink is forbidden in public payload: ${childSource}`);
    }
    if (entry.isDirectory()) {
      copyTree(childSource, childDestination, sourceRoot);
    } else if (entry.isFile()) {
      copyRegularFile(childSource, childDestination, sourceRoot);
    } else {
      throw new Error(`Non-regular public payload entry: ${childSource}`);
    }
  }
}

function copyRegularFile(source: string, destination: string, sourceRoot: string): void {
  assertContained(sourceRoot, source);
  const info = lstatSync(source);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Expected regular public payload file: ${source}`);
  }
  if (NATIVE_FILE.test(source)) throw new Error(`Native artifact is forbidden: ${source}`);
  mkdirSync(resolve(destination, '..'), { recursive: true });
  copyFileSync(source, destination);
  chmodSync(destination, info.mode & 0o111 ? 0o755 : 0o644);
}

export function canonicalDirectoryManifest(root: string): readonly CanonicalFileEntry[] {
  const absoluteRoot = resolve(root);
  const entries: CanonicalFileEntry[] = [];
  walk(absoluteRoot);
  return Object.freeze(entries.sort((left, right) => left.path.localeCompare(right.path, 'en')));

  function walk(directory: string): void {
    const info = lstatSync(directory);
    if (info.isSymbolicLink()) throw new Error(`Symlink is forbidden: ${directory}`);
    if (!info.isDirectory()) throw new Error(`Expected directory while walking ${directory}.`);
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, child.name);
      const childInfo = lstatSync(path);
      if (childInfo.isSymbolicLink()) throw new Error(`Symlink is forbidden: ${path}`);
      if (childInfo.isDirectory()) {
        walk(path);
        continue;
      }
      if (!childInfo.isFile()) throw new Error(`Non-regular package entry: ${path}`);
      const itemPath = normalizedRelative(absoluteRoot, path);
      if (NATIVE_FILE.test(itemPath)) throw new Error(`Native artifact is forbidden: ${itemPath}`);
      entries.push({
        path: itemPath,
        mode: childInfo.mode & 0o111 ? '0755' : '0644',
        size: childInfo.size,
        sha256: sha256File(path),
      });
    }
  }
}

export function assertExpectedTarballFiles(files: readonly CanonicalFileEntry[]): void {
  const required = new Set(['LICENSE', 'NOTICE', 'README.md', 'package.json']);
  let distFiles = 0;
  for (const file of files) {
    if (required.delete(file.path)) continue;
    if (file.path.startsWith('dist/') && !file.path.includes('/__tests__/')) {
      if (file.path.includes('/__fixtures__/') || NATIVE_FILE.test(file.path)) {
        throw new Error(`Forbidden public tarball file: ${file.path}`);
      }
      distFiles += 1;
      continue;
    }
    throw new Error(`Unexpected public tarball file: ${file.path}`);
  }
  if (required.size > 0) {
    throw new Error(`Public tarball is missing: ${[...required].sort().join(', ')}`);
  }
  if (distFiles === 0) throw new Error('Public tarball contains no compiled files.');
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(`${JSON.stringify(value)}\n`).digest('hex');
}

export function resetDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function assertFile(path: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Required file is missing: ${path}`);
  }
}

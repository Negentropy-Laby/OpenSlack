import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { canonicalHarnessRoot, readHarnessFile } from './harness-read.js';
import { HarnessRuntimePackageClosure, readRuntimeWorkspacePackage, type RuntimeWorkspacePackage } from './harness-runtime-closure.js';

/** Exact external entry set; the qualification model is compiled outside the published package payload. */
export const HARNESS_PLUGIN_ENTRIES = ['index', 'initiator', 'readonly', 'sdk-host', 'startup', 'runtime', 'owned-sdk'] as const;
export const HARNESS_NATIVE_SUPERVISOR_FILE = 'dist/openslack-harness-supervisor.exe';

declare const artifactObservationBrand: unique symbol;
/** Phase-local byte proof. The nominal binding expires at the next microtask. */
export interface HarnessArtifactObservation { readonly [artifactObservationBrand]: never }
interface ArtifactObservationData {
  pluginRoot: string; nodeExecutable: string; pluginHash: string; nodeHash: string;
  files: ReadonlyArray<{ path: string; witness: string }>;
  paths: readonly string[];
}
const artifactObservations = new WeakMap<object, ArtifactObservationData>();

function artifactWitness(path: string): string {
  const rows: string[] = [];
  const entry = lstatSync(path, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Harness artifact is not a regular file');
  rows.push([entry.dev, entry.ino, entry.mode, entry.nlink, entry.size, entry.mtimeNs, entry.ctimeNs].join(':'));
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const stamp = lstatSync(parent, { bigint: true });
    if (!stamp.isDirectory() || stamp.isSymbolicLink()) throw new Error('Harness artifact traverses a directory link');
    rows.push(`${parent}:${stamp.dev}:${stamp.ino}:${stamp.mode}`);
    if (parent === dirname(parent)) break;
  }
  return JSON.stringify(rows);
}

function pluginPaths(root: string): string[] {
  return [join(root, 'package.json'), join(root, 'plugin.patch.yml'), join(root, 'THIRD-PARTY-NOTICES.txt'),
    join(root, HARNESS_NATIVE_SUPERVISOR_FILE), ...harnessPluginMountFiles(root)].sort();
}

/** Domain-separated framed file identity; shared by direct hashes and phase observations. */
function pluginDigest(root: string, paths: readonly string[], read: (path: string, maximum: number) => Buffer): string {
  const digest = createHash('sha256').update('openslack.harness_plugin_artifacts.v2\0');
  for (const path of paths) {
    const key = Buffer.from(relative(root, path).replaceAll('\\', '/'));
    const bytes = read(path, 64 * 1024 * 1024), lengths = Buffer.alloc(16);
    lengths.writeBigUInt64BE(BigInt(key.length), 0); lengths.writeBigUInt64BE(BigInt(bytes.length), 8);
    if (path === join(root, 'package.json')) {
      const manifest = JSON.parse(bytes.toString('utf8')) as { name?: string };
      if (manifest.name !== '@openslack/deepseek-harness-plugin') throw new Error('Unexpected external Harness plugin');
    }
    digest.update(lengths).update(key).update(bytes);
  }
  return digest.digest('hex');
}

/** Hash expensive plugin/Node bytes once within one synchronous authorization phase. */
export function captureHarnessArtifactObservation(pluginRoot: string, nodeExecutable: string): HarnessArtifactObservation {
  pluginRoot = canonicalHarnessRoot(pluginRoot);
  nodeExecutable = join(canonicalHarnessRoot(dirname(nodeExecutable)), basename(nodeExecutable));
  const paths = pluginPaths(pluginRoot);
  const files: Array<{ path: string; witness: string }> = [];
  const read = (path: string, maxBytes: number): Buffer => {
    const before = artifactWitness(path);
    const bytes = artifactBytes(path, maxBytes);
    if (artifactWitness(path) !== before) throw new Error('Harness artifact changed during phase observation');
    files.push({ path, witness: before });
    return bytes;
  };
  const pluginHash = pluginDigest(pluginRoot, paths, read);
  const nodeHash = createHash('sha256').update(read(nodeExecutable, 256 * 1024 * 1024)).digest('hex');
  const proof = Object.freeze({}) as HarnessArtifactObservation;
  artifactObservations.set(proof, { pluginRoot, nodeExecutable, pluginHash, nodeHash, files, paths });
  queueMicrotask(() => { artifactObservations.delete(proof); });
  return proof;
}

/** Reject forged, cross-root, changed and cross-await proofs without rereading large bodies. */
export function inspectHarnessArtifactObservation(proof: HarnessArtifactObservation, pluginRoot: string,
  nodeExecutable: string): Readonly<{ pluginHash: string; nodeHash: string }> {
  const data = proof && typeof proof === 'object' ? artifactObservations.get(proof) : undefined;
  const actualPlugin = canonicalHarnessRoot(pluginRoot);
  const actualNode = join(canonicalHarnessRoot(dirname(nodeExecutable)), basename(nodeExecutable));
  if (!data || data.pluginRoot !== actualPlugin || data.nodeExecutable !== actualNode ||
    JSON.stringify(pluginPaths(actualPlugin)) !== JSON.stringify(data.paths) ||
    data.files.some(file => artifactWitness(file.path) !== file.witness)) throw new Error('Harness artifact phase observation expired or changed');
  return Object.freeze({ pluginHash: data.pluginHash, nodeHash: data.nodeHash });
}

function artifactBytes(path: string, maxBytes = 64 * 1024 * 1024): Buffer {
  return readHarnessFile(path, maxBytes, { trustedArtifact: true });
}

export function harnessPluginMountFiles(root: string): string[] {
  root = canonicalHarnessRoot(root);
  const files = HARNESS_PLUGIN_ENTRIES.map(name => join(root, 'dist', `${name}.js`));
  const fixture = join(root, '.build/fixtures/scripted-model.js');
  if (existsSync(fixture)) files.push(fixture);
  return files;
}

export function hashHarnessPluginArtifacts(root: string): string {
  root = canonicalHarnessRoot(root);
  return pluginDigest(root, pluginPaths(root), artifactBytes);
}

export function hashHarnessNodeExecutable(path: string): string {
  return createHash('sha256').update(artifactBytes(path, 256 * 1024 * 1024)).digest('hex');
}

/** Bind the real split tsc callback modules, not merely the CLI's small entry file. No local state or secrets are traversed. */
export function hashOpenSlackHarnessCallback(cliModule: string): string {
  const lexicalRoot = resolve(dirname(cliModule), '../../..');
  if (relative(lexicalRoot, cliModule).replaceAll('\\', '/') !== 'apps/cli/dist/index.js') {
    throw new Error('Harness callbacks require the matching built OpenSlack workspace CLI');
  }
  const root = canonicalHarnessRoot(lexicalRoot);
  const packages = new Map<string, RuntimeWorkspacePackage>();
  const add = (path: string) => {
    const pkg = readRuntimeWorkspacePackage(path, 'dist', true);
    const name = pkg.manifest.name as string;
    if (packages.has(name)) throw new Error('Duplicate callback workspace package identity');
    packages.set(name, pkg);
  };
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(root, 'packages', entry.name, 'package.json'))) add(join(root, 'packages', entry.name));
  }
  add(join(root, 'apps/cli')); add(join(root, 'apps/mcp'));
  const closure = new HarnessRuntimePackageClosure(root, packages);
  closure.visitWorkspace('@openslack/cli');
  closure.visitWorkspace('@openslack/mcp');
  closure.addFile(join(root, 'bun.lock'), 16 * 1024 * 1024);
  return closure.finish().hash;
}

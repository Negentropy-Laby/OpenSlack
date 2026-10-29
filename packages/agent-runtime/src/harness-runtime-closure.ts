/** One bounded byte observation of the installed runtime, not a package installer or global cache. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { digestStableDescriptor } from '@openslack/core';
import { canonicalHarnessRoot, readHarnessFile, withHarnessDescriptor } from './harness-read.js';

// The approved installation contains a 127,844,128-byte WASM asset. Bound it
// without buffering it, while retaining an independent finite total budget.
const MAX_PACKAGES = 1024, MAX_FILES = 32768, MAX_BYTES = 512 * 1024 * 1024, MAX_FILE_BYTES = 256 * 1024 * 1024;
type Manifest = Record<string, unknown>;
export interface RuntimeWorkspacePackage {
  path: string; manifest: Manifest; bytes: Buffer; witness: string; output: 'lib' | 'dist' | 'application'; requireOutput: boolean;
}
function stamp(path: string): string {
  const value = lstatSync(path, { bigint: true });
  return [value.dev, value.ino, value.mode, value.nlink, value.size, value.mtimeNs, value.ctimeNs].join(':');
}
function absent(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
function dependencyName(name: string): void {
  if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name)) throw new Error('Unsupported runtime dependency name');
}
const LOCAL_CONFIGURATION = /^(?:\.git|\.openslack(?:\.local)?|\.env.*|\.npmrc|\.yarnrc(?:\.yml)?|\.netrc|\.git-credentials|\.ssh|\.gnupg)$/i;
const CREDENTIAL_NAME = /^(?:credentials|secrets)$/i;
const PROTECTED_SUFFIX = /\.(?:pem|key)$/i;
const CODE_FILE = /\.(?:[cm]?[jt]s|[cm]?[jt]s\.map)$/i;
function portableName(name: string): void {
  if (name.includes('\\') || name.includes('/') || /[\x00-\x1f]/.test(name)) throw new Error('Runtime artifact name is not portable or unambiguous');
}
function protectedName(name: string): void {
  portableName(name);
  if (LOCAL_CONFIGURATION.test(name) || PROTECTED_SUFFIX.test(name)) throw new Error('Installed runtime package contains unsupported local configuration or credential entries');
}

/** A published credentials module is code, not credential data. Prove its complete
 * bounded shape through metadata before reading any member; no package-name exemption. */
function credentialCodeDirectory(path: string): void {
  let count = 0, modules = 0;
  const witnessed = new Map<string, string>();
  const walk = (directory: string): void => {
    const entry = lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Credential runtime code directory must not be linked');
    const before = stamp(directory); witnessed.set(directory, before);
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      protectedName(child.name);
      if (++count > MAX_FILES || child.isSymbolicLink() || LOCAL_CONFIGURATION.test(child.name) || child.name === 'node_modules') {
        throw new Error('Installed runtime package contains unsupported local configuration or credential entries');
      }
      if (child.isDirectory()) walk(join(directory, child.name));
      else if (!child.isFile() || !CODE_FILE.test(child.name)) throw new Error('Installed runtime package contains unsupported local configuration or credential entries');
      else modules++;
    }
  };
  walk(path);
  if (!modules || [...witnessed].some(([file, before]) => stamp(file) !== before)) throw new Error('Credential runtime code metadata changed or is ambiguous');
}

/** Discovery reads each workspace manifest once; use its exact bytes only while the descriptor witness is unchanged. */
export function readRuntimeWorkspacePackage(path: string, output: RuntimeWorkspacePackage['output'], requireOutput = false): RuntimeWorkspacePackage {
  const file = join(path, 'package.json'), witness = stamp(file);
  const bytes = readHarnessFile(file, 512 * 1024, { trustedArtifact: true });
  const manifest: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !('name' in manifest) ||
    typeof manifest.name !== 'string' || stamp(file) !== witness) throw new Error('Runtime workspace package identity changed');
  dependencyName(manifest.name);
  return { path, manifest: manifest as Manifest, bytes, witness, output, requireOutput };
}

/** The pinned workspace declares apps/* separately from library packages.
 * Resolve a visited application's one published compiled root, not its source,
 * tests or debug build output. Unknown/mixed contracts do not get a fallback. */
function applicationOutput(manifest: Manifest): 'lib' | 'dist' {
  const roots = new Set<'lib' | 'dist'>();
  const target = (value: unknown): void => {
    if (typeof value !== 'string') throw new Error('Unsupported application compiled artifact contract');
    if (value === './package.json' || value === 'package.json') return;
    if (isAbsolute(value) || value.includes('\\') || value.split('/').includes('..')) throw new Error('Unsupported application compiled artifact contract');
    const root = /^(?:\.\/)?(lib|dist)\//.exec(value)?.[1];
    if (root !== 'lib' && root !== 'dist') throw new Error('Unsupported application compiled artifact contract');
    roots.add(root);
  };
  const exports = (value: unknown): void => {
    if (typeof value === 'string') target(value);
    else if (Array.isArray(value)) { for (const row of value) exports(row); }
    else if (value && typeof value === 'object') { for (const [key, row] of Object.entries(value)) if (key !== 'types') exports(row); }
    else if (value !== null && value !== undefined) throw new Error('Unsupported application compiled artifact contract');
  };
  if (manifest.main !== undefined) target(manifest.main);
  if (typeof manifest.bin === 'string') target(manifest.bin);
  else if (manifest.bin !== undefined) {
    if (!manifest.bin || typeof manifest.bin !== 'object' || Array.isArray(manifest.bin)) throw new Error('Unsupported application compiled artifact contract');
    for (const value of Object.values(manifest.bin)) target(value);
  }
  exports(manifest.exports);
  if (roots.size !== 1) throw new Error('Unsupported application compiled artifact contract');
  const output = [...roots][0]!;
  // The original frontend's publication contract explicitly omits source maps;
  // do not turn that one supported contract into a global third-party filter.
  if (output === 'dist' && (!Array.isArray(manifest.files) || !manifest.files.includes('dist') || !manifest.files.includes('!dist/**/*.map'))) {
    throw new Error('Unsupported application compiled artifact contract');
  }
  return output;
}

export class HarnessRuntimePackageClosure {
  readonly root: string;
  private readonly digest = createHash('sha256');
  private readonly visited = new Map<string, Manifest>();
  private readonly workspaceByPath = new Map<string, RuntimeWorkspacePackage>();
  private readonly files = new Map<string, string>();
  private readonly directories = new Map<string, string>();
  private readonly resolutions = new Map<string, { path: string; witness: string }>();
  private readonly missing = new Set<string>();
  private totalBytes = 0;

  constructor(root: string, private readonly workspace: ReadonlyMap<string, RuntimeWorkspacePackage>) {
    this.root = canonicalHarnessRoot(root);
    for (const pkg of workspace.values()) this.workspaceByPath.set(resolve(pkg.path), pkg);
    this.frame('format', Buffer.from('openslack.installed_runtime_closure.v2'));
  }

  private local(path: string): string {
    const raw = relative(this.root, path);
    if (process.platform !== 'win32' && raw.includes('\\')) throw new Error('Runtime artifact name is not portable or unambiguous');
    const local = raw.replaceAll('\\', '/');
    if (!local || isAbsolute(local) || local.split('/').includes('..')) throw new Error('Runtime dependency escapes its approved installation root');
    return local;
  }
  private frame(name: string, bytes: Buffer): void {
    const key = Buffer.from(name), lengths = Buffer.alloc(16);
    lengths.writeBigUInt64BE(BigInt(key.length), 0); lengths.writeBigUInt64BE(BigInt(bytes.length), 8);
    this.digest.update(lengths).update(key).update(bytes);
  }

  addFile(path: string, maxBytes = MAX_FILE_BYTES, supplied?: { bytes: Buffer; witness: string }): void {
    path = resolve(path);
    protectedName(basename(path));
    if (CREDENTIAL_NAME.test(basename(path))) throw new Error('Installed runtime package contains unsupported local configuration or credential entries');
    const local = this.local(path);
    if (this.files.has(path)) return;
    const entry = lstatSync(path), before = stamp(path);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Runtime artifact must not be linked or special');
    if (this.files.size >= MAX_FILES || entry.size > maxBytes || this.totalBytes + entry.size > MAX_BYTES) {
      throw new Error(`Installed runtime closure exceeds its file or byte capacity: ${local}; packages=${this.visited.size}, files=${this.files.size}, bytes=${this.totalBytes}, nextBytes=${entry.size}`);
    }
    const observed = supplied ? { bytes: supplied.bytes.length, sha256: createHash('sha256').update(supplied.bytes).digest('hex') }
      : withHarnessDescriptor(path, maxBytes, { trustedArtifact: true }, descriptor => digestStableDescriptor(descriptor, maxBytes));
    if ((supplied && supplied.witness !== before) || observed.bytes !== entry.size || stamp(path) !== before) throw new Error('Runtime artifact changed during observation');
    this.totalBytes += observed.bytes;
    this.files.set(path, before);
    // Fixed field order, framed path and length; the descriptor digest binds
    // every original byte, including large WASM/data and nested split chunks.
    this.frame(`file:${local}`, Buffer.from(JSON.stringify({ bytes: observed.bytes, sha256: observed.sha256 })));
  }

  addDirectory(path: string, workspaceOutput = false, codeOnly = false): void {
    path = resolve(path); this.local(path);
    const entry = lstatSync(path), before = stamp(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Runtime artifact directory must not be linked');
    if (this.directories.has(path)) return;
    if (this.directories.size >= MAX_FILES) throw new Error('Installed runtime closure exceeds its directory capacity');
    this.directories.set(path, before);
    const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (entries.length > MAX_FILES) throw new Error('Installed runtime closure exceeds its directory-entry capacity');
    for (const child of entries) {
      protectedName(child.name);
      // Installed dependency edges are resolved below. Never follow an arbitrary
      // node_modules directory recursively, nor inspect local configuration.
      if (child.name === 'node_modules') continue;
      if (LOCAL_CONFIGURATION.test(child.name)) {
        throw new Error(`Installed runtime package contains unsupported local configuration or credential entries: ${this.local(join(path, child.name))}`);
      }
      if (child.isSymbolicLink()) throw new Error('Runtime artifact content must not be linked');
      const file = join(path, child.name);
      if (CREDENTIAL_NAME.test(child.name)) {
        if (!child.isDirectory()) throw new Error('Installed runtime package contains unsupported local configuration or credential entries');
        credentialCodeDirectory(file);
        this.addDirectory(file, workspaceOutput, true);
      } else if (child.isDirectory()) this.addDirectory(file, workspaceOutput, codeOnly);
      else if (child.isFile()) {
        if (codeOnly && !CODE_FILE.test(child.name)) throw new Error('Installed runtime package contains unsupported local configuration or credential entries');
        if (workspaceOutput && /(?:\.d\.[cm]?ts|\.map)$/.test(child.name)) continue;
        this.addFile(file);
      } else throw new Error('Runtime artifact contains an unsupported special entry');
    }
    if (stamp(path) !== before) throw new Error('Runtime artifact directory changed during observation');
  }

  visitWorkspace(name: string): void {
    const pkg = this.workspace.get(name);
    if (!pkg) throw new Error('Required runtime workspace package is unavailable');
    this.visit(resolve(pkg.path));
  }

  /** Public Node lookup paths, but no fallback to installations outside this approved code root. */
  dependency(from: string, name: string, mode: 'required' | 'optional' | 'peer' = 'required', declared?: string): string | undefined {
    dependencyName(name);
    // A declared package may share a Node builtin's name (e.g. buffer). A
    // package subpath obtains Node's public package lookup list in that case.
    const paths = createRequire(join(from, 'package.json')).resolve.paths(`${name}/package.json`);
    let selected: string | undefined;
    for (const directory of paths ?? []) {
      const candidate = join(directory, name);
      // Bare CJS requests also accept file-shaped installs. This integration
      // binds packages with manifests; refuse real file fallbacks explicitly.
      for (const suffix of ['.js', '.json', '.node']) {
        const file = candidate + suffix;
        try { lstatSync(file); }
        catch (error) { if (absent(error)) { this.missing.add(file); continue; } throw error; }
        throw new Error('Unsupported file-shaped runtime dependency resolution');
      }
      let inside = true;
      try { this.local(candidate); } catch { inside = false; }
      let witness: string;
      try { witness = stamp(candidate); }
      catch (error) { if (absent(error)) { this.missing.add(candidate); continue; } throw error; }
      // Inspect only metadata at a real outside candidate. Its mere availability
      // matters to Node resolution; never read its package body or adopt a root.
      if (!inside) throw new Error('Installed runtime dependency would resolve outside its approved root');
      selected = realpathSync(candidate);
      this.local(selected);
      const expected = this.workspace.get(name);
      if (expected && selected !== resolve(expected.path)) throw new Error('Runtime workspace dependency resolves outside approved root');
      this.resolutions.set(candidate, { path: selected, witness });
      break;
    }
    this.frame(`edge:${this.local(from)}:${name}:${mode}`, Buffer.from(selected ? this.local(selected) : 'absent'));
    if (!selected) {
      if (mode === 'required') throw new Error('Required installed runtime dependency is unavailable inside its approved root');
      return undefined;
    }
    this.visit(selected);
    const actual = this.visited.get(selected)?.name;
    const alias = declared?.startsWith('npm:') ? /^npm:((?:@[^/]+\/)?[^@]+)@/.exec(declared)?.[1] : undefined;
    if (actual !== (alias ?? name)) throw new Error('Installed runtime dependency manifest does not match its declared identity');
    return selected;
  }

  private visit(path: string): void {
    if (this.visited.has(path)) return;
    if (this.visited.size >= MAX_PACKAGES) throw new Error('Installed runtime closure exceeds its package capacity');
    this.local(path);
    const pkg = this.workspaceByPath.get(path);
    const manifestPath = join(path, 'package.json');
    let manifest: Manifest;
    if (pkg) {
      this.addFile(manifestPath, 512 * 1024, pkg);
      manifest = pkg.manifest;
    } else {
      const witness = stamp(manifestPath), bytes = readHarnessFile(manifestPath, 512 * 1024, { trustedArtifact: true });
      this.addFile(manifestPath, 512 * 1024, { witness, bytes });
      manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Manifest;
    }
    if (typeof manifest.name !== 'string') throw new Error('Installed runtime package manifest has no identity');
    const containedTarget = (value: string): void => {
      const local = relative(path, resolve(path, value));
      if (isAbsolute(value) || isAbsolute(local) || local.split(/[\\/]/).includes('..') || value.includes('\\')) {
        throw new Error('Installed runtime package entry escapes its package root');
      }
      if (value.split(/[\\/]/).includes('node_modules')) throw new Error('Runtime package entry bypasses its declared dependency closure');
    };
    if (typeof manifest.main === 'string') containedTarget(manifest.main);
    const exports = (value: unknown): void => {
      if (typeof value === 'string') { if (!value.startsWith('./')) throw new Error('Unsupported runtime package export target'); containedTarget(value); }
      else if (Array.isArray(value)) for (const row of value) exports(row);
      else if (value && typeof value === 'object') for (const [key, row] of Object.entries(value)) if (key !== 'types') exports(row);
    };
    exports(manifest.exports);
    this.visited.set(path, manifest);
    if (pkg) {
      const directory = join(path, pkg.output === 'application' ? applicationOutput(manifest) : pkg.output);
      try { this.addDirectory(directory, true); }
      catch (error) { if (!absent(error) || pkg.requireOutput) throw error; }
      const dsh = manifest.dsh;
      if (dsh && typeof dsh === 'object' && 'bundle' in dsh && dsh.bundle && typeof dsh.bundle === 'object' && 'patch' in dsh.bundle) {
        const patch = dsh.bundle.patch;
        for (const file of Array.isArray(patch) ? patch : [patch]) {
          if (typeof file !== 'string' || isAbsolute(file) || file.includes('\\') || file.split('/').includes('..') || !/\.(?:yaml|yml|json)$/.test(file)) {
            throw new Error('Unsupported Harness bundle patch declaration');
          }
          this.addFile(resolve(path, file), 1024 * 1024);
        }
      }
    } else this.addDirectory(path);
    const edges = new Map<string, { mode: 'required' | 'optional' | 'peer'; declared: string }>();
    for (const [field, mode] of [['peerDependencies', 'peer'], ['dependencies', 'required'], ['optionalDependencies', 'optional']] as const) {
      const values = manifest[field];
      if (values === undefined) continue;
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Unsupported installed runtime dependency declaration');
      for (const [name, declared] of Object.entries(values)) {
        if (typeof declared !== 'string') throw new Error('Unsupported installed runtime dependency version');
        edges.set(name, { mode, declared });
      }
    }
    for (const [name, edge] of [...edges].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) this.dependency(path, name, edge.mode, edge.declared);
  }

  finish(): Readonly<{ hash: string; workspaceNames: readonly string[]; packages: number; files: number; bytes: number }> {
    for (const [path, witness] of [...this.files, ...this.directories]) if (stamp(path) !== witness) throw new Error('Runtime closure changed before observation completed');
    for (const [path, row] of this.resolutions) if (stamp(path) !== row.witness || realpathSync(path) !== row.path) throw new Error('Runtime dependency resolution changed during observation');
    for (const path of this.missing) {
      try { lstatSync(path); } catch (error) { if (absent(error)) continue; throw error; }
      throw new Error('Runtime dependency appeared during observation');
    }
    return Object.freeze({ hash: this.digest.digest('hex'), workspaceNames: [...this.visited.keys()].map(path => this.workspaceByPath.get(path)?.manifest.name)
      .filter((name): name is string => typeof name === 'string'), packages: this.visited.size, files: this.files.size, bytes: this.totalBytes });
  }
}

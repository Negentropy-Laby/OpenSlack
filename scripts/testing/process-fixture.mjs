import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { require: tsxRequire } = require('tsx/cjs/api');
const {
  normalizeProcessEnvironment,
  createProcessResolver,
  bashCandidates,
  probeBash,
  executableIdentity,
  executableCandidates,
} = tsxRequire('../../packages/core/src/process-discovery.ts', import.meta.url);

export const testProcessEnvironment = normalizeProcessEnvironment;
// Shell editions must construct their own module search path, never inherit another edition's.
export function testPowerShellEnvironment(parent = process.env, platform = process.platform) {
  const env = testProcessEnvironment(parent, platform);
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  return env;
}
export const createTestProcessResolver = createProcessResolver;
export function testTemporaryDirectory(prefix, parent = tmpdir()) {
  // Windows TEMP may use an 8.3 alias; fixtures pass canonical owned paths
  // to production code whose redirect/reparse checks deliberately stay strict.
  return realpathSync.native(mkdtempSync(join(realpathSync.native(parent), prefix)));
}

/** Reserve an OS namespace atomically; never delete a pre-existing drive alias. */
export function testWindowsDriveAlias(root, ports = {}) {
  const platform = ports.platform ?? process.platform, systemRoot = ports.systemRoot ?? process.env.SystemRoot;
  const stat = ports.stat ?? statSync, canonical = ports.canonical ?? realpathSync.native, spawn = ports.spawn ?? spawnSync;
  if (platform !== 'win32' || !systemRoot) throw new Error('TEST_DRIVE_ALIAS_WINDOWS_REQUIRED');
  root = canonical(root);
  const expected = stat(root, { bigint: true });
  const same = value => value.isDirectory() && value.dev === expected.dev && value.ino === expected.ino;
  const verifyRoot = () => { if (!same(stat(root, { bigint: true }))) throw new Error('TEST_DRIVE_ALIAS_ROOT_CHANGED'); };
  const subst = join(systemRoot, 'System32', 'subst.exe');
  const invoke = args => {
    const result = spawn(subst, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    if (result.error || result.signal || result.status === null) throw new Error('TEST_DRIVE_ALIAS_OPERATION_UNCONFIRMED');
    return result;
  };
  // Query local DOS mappings only. Never stat a pre-existing drive or follow a
  // network target to decide ownership. A refused allocation is never cleaned.
  const ownsMapping = drive => {
    const result = invoke([]);
    if (result.status !== 0) throw new Error('TEST_DRIVE_ALIAS_MAPPING_UNCONFIRMED');
    const mappings = String(result.stdout ?? '').split(/\r?\n/).map(line => line.match(/^([A-Z]:)\\:\s*=>\s*(.+)$/i))
      .filter(match => match && match[1].toUpperCase() === drive);
    if (mappings.length !== 1) return false;
    return mappings[0][2].toLowerCase() === root.toLowerCase();
  };
  for (const letter of 'ZYXWVUTSRQPONMLKJIHGFE') {
    verifyRoot();
    const drive = `${letter}:`, result = invoke([drive, root]);
    if (result.status !== 0) continue;
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      if (!ownsMapping(drive)) throw new Error(`TEST_DRIVE_ALIAS_IDENTITY_CHANGED:${drive}`);
      if (invoke([drive, '/D']).status !== 0 || ownsMapping(drive)) throw new Error(`TEST_DRIVE_ALIAS_OPERATION_UNCONFIRMED:${drive}`);
      disposed = true;
    };
    try {
      verifyRoot();
      if (!same(stat(`${drive}\\`, { bigint: true }))) throw new Error('TEST_DRIVE_ALIAS_IDENTITY_CHANGED');
      return Object.freeze({ drive, dispose });
    } catch (primary) {
      try { dispose(); }
      catch (cleanup) { throw new AggregateError([primary, cleanup], `TEST_DRIVE_ALIAS_CLEANUP_UNCONFIRMED:${drive}`, { cause: primary }); }
      throw primary;
    }
  }
  throw new Error('TEST_DRIVE_ALIAS_ALLOCATION_FAILED');
}
export function testPowerShells(env = testProcessEnvironment()) {
  // Use the same PATH/PATHEXT candidates as other fixtures. Discovering an
  // optional shell does not need another process or a separate startup timer.
  for (const candidate of executableCandidates('pwsh', env, 'win32')) {
    try {
      if (statSync(candidate).isFile()) return ['powershell', realpathSync.native(candidate)];
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw new Error('TEST_PWSH_DISCOVERY_FAILED: optional shell inspection did not complete.');
    }
  }
  // The Windows fixture must still launch mandatory PowerShell 5.1, and every
  // discovered pwsh must actually render all three cases under its child bound.
  return ['powershell'];
}
export function platformTestTimeout(baseMs, windowsMs = 120_000) {
  return process.platform === 'win32' ? windowsMs : baseMs;
}
export function testExecutable(command, env = testProcessEnvironment()) {
  return createProcessResolver(env).executable(command);
}
export function testBash(parent = testProcessEnvironment(), suppliedCandidates) {
  const cwd = process.cwd();
  parent = testProcessEnvironment(parent);
  const env = Object.freeze(
    process.platform === 'win32' ? { ...parent, MSYS: 'winsymlinks:nativestrict' } : { ...parent },
  );
  for (const executable of suppliedCandidates ?? bashCandidates(env)) {
    if (!existsSync(executable) || !probeBash(executable, env)) continue;
    const paths = new Map();
    let trusted = executableIdentity(executable);
    const verify = () => {
      const current = executableIdentity(executable);
      if (current === trusted && current) return;
      paths.clear();
      if (!current || !probeBash(executable, env))
        throw new Error('TEST_BASH_CHANGED: the selected shell changed; recreate the fixture.');
      trusted = current;
    };
    const spawn = (args, options = {}) => {
      verify();
      return spawnSync(executable, args, {
        encoding: 'utf8',
        timeout: 20_000,
        cwd,
        ...options,
        env,
      });
    };
    return {
      executable,
      env,
      spawn,
      path(value) {
        verify();
        if (process.platform !== 'win32') return value;
        if (paths.has(value)) return paths.get(value);
        const converted = spawn(['-c', 'cygpath -u -- "$1"', '--', value]);
        if (converted.status !== 0)
          throw new Error('TEST_BASH_PATH_FAILED: Git Bash could not convert the fixture path.');
        const path = converted.stdout.trim();
        paths.set(value, path);
        return path;
      },
    };
  }
  throw new Error('TEST_BASH_UNAVAILABLE: install Git Bash on Windows or Bash on Linux/macOS.');
}

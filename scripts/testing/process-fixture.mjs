import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
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
} = tsxRequire('../../packages/core/src/process-discovery.ts', import.meta.url);

export const testProcessEnvironment = normalizeProcessEnvironment;
export const createTestProcessResolver = createProcessResolver;
export function testTemporaryDirectory(prefix, parent = tmpdir()) {
  // Windows TEMP may use an 8.3 alias; fixtures pass canonical owned paths
  // to production code whose redirect/reparse checks deliberately stay strict.
  return realpathSync.native(mkdtempSync(join(realpathSync.native(parent), prefix)));
}
export function testPowerShells(env = testProcessEnvironment()) {
  const discovery = spawnSync('where.exe', ['pwsh'], {
    encoding: 'utf8',
    timeout: 1_000,
    env,
  });
  if (discovery.error || discovery.signal || (discovery.status !== 0 && discovery.status !== 1))
    throw new Error('TEST_PWSH_DISCOVERY_FAILED: optional shell discovery did not complete.');
  return discovery.status === 0 ? ['powershell', 'pwsh'] : ['powershell'];
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

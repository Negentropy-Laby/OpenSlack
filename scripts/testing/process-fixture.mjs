import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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

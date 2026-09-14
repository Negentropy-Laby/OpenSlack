import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

export function testProcessEnvironment(parent = process.env) {
  const env = Object.fromEntries(
    Object.entries(parent).filter(([key]) => !['path', 'pathext'].includes(key.toLowerCase())),
  );
  return { ...env, PATH: parent.Path ?? parent.PATH ?? '', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
}

export function testExecutable(command, env = testProcessEnvironment()) {
  const currentNode = command === 'node' && !process.versions.bun ? [process.execPath] : [];
  const names = process.platform === 'win32' ? [command + '.exe', command] : [command];
  const candidates = [
    ...currentNode,
    ...(env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .flatMap((directory) => names.map((name) => join(directory.replace(/^"|"$/g, ''), name))),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const result = spawnSync(candidate, ['--version'], { env, encoding: 'utf8', timeout: 20_000 });
    if (result.status === 0) return realpathSync(candidate);
  }
  throw new Error(
    `TEST_EXECUTABLE_UNAVAILABLE: install ${command} and include its executable directory in PATH.`,
  );
}

export function testBash(env = testProcessEnvironment(), suppliedCandidates) {
  if (process.platform === 'win32') env = { ...env, MSYS: 'winsymlinks:nativestrict' };
  const candidates =
    suppliedCandidates ??
    (process.platform === 'win32'
      ? [
          join(dirname(testExecutable('git', env)), '..', 'bin', 'bash.exe'),
          join(env.ProgramFiles ?? 'C:/Program Files', 'Git', 'bin', 'bash.exe'),
        ]
      : (env.PATH ?? '').split(delimiter).map((directory) => join(directory, 'bash')));
  for (const executable of candidates) {
    if (!existsSync(executable)) continue;
    const probe = spawnSync(executable, ['-c', 'printf "openslack-bash:"; uname -s'], {
      env,
      encoding: 'utf8',
      timeout: 20_000,
    });
    if (probe.status !== 0 || !probe.stdout.startsWith('openslack-bash:')) continue;
    if (process.platform === 'win32' && !/^openslack-bash:(MINGW|MSYS)/.test(probe.stdout))
      continue;
    return {
      executable,
      env,
      path(value) {
        if (process.platform !== 'win32') return value;
        const converted = spawnSync(executable, ['-c', 'cygpath -u -- "$1"', '--', value], {
          env,
          encoding: 'utf8',
          timeout: 20_000,
        });
        if (converted.status !== 0)
          throw new Error('TEST_BASH_PATH_FAILED: Git Bash could not convert the fixture path.');
        return converted.stdout.trim();
      },
    };
  }
  throw new Error('TEST_BASH_UNAVAILABLE: install Git Bash on Windows or Bash on Linux/macOS.');
}

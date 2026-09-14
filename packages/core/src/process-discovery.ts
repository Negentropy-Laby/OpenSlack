import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Windows has one case-insensitive environment namespace; POSIX does not. */
export function normalizeProcessEnvironment(
  parent: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== 'win32') return { ...parent };
  const entries = Object.entries(parent);
  const path =
    parent.Path ?? parent.PATH ?? entries.find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const env = Object.fromEntries(
    entries.filter(([key]) => !['path', 'pathext'].includes(key.toLowerCase())),
  );
  return { ...env, PATH: path, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
}

export function executableCandidates(
  command: string,
  parent: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string[] {
  const env = normalizeProcessEnvironment(parent, platform);
  const suffixes = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  return (env.PATH ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .filter(Boolean)
    .flatMap((directory) =>
      suffixes.map((suffix) => join(directory.replace(/^"|"$/g, ''), command + suffix)),
    );
}

export function bashCandidates(parent: NodeJS.ProcessEnv = process.env): string[] {
  const env = normalizeProcessEnvironment(parent);
  const paths = executableCandidates('bash', env);
  if (process.platform !== 'win32') return paths;
  for (const git of executableCandidates('git', env)) {
    if (!existsSync(git)) continue;
    const actual = realpathSync(git);
    paths.push(join(dirname(actual), '..', 'bin', 'bash.exe'));
    const result = spawnSync(actual, ['--exec-path'], { env, encoding: 'utf8', timeout: 20_000 });
    if (result.status === 0 && result.stdout.trim())
      paths.push(resolve(result.stdout.trim(), '../../..', 'bin', 'bash.exe'));
  }
  paths.push(join(env.ProgramFiles ?? 'C:/Program Files', 'Git', 'bin', 'bash.exe'));
  if (env.LOCALAPPDATA) paths.push(join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
  return [...new Set(paths)];
}

export function probeBash(executable: string, env: NodeJS.ProcessEnv): boolean {
  const result = spawnSync(executable, ['-c', 'printf "openslack-bash:"; uname -s'], {
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });
  return (
    result.status === 0 &&
    (process.platform === 'win32'
      ? /^openslack-bash:(MINGW|MSYS)/.test(result.stdout)
      : result.stdout.startsWith('openslack-bash:'))
  );
}

export function executableIdentity(path: string): string | undefined {
  try {
    const value = statSync(path, { bigint: true });
    return [
      realpathSync(path),
      value.dev,
      value.ino,
      value.size,
      value.mtimeNs,
      value.ctimeNs,
    ].join(':');
  } catch {
    return undefined;
  }
}

/** Positive cache belongs to this immutable environment/cwd snapshot, never to the process. */
export function createProcessResolver(
  parent: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
) {
  const env = Object.freeze(normalizeProcessEnvironment(parent));
  const cache = new Map<string, { candidate: string; path: string; identity: string }>();
  return {
    env,
    cwd,
    executable(command: string): string {
      const cached = cache.get(command);
      if (cached && executableIdentity(cached.candidate) === cached.identity) return cached.path;
      cache.delete(command);
      const currentNode =
        command === 'node' && !('bun' in process.versions) ? [process.execPath] : [];
      for (const candidate of [...currentNode, ...executableCandidates(command, env)]) {
        const path = resolve(cwd, candidate);
        const before = executableIdentity(path);
        if (!before) continue;
        const result = spawnSync(path, ['--version'], {
          cwd,
          env,
          encoding: 'utf8',
          timeout: 20_000,
        });
        if (result.status === 0 && executableIdentity(path) === before) {
          cache.set(command, { candidate: path, path: realpathSync(path), identity: before });
          return realpathSync(path);
        }
      }
      throw new Error(
        `TEST_EXECUTABLE_UNAVAILABLE: install ${command} and include its executable directory in PATH.`,
      );
    },
  };
}

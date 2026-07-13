import { existsSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';

export function resolveTestBunExecutable(): string {
  if (/^bun(?:\.exe)?$/i.test(basename(process.execPath))) return process.execPath;

  const explicit = process.env.BUN_EXE;
  if (explicit && existsSync(explicit)) return explicit;

  const npmExecPath = process.env.NPM_EXECPATH ?? process.env.npm_execpath;
  if (npmExecPath) {
    const executable = basename(npmExecPath);
    if (/^bun(?:\.exe)?$/i.test(executable) && existsSync(npmExecPath)) return npmExecPath;
    if (/^bunx(?:\.exe)?$/i.test(executable)) {
      const sibling = join(dirname(npmExecPath), process.platform === 'win32' ? 'bun.exe' : 'bun');
      if (existsSync(sibling)) return sibling;
    }
  }

  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidates =
      process.platform === 'win32'
        ? [
            join(directory, 'bun.exe'),
            join(directory, 'node_modules', 'bun', 'bin', 'bun.exe'),
          ]
        : [join(directory, 'bun')];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }

  return 'bun';
}

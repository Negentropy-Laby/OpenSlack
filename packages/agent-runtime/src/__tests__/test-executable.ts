import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function resolveTestBunExecutable(): string {
  if (/^bun(?:\.exe)?$/i.test(basename(process.execPath))) return process.execPath;

  const explicit = process.env.BUN_EXE;
  if (explicit && existsSync(explicit)) return explicit;

  const npmExecPath = process.env.NPM_EXECPATH ?? process.env.npm_execpath;
  if (npmExecPath && /^bunx(?:\.exe)?$/i.test(basename(npmExecPath))) {
    const sibling = join(dirname(npmExecPath), process.platform === 'win32' ? 'bun.exe' : 'bun');
    if (existsSync(sibling)) return sibling;
  }

  return 'bun';
}

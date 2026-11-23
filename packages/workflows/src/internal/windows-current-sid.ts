import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';

export function readWindowsCurrentSid(timeout: number): string {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !/^[a-z]:[\\/]/iu.test(systemRoot)) {
    throw new TypeError('The Windows system directory is unavailable.');
  }
  const executable = win32.join(systemRoot, 'System32', 'whoami.exe');
  const output = execFileSync(executable, ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    maxBuffer: 16 * 1024,
  }).trim();
  const match = /^"(?:""|[^"\r\n])*","(S-\d(?:-\d+)+)"$/iu.exec(output);
  if (!match) throw new TypeError('The current Windows SID is unavailable.');
  return match[1]!.toUpperCase();
}

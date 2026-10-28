/** Narrow read-only OS observations. A missing/unsupported witness never blocks
 * ordinary storage and can never be treated as evidence that a writer died. */
import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { isCode } from './io-errors.js';

export type RunWriterWitness = Readonly<{
  platform: 'linux'; boot: string; namespace: string; uid: string; pid: number; birth: string;
} | { platform: 'win32'; host: string; boot: string; pid: number; birth: string }>;
export type RunWriterObservation = 'exited' | 'alive' | 'unavailable';
let ownWitness: RunWriterWitness | null | undefined;

function linuxScope(): { boot: string; namespace: string; uid: string } {
  const ns = statSync('/proc/self/ns/pid', { bigint: true });
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (!/^[a-f0-9-]{36}$/.test(boot) || !process.getuid) throw new Error('Unavailable process scope');
  const self = statSync('/proc/self', { bigint: true }), numeric = statSync(`/proc/${process.pid}`, { bigint: true });
  const selfStat = readFileSync('/proc/self/stat', 'utf8');
  if (self.dev !== numeric.dev || self.ino !== numeric.ino || self.uid !== BigInt(process.getuid()) ||
    selfStat.slice(0, selfStat.indexOf(' ')) !== String(process.pid)) throw new Error('Procfs PID visibility does not match this process');
  return { boot, namespace: `${ns.dev}:${ns.ino}`, uid: String(process.getuid()) };
}

function linuxBirth(pid: number, uid: string): string {
  const owner = statSync(`/proc/${pid}`, { bigint: true });
  if (String(owner.uid) !== uid) throw new Error('Unverified process visibility');
  const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
  // comm can contain spaces and parentheses. All following fields have a fixed
  // numeric/state grammar, so use the last ')' rather than splitting comm.
  const end = text.lastIndexOf(')');
  if (end < 0 || text.slice(0, text.indexOf(' ')) !== String(pid)) throw new Error('Invalid process witness');
  const birth = text.slice(end + 2).trim().split(/\s+/)[19];
  if (!birth || !/^\d+$/.test(birth)) throw new Error('Invalid process witness');
  return birth;
}

function windowsProbe(pid: number): { host: string; boot: string; birth?: string } {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid writer PID');
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !/^[A-Za-z]:[\\/]/.test(systemRoot)) throw new Error('Unavailable Windows OS port');
  // The only interpolated value is this validated integer PID. Project at the
  // provider, not after reading CommandLine or other process properties.
  const script = [
    "$ErrorActionPreference='Stop'",
    "$o=Get-CimInstance -Query 'SELECT CSName,LastBootUpTime FROM Win32_OperatingSystem'",
    `$p=@(Get-CimInstance -Query 'SELECT ProcessId,CreationDate FROM Win32_Process WHERE ProcessId=${pid}')`,
    "if($p.Count -gt 1){throw 'Ambiguous process'}",
    "$b=$null;if($p.Count -eq 1){$b=$p[0].CreationDate.ToUniversalTime().ToString('O')}",
    "@{host=[string]$o.CSName;boot=$o.LastBootUpTime.ToUniversalTime().ToString('O');birth=$b}|ConvertTo-Json -Compress",
  ].join(';');
  const bytes = execFileSync(join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 5_000, maxBuffer: 16_384, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const row: unknown = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (!row || typeof row !== 'object' || !('host' in row) || !('boot' in row) || !('birth' in row) ||
    typeof row.host !== 'string' || !row.host || row.host.length > 255 || typeof row.boot !== 'string' || !Number.isFinite(Date.parse(row.boot)) ||
    (row.birth !== null && (typeof row.birth !== 'string' || !Number.isFinite(Date.parse(row.birth))))) throw new Error('Unavailable Windows witness');
  return { host: row.host, boot: row.boot, ...(typeof row.birth === 'string' ? { birth: row.birth } : {}) };
}

/** Call before entering the short run critical section. Never a caller-supplied witness. */
export function ownRunWriterWitness(): RunWriterWitness | undefined {
  if (ownWitness !== undefined) return ownWitness ?? undefined;
  try {
    if (process.platform === 'linux') {
      const scope = linuxScope();
      // Scope verification proves the numeric path maps to /proc/self; use the
      // kernel's own self record instead of assuming procfs namespace layout.
      const selfStat = readFileSync('/proc/self/stat', 'utf8');
      const birth = selfStat.slice(selfStat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
      if (!birth || !/^\d+$/.test(birth) || birth !== linuxBirth(process.pid, scope.uid)) throw new Error('Own process witness changed');
      ownWitness = Object.freeze({ platform: 'linux', ...scope, pid: process.pid, birth });
    } else if (process.platform === 'win32') {
      const scope = windowsProbe(process.pid);
      if (!scope.birth) throw new Error('Own process missing');
      ownWitness = Object.freeze({ platform: 'win32', ...scope, birth: scope.birth, pid: process.pid });
    } else ownWitness = null;
  } catch { ownWitness = null; }
  return ownWitness ?? undefined;
}

/** Only same-scope positive OS observations can prove old storage ownership ended.
 * This is never SDK/descendant-stop evidence. */
export function observeRunWriter(witness: RunWriterWitness | undefined): RunWriterObservation {
  if (!witness || !Number.isSafeInteger(witness.pid) || witness.pid < 1) return 'unavailable';
  try {
    if (process.platform === 'linux' && witness.platform === 'linux') {
      const scope = linuxScope();
      if (scope.boot !== witness.boot || scope.namespace !== witness.namespace || scope.uid !== witness.uid || !/^\d+$/.test(witness.birth)) return 'unavailable';
      try { return linuxBirth(witness.pid, scope.uid) === witness.birth ? 'alive' : 'exited'; }
      catch (error) {
        if (!isCode(error, 'ENOENT')) return 'unavailable';
        // kill(0) does not signal the process. ESRCH independently corroborates
        // absence; hidden live processes / EPERM are not false death witnesses.
        try { process.kill(witness.pid, 0); return 'unavailable'; }
        catch (probe) { return isCode(probe, 'ESRCH') ? 'exited' : 'unavailable'; }
      }
    }
    if (process.platform === 'win32' && witness.platform === 'win32') {
      const scope = windowsProbe(witness.pid);
      if (scope.host !== witness.host || scope.boot !== witness.boot || !Number.isFinite(Date.parse(witness.birth))) return 'unavailable';
      if (scope.birth === undefined) {
        try { process.kill(witness.pid, 0); return 'unavailable'; }
        catch (probe) { return isCode(probe, 'ESRCH') ? 'exited' : 'unavailable'; }
      }
      return scope.birth === witness.birth ? 'alive' : 'exited';
    }
  } catch { /* Deny maintenance on any OS/permission/parse ambiguity. */ }
  return 'unavailable';
}

import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { run, type ReleaseTarget } from './lib.js';

const WINDOWS_ARCHIVE_SOURCE_ENV = 'OPENSLACK_RELEASE_ARCHIVE_SOURCE';
const WINDOWS_ARCHIVE_PATH_ENV = 'OPENSLACK_RELEASE_ARCHIVE_PATH';
const WINDOWS_EXTRACTION_ROOT_ENV = 'OPENSLACK_RELEASE_EXTRACTION_ROOT';

// Invariant guard: archive.test.ts intentionally pins these native cmdlet
// names and literal-path arguments so a refactor cannot restore suffix-based
// `tar -a` inference on Windows.
const COMPRESS_ARCHIVE_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  `Compress-Archive -LiteralPath $env:${WINDOWS_ARCHIVE_SOURCE_ENV} -DestinationPath $env:${WINDOWS_ARCHIVE_PATH_ENV} -CompressionLevel Optimal -ErrorAction Stop`,
].join('; ');

const EXPAND_ARCHIVE_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  `Expand-Archive -LiteralPath $env:${WINDOWS_ARCHIVE_PATH_ENV} -DestinationPath $env:${WINDOWS_EXTRACTION_ROOT_ENV} -Force -ErrorAction Stop`,
].join('; ');

/**
 * Create the target's declared archive format using an independent native
 * implementation. In particular, never ask GNU tar to infer ZIP from a .zip
 * suffix: it silently creates an uncompressed tar archive on Git Bash hosts.
 * Windows PowerShell 5.1 Compress-Archive is a deliberate v0.1.x tradeoff: it
 * is standards-compliant for this small, regular-file-only bundle, but it is
 * unsuitable once release inputs approach 2 GB or require symlink semantics.
 */
export function createReleaseArchive(
  bundleDirInput: string,
  archivePathInput: string,
  target: ReleaseTarget,
): void {
  const bundleDir = resolve(bundleDirInput);
  const archivePath = resolve(archivePathInput);
  if (target === 'windows-x64') {
    assertHost('win32', target);
    runWindowsPowerShell(COMPRESS_ARCHIVE_COMMAND, {
      [WINDOWS_ARCHIVE_SOURCE_ENV]: bundleDir,
      [WINDOWS_ARCHIVE_PATH_ENV]: archivePath,
    });
    return;
  }

  assertHost('linux', target);
  run('tar', ['-czf', archivePath, basename(bundleDir)], { cwd: dirname(bundleDir) });
}

/** Extract with the native consumer for the declared format. */
export function extractReleaseArchive(
  archivePathInput: string,
  destinationInput: string,
  target: ReleaseTarget,
): void {
  const archivePath = resolve(archivePathInput);
  const destination = resolve(destinationInput);
  mkdirSync(destination, { recursive: true });
  if (target === 'windows-x64') {
    assertHost('win32', target);
    runWindowsPowerShell(EXPAND_ARCHIVE_COMMAND, {
      [WINDOWS_ARCHIVE_PATH_ENV]: archivePath,
      [WINDOWS_EXTRACTION_ROOT_ENV]: destination,
    });
    return;
  }

  assertHost('linux', target);
  run('tar', ['-xzf', archivePath, '-C', destination]);
}

function runWindowsPowerShell(command: string, values: Record<string, string>): void {
  const executable = resolveWindowsPowerShell();
  run(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { env: { ...process.env, ...values } },
  );
}

function resolveWindowsPowerShell(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) throw new Error('Windows release archive creation requires SystemRoot.');
  const executable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!existsSync(executable)) {
    throw new Error('Windows PowerShell is required for release archive creation.');
  }
  return executable;
}

function assertHost(platform: NodeJS.Platform, target: ReleaseTarget): void {
  if (process.platform !== platform) {
    throw new Error(`Release archive ${target} must be created and extracted on its native host.`);
  }
}

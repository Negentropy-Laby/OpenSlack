import { posix, win32 } from 'node:path';

export const CLEANUP_SHA256 = /^[a-f0-9]{64}$/;
export const CLEANUP_HEAD = /^[a-f0-9]{40}$/;
export const CLEANUP_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export function cleanupObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function cleanupExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Credential names are always refused. Repository Black directories are relative
 * to the declared root, so macOS's system /private/var prefix is not a credential.
 */
export function isSensitiveCleanupInput(path: string, root = process.cwd()): boolean {
  const segments = path.split(/[/\\]/);
  if (
    segments.some((part) => /^(?:credentials|secrets|\.env)(?:\.|$)/i.test(part)) ||
    /\.(?:pem|key)$/i.test(path)
  )
    return true;
  const api = /^[A-Za-z]:[/\\]/.test(path) ? win32 : posix;
  const relative = api.relative(api.resolve(root), api.resolve(path));
  return !relative.startsWith('..') && /^(?:private|prod-tokens)(?:[/\\]|$)/i.test(relative);
}

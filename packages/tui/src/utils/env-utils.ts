/**
 * Environment variable truthiness check.
 *
 * Adapted from Aby's envUtils.ts — stripped to the single utility
 * needed by the TUI layer.
 */

export function isEnvTruthy(envVar: string | boolean | undefined): boolean {
  if (!envVar) return false;
  if (typeof envVar === 'boolean') return envVar;
  const normalizedValue = envVar.toLowerCase().trim();
  return ['1', 'true', 'yes', 'on'].includes(normalizedValue);
}

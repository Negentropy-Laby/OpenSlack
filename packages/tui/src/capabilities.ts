import { isEnvTruthy } from './utils/env-utils.js';

const MIN_COLUMNS = 40;
const MIN_ROWS = 12;

export function isTuiSupported(): boolean {
  if (!process.stdout.isTTY) return false;

  if (isEnvTruthy(process.env.NO_COLOR)) return false;

  if (process.env.OPENSLACK_TUI === '0') return false;

  if (isEnvTruthy(process.env.CI)) return false;

  const columns = process.stdout.columns ?? 0;
  const rows = process.stdout.rows ?? 0;
  if (columns < MIN_COLUMNS || rows < MIN_ROWS) return false;

  return true;
}

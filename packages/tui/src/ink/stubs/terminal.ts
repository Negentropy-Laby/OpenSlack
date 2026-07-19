/**
 * Stub for terminal capability detection — conservative defaults for OpenSlack TUI.
 */

export type Progress = {
  state: 'running' | 'completed' | 'error' | 'indeterminate';
  percentage?: number;
};

export function isProgressReportingAvailable(): boolean {
  return false;
}

export function isXtermJs(): boolean {
  return false;
}

export function isSynchronizedOutputSupported(): boolean {
  return false;
}

/**
 * Stub for debug logger — no-op in OpenSlack TUI.
 */

export function debug(_namespace: string, _formatter: string, ..._args: unknown[]): void {
  // intentionally empty
}

export function logForDebugging(
  _message: string,
  _opts?: { level?: string },
): void {
  // intentionally empty
}

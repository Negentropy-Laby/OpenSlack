/**
 * Stub for execFileNoThrow — no-op in OpenSlack TUI.
 * The tui package does not shell out to native clipboard utilities.
 */

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export async function execFileNoThrow(
  _cmd: string,
  _args: string[],
  _opts?: { input?: string; useCwd?: boolean; timeout?: number },
): Promise<ExecResult> {
  return { code: 1, stdout: '', stderr: '' };
}

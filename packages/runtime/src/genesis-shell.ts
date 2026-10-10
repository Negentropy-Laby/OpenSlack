import { spawnSync } from 'node:child_process';
import type { SetupFinding } from './setup-report.js';

/**
 * Why a genesis validation run did not succeed.
 *
 * These are deliberately distinct. A cold WSL start that exceeds the budget is
 * a retryable TIMEOUT, not a failing repository check, and an absent shell is
 * an environment gap rather than a broken script. Collapsing them into one
 * generic failure is what made the original report misleading.
 */
export type GenesisValidationFailure =
  | 'SHELL_UNAVAILABLE'
  | 'TOOL_MISSING'
  | 'TIMEOUT'
  | 'SCRIPT_FAILED';

export interface GenesisValidationResult {
  ok: boolean;
  failure?: GenesisValidationFailure;
  detail: string;
}

export interface GenesisValidationOptions {
  /** Working directory the relative script path is resolved against. */
  cwd: string;
  /**
   * Existing execution budget. It is intentionally unchanged: cold shell
   * startup is classified rather than accommodated by a longer timeout.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_DIAGNOSTIC_CHARS = 400;

function tail(value: string | null | undefined): string {
  const text = (value ?? '').trim();
  if (!text) return '';
  return text.length <= MAX_DIAGNOSTIC_CHARS ? text : text.slice(-MAX_DIAGNOSTIC_CHARS);
}

/**
 * Run the genesis validation script through the structured invocation resolved
 * by {@link detectGenesisShell}.
 *
 * The executable is launched directly rather than through a shell, so a path
 * containing spaces or shell metacharacters is not reinterpreted, and a
 * polluted PATH cannot silently select a different launcher.
 */
export function runGenesisValidation(
  finding: Pick<SetupFinding, 'detail' | 'exec'>,
  options: GenesisValidationOptions,
): GenesisValidationResult {
  const exec = finding.exec;
  if (!exec) {
    return { ok: false, failure: 'SHELL_UNAVAILABLE', detail: finding.detail };
  }

  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = spawnSync(exec.executable, exec.args, {
    cwd: options.cwd,
    stdio: 'pipe',
    timeout,
    encoding: 'utf8',
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        failure: 'TOOL_MISSING',
        detail: `genesis shell is no longer present: ${exec.executable}`,
      };
    }
    if (code === 'ETIMEDOUT') {
      return {
        ok: false,
        failure: 'TIMEOUT',
        detail: `genesis shell did not finish within ${timeout}ms; retry once the shell is warm`,
      };
    }
    return { ok: false, failure: 'TOOL_MISSING', detail: result.error.message };
  }

  if (result.signal) {
    return {
      ok: false,
      failure: 'TIMEOUT',
      detail: `genesis shell was terminated by ${result.signal} after ${timeout}ms`,
    };
  }

  if (result.status !== 0) {
    const diagnostic = tail(result.stderr) || tail(result.stdout);
    return {
      ok: false,
      failure: 'SCRIPT_FAILED',
      detail: `genesis validation exited with status ${String(result.status)}${
        diagnostic ? `: ${diagnostic}` : ''
      }`,
    };
  }

  return { ok: true, detail: '5/5 checks passing' };
}

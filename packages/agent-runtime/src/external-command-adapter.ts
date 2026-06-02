import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentExecutionAdapter, AdapterExecutionContext, AdapterExecutionResult } from './adapter.js';
import { PermissionDeniedError } from './types.js';

/**
 * Options for the external command adapter.
 */
export interface ExternalCommandAdapterOptions {
  /** Command to execute (e.g., 'claude', 'codex', 'node'). */
  command: string;
  /** Arguments to pass to the command. */
  args?: string[];
  /** Environment variables to set (merged with process.env). */
  env?: Record<string, string>;
  /** Maximum execution time in milliseconds. Default: 120000 (2 minutes). */
  timeoutMs?: number;
  /** Maximum stdout/stderr capture size in bytes. Default: 1MB. */
  maxCaptureBytes?: number;
  /** Parse stdout as JSON when exit code is 0. Default: true. */
  parseJson?: boolean;
}

/**
 * Result of an external command execution, including process metadata.
 */
export interface ExternalCommandResult {
  /** Exit code of the process. null if killed by signal or timeout. */
  exitCode: number | null;
  /** Signal that killed the process, if any. */
  signal: string | null;
  /** Captured stdout (truncated to maxCaptureBytes). */
  stdout: string;
  /** Captured stderr (truncated to maxCaptureBytes). */
  stderr: string;
  /** Whether the process was killed due to timeout. */
  timedOut: boolean;
  /** Whether stdout or stderr was truncated. */
  truncated: boolean;
  /** Wall-clock execution time in milliseconds. */
  durationMs: number;
  /** Parsed JSON result if parseJson is true and stdout is valid JSON. */
  parsedResult?: unknown;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CAPTURE_BYTES = 1_024 * 1_024; // 1MB
const TRUNCATION_MARKER = '\n... [truncated]';

/**
 * External command execution adapter.
 *
 * Spawns a child process, captures stdout/stderr with size caps,
 * handles timeout, cancel, and structured JSON result parsing.
 *
 * Security:
 * - CWD is set to worktreePath when available, otherwise rootDir
 * - Tool guard is enforced: the adapter checks 'Bash' permission
   before spawning any process
 * - stdout/stderr are size-capped to prevent unbounded memory growth
 * - Exit code, signal, and timeout are all recorded
 */
export class ExternalCommandAdapter implements AgentExecutionAdapter {
  readonly adapterId = 'external-command';
  private readonly options: ExternalCommandAdapterOptions;

  constructor(options: ExternalCommandAdapterOptions) {
    this.options = options;
  }

  async execute<T>(context: AdapterExecutionContext): Promise<AdapterExecutionResult<T>> {
    const { recorder, runState, toolGuard } = context;
    const {
      command,
      args = [],
      env: extraEnv,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxCaptureBytes = DEFAULT_MAX_CAPTURE_BYTES,
      parseJson = true,
    } = this.options;

    // Enforce tool guard: external command execution requires Bash permission
    toolGuard.check('Bash');

    const cwd = context.worktreePath;

    recorder.progress(runState.runId, {
      step: 'external_command_start',
      command,
      args,
      cwd,
      timeoutMs,
    });

    const startTime = Date.now();

    try {
      const result = await this.spawnProcess(command, args, {
        cwd,
        extraEnv,
        timeoutMs,
        maxCaptureBytes,
      });

      const durationMs = Date.now() - startTime;

      recorder.progress(runState.runId, {
        step: 'external_command_complete',
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        truncated: result.truncated,
        durationMs,
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
      });

      // If the process failed, throw with stderr as message
      if (result.exitCode !== 0) {
        const errorDetail = result.timedOut
          ? `External command timed out after ${timeoutMs}ms`
          : `External command exited with code ${result.exitCode}`;

        recorder.progress(runState.runId, {
          step: 'external_command_failed',
          exitCode: result.exitCode,
          stderr: truncateString(result.stderr, 500),
        });

        throw new Error(
          `${errorDetail}: ${command} ${args.join(' ')}\n${truncateString(result.stderr, 1000)}`,
        );
      }

      // Parse JSON result if enabled
      let data: T;
      if (parseJson && result.stdout.trim()) {
        try {
          data = JSON.parse(result.stdout) as T;
        } catch {
          // Not valid JSON — return raw stdout as the result
          data = { raw: result.stdout, truncated: result.truncated } as T;
        }
      } else {
        data = { raw: result.stdout, truncated: result.truncated } as T;
      }

      return {
        data,
        tokenUsage: estimateExternalTokenUsage(result.stdout, result.stderr),
      };
    } catch (err) {
      // Re-throw PermissionDeniedError as-is
      if (err instanceof PermissionDeniedError) throw err;

      // Wrap other errors with context
      const durationMs = Date.now() - startTime;
      recorder.progress(runState.runId, {
        step: 'external_command_error',
        error: err instanceof Error ? err.message : String(err),
        durationMs,
      });
      throw err;
    }
  }

  private spawnProcess(
    command: string,
    args: string[],
    opts: {
      cwd?: string;
      extraEnv?: Record<string, string>;
      timeoutMs: number;
      maxCaptureBytes: number;
    },
  ): Promise<ExternalCommandResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      let killed = false;

      const env = { ...process.env, ...opts.extraEnv };

      const spawnOpts: Parameters<typeof spawn>[2] = {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Do not run in shell to prevent injection. Args array prevents
        // shell injection regardless, but shell:false is defense-in-depth.
        shell: false,
      };
      // Only set cwd when a valid path is provided; otherwise inherit
      // the parent's cwd (typically the repo root).
      if (opts.cwd) {
        spawnOpts.cwd = opts.cwd;
      }

      const child: ChildProcess = spawn(command, args, spawnOpts);

      const timeout = setTimeout(() => {
        timedOut = true;
        killed = true;
        child.kill('SIGTERM');
        // Give 5s for graceful shutdown, then force kill
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 5000);
      }, opts.timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < opts.maxCaptureBytes) {
          stdout += chunk.toString('utf-8');
          if (stdout.length > opts.maxCaptureBytes) {
            stdout = stdout.slice(0, opts.maxCaptureBytes) + TRUNCATION_MARKER;
            truncated = true;
          }
        } else {
          truncated = true;
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < opts.maxCaptureBytes) {
          stderr += chunk.toString('utf-8');
          if (stderr.length > opts.maxCaptureBytes) {
            stderr = stderr.slice(0, opts.maxCaptureBytes) + TRUNCATION_MARKER;
            truncated = true;
          }
        } else {
          truncated = true;
        }
      });

      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        resolve({
          exitCode: code,
          signal: signal,
          stdout,
          stderr,
          timedOut,
          truncated,
          durationMs: 0, // Set by caller
        });
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        resolve({
          exitCode: null,
          signal: null,
          stdout,
          stderr: err.message,
          timedOut: false,
          truncated,
          durationMs: 0,
        });
      });
    });
  }
}

function truncateString(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + '...';
}

function estimateExternalTokenUsage(stdout: string, stderr: string): number {
  // Rough heuristic: ~4 chars per token, stderr at half weight
  return Math.ceil(stdout.length / 4) + Math.ceil(stderr.length / 8) + 50;
}

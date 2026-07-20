/**
 * Bridge Worktree Guard — validates worktree boundary constraints for bridge
 * sessions. Receives worktree path from launcher and communicates it via
 * session config envelope. Post-session boundary validation records evidence
 * about cwd, preserved dirty state, and bridge-reported outside-root attempts.
 *
 * This is a contract and evidence guard, not an OS sandbox.
 *
 * AR-2.5E: Worktree Contract
 */

import { resolve as pathResolve, sep as pathSep } from 'node:path';
import type { BridgeWorktreeConfig } from './bridge-contract.js';
import type { RunRecorder } from './recorder.js';

export interface BridgeWorktreeValidationResult {
  valid: boolean;
  violation?: string;
}

/**
 * Validates worktree boundary constraints at the bridge interface.
 *
 * - No worktree → guard is no-op (all operations succeed)
 * - With worktree → validates CWD matches, rejects outside-root events
 */
export class BridgeWorktreeGuard {
  private readonly recorder: RunRecorder;
  private readonly runId: string;

  constructor(recorder: RunRecorder, runId: string) {
    this.recorder = recorder;
    this.runId = runId;
  }

  /**
   * Build a BridgeWorktreeConfig from launcher-provided worktree info.
   * Returns null when no worktree is active.
   */
  static buildConfig(
    worktreePath: string | undefined,
    branchName?: string,
  ): BridgeWorktreeConfig | null {
    if (!worktreePath) return null;

    return {
      worktreePath,
      branchName: branchName ?? 'agent/unknown/unknown/unknown',
      allowedRoot: worktreePath,
      isolationActive: true,
    };
  }

  /**
   * Validate that a path is within the allowed root.
   * Returns validation result; does not throw.
   */
  validatePath(path: string, allowedRoot: string): BridgeWorktreeValidationResult {
    // Reject null bytes — prevents null byte injection attacks
    if (path.includes('\0') || allowedRoot.includes('\0')) {
      return {
        valid: false,
        violation: 'Path contains null byte',
      };
    }

    const normalizedPath = normalizePath(path);
    const normalizedRoot = normalizePath(allowedRoot);

    // Resolve both paths to absolute canonical form to handle '..' and '.' components
    // Then normalize again to ensure forward slashes for consistent comparison
    const resolvedPath = normalizePath(pathResolve(normalizedPath));
    const resolvedRoot = normalizePath(pathResolve(normalizedRoot));

    // Platform-aware case normalization (Windows is case-insensitive)
    const comparePath = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
    const compareRoot = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;

    if (!comparePath.startsWith(compareRoot)) {
      return {
        valid: false,
        violation: `Path "${path}" is outside allowed root "${allowedRoot}"`,
      };
    }

    // Ensure the character after the root is a separator (prevents prefix attacks like /tmp/worktree-1-other)
    if (comparePath !== compareRoot && comparePath[compareRoot.length] !== '/') {
      return {
        valid: false,
        violation: `Path "${path}" escapes allowed root via prefix collision`,
      };
    }

    return { valid: true };
  }

  /**
   * Validate that a given CWD matches the expected worktree root.
   * Used to verify post-session that the process CWD remained within bounds.
   * Returns validation result; does not throw.
   */
  validateCwd(
    actualCwd: string,
    config: BridgeWorktreeConfig | null,
  ): BridgeWorktreeValidationResult {
    if (!config || !config.isolationActive) {
      return { valid: true };
    }

    const result = this.validatePath(actualCwd, config.allowedRoot);
    if (!result.valid) {
      this.recordBoundaryViolation('cwd_mismatch', actualCwd, config.allowedRoot);
    }
    return result;
  }

  /**
   * Validate a bridge-reported file event against the worktree boundary.
   */
  validateFileEvent(
    filePath: string,
    config: BridgeWorktreeConfig | null,
  ): BridgeWorktreeValidationResult {
    if (!config || !config.isolationActive) {
      return { valid: true };
    }

    const result = this.validatePath(filePath, config.allowedRoot);
    if (!result.valid) {
      this.recordBoundaryViolation('file_event', filePath, config.allowedRoot);
    }
    return result;
  }

  /**
   * Validate a bridge-reported tool event that may reference file paths.
   */
  validateToolEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    config: BridgeWorktreeConfig | null,
  ): BridgeWorktreeValidationResult {
    if (!config || !config.isolationActive) {
      return { valid: true };
    }

    // Extract potential file paths from common tool input fields
    const pathsToCheck = extractPathsFromToolInput(toolInput);

    for (const path of pathsToCheck) {
      const result = this.validatePath(path, config.allowedRoot);
      if (!result.valid) {
        this.recordBoundaryViolation(toolName, path, config.allowedRoot);
        return {
          valid: false,
          violation: `Tool "${toolName}" attempted to access path outside worktree: ${path}`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Post-session validation: record boundary evidence about the worktree state.
   *
   * Dirty-state detection and worktree cleanup are the launcher's
   * responsibility. This method records boundary-violation evidence only.
   * When `dirty` and `preserved` are not provided, they are omitted from
   * the transcript event to avoid fabricating state the bridge adapter
   * did not actually check.
   */
  recordPostSessionValidation(
    config: BridgeWorktreeConfig | null,
    options: {
      dirty?: boolean;
      preserved?: boolean;
      outsideRootAttempts?: string[];
    } = {},
  ): void {
    if (!config) return;

    const data: Record<string, unknown> = {
      step: 'bridge_worktree_post_validation',
      worktreePath: config.worktreePath,
      branchName: config.branchName,
      outsideRootAttempts: options.outsideRootAttempts ?? [],
    };

    // Only include dirty/preserved when explicitly provided by the caller
    // who actually performed the dirty check (typically the launcher).
    if (options.dirty !== undefined) {
      data.dirty = options.dirty;
    }
    if (options.preserved !== undefined) {
      data.preserved = options.preserved;
    }

    this.recorder.progress(this.runId, data);
  }

  /**
   * Record a boundary violation as transcript evidence.
   */
  private recordBoundaryViolation(context: string, path: string, allowedRoot: string): void {
    this.recorder.progress(this.runId, {
      step: 'worktree_boundary_violation',
      context,
      path,
      allowedRoot,
      violation: `Attempted access outside worktree boundary: ${path} not within ${allowedRoot}`,
    });
  }
}

function normalizePath(p: string): string {
  // Normalize path separators for cross-platform comparison
  return p.replace(/\\/g, '/').replace(/\/$/, '');
}

function extractPathsFromToolInput(input: Record<string, unknown>): string[] {
  const paths: string[] = [];

  // Common fields that contain paths in tool inputs.
  // Note: 'command' (Bash tool) contains embedded paths that require
  // different validation (CWD-based rather than path parsing).
  const pathFields = [
    'path',
    'filePath',
    'cwd',
    'dir',
    'directory',
    'rootDir',
    'destination',
    'target',
    'outputPath',
    'file_path',
    'workingDirectory',
  ];

  for (const field of pathFields) {
    const value = input[field];
    if (typeof value === 'string') {
      paths.push(value);
    }
  }

  return paths;
}

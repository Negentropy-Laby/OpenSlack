import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { scanValue } from '@openslack/collaboration';
import type {
  AgentRunFailureCode,
  AgentRunRequest,
  AgentRunState,
  AgentRunStatus,
} from './types.js';

const RUNS_DIR_NAME = 'agents/runs';
const ORPHAN_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
const RUN_TEMP_FILE_RE = /^(?:run|metadata)\.json\..+\.tmp$/;

export const RUN_ID_RE = /^RUN-[A-Z0-9-]+$/;

export function validateRunId(id: string): void {
  if (typeof id !== 'string' || !RUN_ID_RE.test(id)) {
    throw new Error(`Invalid run ID: "${id}". Must match RUN-XXXXXXXX-XXXX format.`);
  }
}

function getRunsBaseDir(rootDir?: string): string {
  return join(rootDir ?? process.cwd(), '.openslack.local', RUNS_DIR_NAME);
}

function getRunDir(runId: string, rootDir?: string): string {
  return join(getRunsBaseDir(rootDir), runId);
}

function getRunMetaPath(runId: string, rootDir?: string): string {
  return join(getRunDir(runId, rootDir), 'run.json');
}

function getRunRequestPath(runId: string, rootDir?: string): string {
  return join(getRunDir(runId, rootDir), 'metadata.json');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function generateRunId(): string {
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
  return `RUN-${ts}-${rand}`;
}

export interface AgentRunStore {
  createRun(request: AgentRunRequest): AgentRunState;
  createFailedRun(
    request: AgentRunRequest,
    failure: { failureCode: AgentRunFailureCode; errorSummary: string },
  ): AgentRunState;
  updateRun(runId: string, patch: Partial<AgentRunState>): AgentRunState;
  getRun(runId: string): AgentRunState | null;
  listRuns(options?: { agentId?: string; status?: AgentRunStatus }): AgentRunState[];
}

export interface SweepOrphanRunTempOptions {
  olderThanMs?: number;
  nowMs?: number;
}

/** Remove stale atomic-write temp files without touching live or unrelated files. */
export function sweepOrphanRunTempFiles(
  rootDir?: string,
  options: SweepOrphanRunTempOptions = {},
): number {
  const baseDir = getRunsBaseDir(rootDir);
  if (!existsSync(baseDir)) return 0;

  const cutoff = (options.nowMs ?? Date.now()) -
    (options.olderThanMs ?? ORPHAN_TEMP_MAX_AGE_MS);
  let removed = 0;
  const runEntries = (() => {
    try {
      return readdirSync(baseDir, { withFileTypes: true });
    } catch {
      return [];
    }
  })();
  for (const runEntry of runEntries) {
    if (!runEntry.isDirectory() || !RUN_ID_RE.test(runEntry.name)) continue;
    const runDir = join(baseDir, runEntry.name);
    const fileEntries = (() => {
      try {
        return readdirSync(runDir, { withFileTypes: true });
      } catch {
        return [];
      }
    })();
    for (const fileEntry of fileEntries) {
      if (!fileEntry.isFile() || !RUN_TEMP_FILE_RE.test(fileEntry.name)) continue;
      const path = join(runDir, fileEntry.name);
      try {
        if (statSync(path).mtimeMs > cutoff) continue;
        unlinkSync(path);
        removed += 1;
      } catch {
        // Best effort: a concurrent writer or cleanup may own this file.
      }
    }
  }
  return removed;
}

export function createRunStore(rootDir?: string): AgentRunStore {
  const baseDir = getRunsBaseDir(rootDir);
  sweepOrphanRunTempFiles(rootDir);

  function buildState(request: AgentRunRequest): AgentRunState {
    const now = new Date().toISOString();
    return {
      runId: request.runId,
      status: 'pending',
      agentId: request.agentId,
      model: request.resolvedConfig.model,
      startedAt: now,
      tokensUsed: 0,
      tokensRemaining: request.budget?.tokens ?? null,
      toolCalls: 0,
      worktreePath: request.worktreePath,
      transcriptPath: join(getRunDir(request.runId, rootDir), 'transcript.jsonl'),
    };
  }

  function buildMetadata(request: AgentRunRequest): Record<string, unknown> {
    const persistedResolvedConfig = { ...request.resolvedConfig };
    delete persistedResolvedConfig.prompt;
    delete persistedResolvedConfig.initialPrompt;
    delete persistedResolvedConfig.criticalSystemReminder;
    return {
      runId: request.runId,
      agentId: request.agentId,
      resolvedConfig: persistedResolvedConfig,
      permissionProfile: request.permissionProfile,
      budget: request.budget,
      correlationId: request.correlationId,
      threadId: request.threadId,
      worktreePath: request.worktreePath,
    };
  }

  function persistNewRun(request: AgentRunRequest, state: AgentRunState): AgentRunState {
    const metadata = buildMetadata(request);
    const stateScan = scanValue(state, 'runState');
    if (stateScan.found) {
      throw new Error(
        `Run state contains ${stateScan.name} at ${stateScan.path}. Refusing to persist.`,
      );
    }
    const metadataScan = scanValue(metadata, 'metadata');
    if (metadataScan.found) {
      throw new Error(
        `Run metadata contains ${metadataScan.name} at ${metadataScan.path}. Refusing to persist.`,
      );
    }

    const runDir = getRunDir(request.runId, rootDir);
    ensureDir(runDir);
    const statePath = getRunMetaPath(request.runId, rootDir);
    const metadataPath = getRunRequestPath(request.runId, rootDir);
    const nonce = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    const stateTempPath = `${statePath}.${nonce}.tmp`;
    const metadataTempPath = `${metadataPath}.${nonce}.tmp`;
    let metadataPublished = false;
    let statePublished = false;
    try {
      writeFileSync(metadataTempPath, JSON.stringify(metadata, null, 2), {
        encoding: 'utf-8',
        flag: 'wx',
      });
      writeFileSync(stateTempPath, JSON.stringify(state, null, 2), {
        encoding: 'utf-8',
        flag: 'wx',
      });
      // run.json is the observable commit marker. Publish it only after the
      // request metadata is durable at its final path.
      renameSync(metadataTempPath, metadataPath);
      metadataPublished = true;
      renameSync(stateTempPath, statePath);
      statePublished = true;
    } catch (error) {
      removeIfPresent(metadataTempPath);
      removeIfPresent(stateTempPath);
      if (metadataPublished && !statePublished) removeIfPresent(metadataPath);
      throw error;
    }
    return state;
  }

  return {
    createRun(request: AgentRunRequest): AgentRunState {
      const runId = request.runId || generateRunId();
      validateRunId(runId);
      const normalizedRequest = { ...request, runId };
      return persistNewRun(normalizedRequest, buildState(normalizedRequest));
    },

    createFailedRun(request, failure): AgentRunState {
      const runId = request.runId || generateRunId();
      validateRunId(runId);
      const normalizedRequest = { ...request, runId };
      const now = new Date().toISOString();
      const state: AgentRunState = {
        ...buildState(normalizedRequest),
        status: 'failed',
        completedAt: now,
        failureCode: failure.failureCode,
        errorSummary: failure.errorSummary,
        error: failure.errorSummary,
      };
      return persistNewRun(normalizedRequest, state);
    },

    updateRun(runId: string, patch: Partial<AgentRunState>): AgentRunState {
      validateRunId(runId);
      const metaPath = getRunMetaPath(runId, rootDir);
      if (!existsSync(metaPath)) {
        throw new Error(`Run not found: ${runId}`);
      }

      const raw = readFileSync(metaPath, 'utf-8');
      const existing = JSON.parse(raw) as AgentRunState;

      const updated: AgentRunState = { ...existing, ...patch };

      // Secret-scan the updated state before persisting
      const scan = scanValue(updated, 'runState');
      if (scan.found) {
        throw new Error(
          `Run state update contains ${scan.name} at ${scan.path}. Refusing to persist.`,
        );
      }

      writeFileSync(metaPath, JSON.stringify(updated, null, 2), 'utf-8');

      return updated;
    },

    getRun(runId: string): AgentRunState | null {
      validateRunId(runId);
      const metaPath = getRunMetaPath(runId, rootDir);
      if (!existsSync(metaPath)) return null;

      let raw: string;
      try {
        raw = readFileSync(metaPath, 'utf-8');
      } catch {
        return null;
      }

      let parsed: AgentRunState;
      try {
        parsed = JSON.parse(raw) as AgentRunState;
      } catch {
        throw new Error(`Corrupted run metadata for ${runId}: failed to parse run.json`);
      }

      if (parsed.runId !== runId) return null;
      return parsed;
    },

    listRuns(options?: { agentId?: string; status?: AgentRunStatus }): AgentRunState[] {
      if (!existsSync(baseDir)) return [];

      const runs: AgentRunState[] = [];

      const entries = readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const runId = entry.name;
        if (!RUN_ID_RE.test(runId)) continue;

        const run = this.getRun(runId);
        if (!run) continue;

        if (options?.agentId && run.agentId !== options.agentId) continue;
        if (options?.status && run.status !== options.status) continue;

        runs.push(run);
      }

      return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    },
  };
}

function removeIfPresent(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Best effort only; a directory without run.json remains invisible.
  }
}

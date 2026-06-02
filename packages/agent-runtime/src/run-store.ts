import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanValue } from '@openslack/collaboration';
import type { AgentRunRequest, AgentRunState, AgentRunStatus } from './types.js';

const RUNS_DIR_NAME = 'agents/runs';

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
  updateRun(runId: string, patch: Partial<AgentRunState>): AgentRunState;
  getRun(runId: string): AgentRunState | null;
  listRuns(options?: { agentId?: string; status?: AgentRunStatus }): AgentRunState[];
}

export function createRunStore(rootDir?: string): AgentRunStore {
  const baseDir = getRunsBaseDir(rootDir);

  return {
    createRun(request: AgentRunRequest): AgentRunState {
      const runId = request.runId || generateRunId();
      validateRunId(runId);

      const now = new Date().toISOString();
      const state: AgentRunState = {
        runId,
        status: 'pending',
        agentId: request.agentId,
        model: request.resolvedConfig.model,
        startedAt: now,
        tokensUsed: 0,
        tokensRemaining: request.budget?.tokens ?? null,
        toolCalls: 0,
        worktreePath: request.worktreePath,
        transcriptPath: join(getRunDir(runId, rootDir), 'transcript.jsonl'),
      };

      const runDir = getRunDir(runId, rootDir);
      ensureDir(runDir);

      writeFileSync(getRunMetaPath(runId, rootDir), JSON.stringify(state, null, 2), 'utf-8');

      // Store metadata (request without the full prompt for size)
      const metadata = {
        runId: request.runId,
        agentId: request.agentId,
        resolvedConfig: request.resolvedConfig,
        permissionProfile: request.permissionProfile,
        budget: request.budget,
        correlationId: request.correlationId,
        threadId: request.threadId,
        worktreePath: request.worktreePath,
      };

      // Secret-scan metadata before persisting
      const scan = scanValue(metadata, 'metadata');
      if (scan.found) {
        throw new Error(
          `Run metadata contains ${scan.name} at ${scan.path}. Refusing to persist.`,
        );
      }

      writeFileSync(getRunRequestPath(runId, rootDir), JSON.stringify(metadata, null, 2), 'utf-8');

      return state;
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

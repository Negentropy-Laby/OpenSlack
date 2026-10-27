import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { CollaborationEvent } from '@openslack/collaboration';
import { RUN_ID_RE, readRunStateSnapshot, readHarnessStopIntent } from '@openslack/agent-runtime/internal/harness';
import { LocalReadBoundError } from './bounded-read.js';

/** Optional bounded read model; contains no principal data, paths, transcripts or bearer material. */
export interface HarnessExecutionProjection {
  taskId: string;
  runId: string;
  status: string;
  acceptance: string;
  summary: string;
  evidenceRefs: string[];
  stopRequested?: boolean;
}

function row(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Read only an existing visible workflow anchor's bound Agent Run. Never constructs a RunStore. */
export function readHarnessExecutionProjection(
  root: string,
  runId: string,
  visibleEvents: readonly CollaborationEvent[],
): HarnessExecutionProjection | undefined {
  if (!RUN_ID_RE.test(runId) ||
    !visibleEvents.some(event => event.object.kind === 'workflow' && event.object.id === runId)) return undefined;
  let path = root;
  for (const segment of ['.openslack.local', 'agents', 'runs', runId]) {
    path = join(path, segment);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LocalReadBoundError('HARNESS_RUN_PATH_UNSAFE');
    } catch (error) {
      if (row(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }
  const state: unknown = readRunStateSnapshot(runId, root);
  if (!row(state) || state.harnessExecution === undefined) return undefined;
  const binding = state.harnessExecution;
  if (state.runId !== runId || !row(binding) || binding.schema !== 'openslack.harness_execution.v1' ||
    typeof binding.taskId !== 'string' || binding.taskId.length > 128 ||
    typeof state.status !== 'string' || !['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'].includes(state.status) ||
    typeof binding.acceptance !== 'string' || !['pending', 'verified', 'rejected', 'indeterminate'].includes(binding.acceptance) ||
    (state.status === 'completed' && binding.acceptance !== 'verified') ||
    typeof binding.summary !== 'string' || Buffer.byteLength(binding.summary) > 4096 ||
    !Array.isArray(binding.evidenceRefs) || binding.evidenceRefs.length > 128 ||
    binding.evidenceRefs.some(ref => typeof ref !== 'string' || !/^[a-z][a-z0-9-]*:[A-Za-z0-9._/-]{1,256}$/.test(ref))) {
    throw new LocalReadBoundError('HARNESS_RUN_BINDING_INVALID');
  }
  const stopRequested = !!readHarnessStopIntent(root, runId);
  if (stopRequested && state.status === 'completed') throw new LocalReadBoundError('HARNESS_RUN_STOP_UNRESOLVED');
  return { taskId: binding.taskId, runId, status: state.status, acceptance: stopRequested ? 'indeterminate' : binding.acceptance,
    summary: stopRequested ? 'Stop requested; preserve evidence and reconcile without replay.' : binding.summary,
    evidenceRefs: [...binding.evidenceRefs], ...(stopRequested ? { stopRequested: true } : {}) };
}

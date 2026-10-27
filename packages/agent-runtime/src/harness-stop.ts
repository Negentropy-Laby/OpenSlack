import { closeSync, fsyncSync, linkSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readHarnessFile } from './harness-read.js';
import { validateRunId } from './run-id.js';
import type { AgentRunState } from './types.js';

export interface HarnessStopIntent {
  schema: 'openslack.harness_stop_intent.v1';
  runId: string;
  requestHash: string;
  ownerGeneration: string;
  reason: 'closing' | 'deadline' | 'confirmation_failed' | 'execution_failed' | 'persistence_failed';
  requestedAt: string;
}
function path(root: string, runId: string): string {
  validateRunId(runId);
  return join(root, '.openslack.local/agents/harness-admissions', `${runId}.stop.json`);
}

/** Bounded read-only stop fact; missing is not proof of quiescence or execution authority. */
export function readHarnessStopIntent(root: string, runId: string): HarnessStopIntent | null {
  let bytes: Buffer;
  try { bytes = readHarnessFile(path(root, runId), 4096); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error; }
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Harness stop fact is unreadable');
  const row = value as Record<string, unknown>;
  if (row.schema !== 'openslack.harness_stop_intent.v1' || row.runId !== runId ||
    typeof row.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.requestHash) ||
    typeof row.ownerGeneration !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(row.ownerGeneration) ||
    typeof row.requestedAt !== 'string' || !Number.isFinite(Date.parse(row.requestedAt)) ||
    !['closing', 'deadline', 'confirmation_failed', 'execution_failed', 'persistence_failed'].includes(String(row.reason))) {
    throw new Error('Harness stop fact is invalid; preserve and reconcile');
  }
  return row as unknown as HarnessStopIntent;
}

/** Publish once without the canonical state lock. Never claims a process has exited. */
export function publishHarnessStopIntent(root: string, intent: HarnessStopIntent): HarnessStopIntent {
  const target = path(root, intent.runId);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(intent)); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(temporary, target); }
  catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error; }
  unlinkSync(temporary);
  const observed = readHarnessStopIntent(root, intent.runId);
  if (!observed || observed.requestHash !== intent.requestHash || observed.ownerGeneration !== intent.ownerGeneration) {
    throw new Error('Harness stop fact binding changed; preserve and reconcile');
  }
  return observed;
}

export function assertHarnessNotStopped(root: string | undefined, state: Readonly<AgentRunState>): void {
  if (!state.harnessExecution) return;
  if (state.harnessExecution.stopRequestedAt || (root && readHarnessStopIntent(root, state.runId))) {
    throw new Error('Harness stop requested; preserve and reconcile without further effects');
  }
}

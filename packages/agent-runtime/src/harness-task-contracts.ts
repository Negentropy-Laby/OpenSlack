import { RUN_ID_RE } from './run-id.js';
import type { HarnessExecutionBinding } from './types.js';

export const HARNESS_REPORT_EVIDENCE_LIMIT = 32;
export const HARNESS_STATE_EVIDENCE_LIMIT = 128;
const sha256 = /^[a-f0-9]{64}$/;
const reference = /^[a-z][a-z0-9-]*:[A-Za-z0-9._/-]{1,256}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const acceptances = new Set(['pending', 'verified', 'rejected', 'indeterminate']);
const statuses = new Set(['pending', 'running', 'paused', 'completed', 'failed', 'cancelled']);

function row(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function references(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(ref => typeof ref === 'string' && reference.test(ref));
}

/** One report is bounded more tightly than the cumulative canonical history. */
export function assertHarnessTaskReport(value: unknown): void {
  if (!row(value) || Object.keys(value).sort().join(',') !== 'evidenceRefs,reportId,runId,summary' ||
    typeof value.runId !== 'string' || !RUN_ID_RE.test(value.runId) || typeof value.reportId !== 'string' || !identifier.test(value.reportId) ||
    typeof value.summary !== 'string' || Buffer.byteLength(value.summary) > 4096 || !references(value.evidenceRefs, HARNESS_REPORT_EVIDENCE_LIMIT)) {
    throw new TypeError('Invalid current-task report');
  }
}

/** Projection fields only: this does not turn historical state into execution authority. */
export function assertHarnessExecutionBinding(value: unknown, status: unknown): asserts value is Pick<HarnessExecutionBinding, 'schema' | 'taskId' | 'acceptance' | 'summary' | 'evidenceRefs'> {
  if (!row(value) || value.schema !== 'openslack.harness_execution.v1' ||
    typeof value.taskId !== 'string' || value.taskId.length > 128 ||
    typeof status !== 'string' || !statuses.has(status) || typeof value.acceptance !== 'string' || !acceptances.has(value.acceptance) ||
    (status === 'completed' && value.acceptance !== 'verified') || typeof value.summary !== 'string' || Buffer.byteLength(value.summary) > 4096 ||
    !references(value.evidenceRefs, HARNESS_STATE_EVIDENCE_LIMIT)) throw new TypeError('Invalid Harness execution binding');
}

/** Receipt bytes are historical material, not permission to complete a run. */
export function assertHarnessAcceptanceReceipt(value: unknown, runId: string, binding: HarnessExecutionBinding | undefined): void {
  if (!row(value) || Object.keys(value).sort().join(',') !== 'baseline,files,head,indexHash,observedAt,requestHash,runId,schema,taskId,toolEvidenceHash' ||
    !binding || value.schema !== 'openslack.harness_acceptance.v1' || value.runId !== runId || value.taskId !== binding.taskId ||
    value.requestHash !== binding.requestHash || value.baseline !== binding.baseline || value.head !== binding.baseline ||
    typeof value.indexHash !== 'string' || !sha256.test(value.indexHash) || typeof value.toolEvidenceHash !== 'string' || !sha256.test(value.toolEvidenceHash) ||
    typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt)) || !Array.isArray(value.files)) throw new TypeError('Invalid bound acceptance receipt');
  const paths = new Set<string>();
  for (const file of value.files) {
    if (!row(file) || Object.keys(file).sort().join(',') !== 'path,sha256' || typeof file.path !== 'string' ||
      !file.path || file.path.length > 4096 || file.path.includes('\\') || file.path.includes(':') ||
      file.path.split('/').some(part => !part || part === '.' || part === '..') || paths.has(file.path) ||
      typeof file.sha256 !== 'string' || !sha256.test(file.sha256)) throw new TypeError('Invalid bound acceptance file');
    paths.add(file.path);
  }
}

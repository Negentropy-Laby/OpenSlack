import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  WorkflowRunReadError,
  asWorkflowRunReadError,
  type WorkflowRunReadCode,
  type WorkflowRunReadDiagnostic,
} from '../workflow-run-read-errors.js';

/** Local projection bytes, independent of the 256 KiB authority-observation/argument contracts. */
export const WORKFLOW_LOCAL_EVIDENCE_MAX_BYTES = 2 * 1024 * 1024;
type ReadContext = Omit<WorkflowRunReadDiagnostic, 'code'>;

function failure(
  code: WorkflowRunReadCode,
  context: ReadContext,
  cause?: unknown,
): WorkflowRunReadError {
  return new WorkflowRunReadError([{ ...context, code }], { cause });
}

/** Historical evidence need not be owner-only, but cannot traverse a link or change identity. */
export async function assertWorkflowEvidencePath(
  path: string,
  context: ReadContext = { scope: 'workspace' },
): Promise<void> {
  const target = resolve(path);
  const components = [target];
  let current = target;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) break;
    components.push(parent);
    current = parent;
  }
  for (const component of components.reverse()) {
    const entry = await lstat(component);
    if (entry.isSymbolicLink() || (component !== target && !entry.isDirectory()))
      throw failure('WORKFLOW_RUN_EVIDENCE_PATH_INVALID', context);
  }
}

export async function readWorkflowEvidenceText(
  path: string,
  maxBytes = WORKFLOW_LOCAL_EVIDENCE_MAX_BYTES,
  context: ReadContext = { scope: 'workspace' },
): Promise<string> {
  try {
    await assertWorkflowEvidencePath(path, context);
    const entry = await lstat(path, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink())
      throw failure('WORKFLOW_RUN_EVIDENCE_PATH_INVALID', context);
    if (entry.size > BigInt(maxBytes)) throw failure('WORKFLOW_RUN_EVIDENCE_TOO_LARGE', context);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        entry.dev !== before.dev ||
        entry.ino !== before.ino ||
        entry.mode !== before.mode
      )
        throw failure('WORKFLOW_RUN_EVIDENCE_IO_FAILED', context);
      if (before.size > BigInt(maxBytes)) throw failure('WORKFLOW_RUN_EVIDENCE_TOO_LARGE', context);
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let count = 0;
      while (count < buffer.length) {
        const read = await handle.read(buffer, count, buffer.length - count, null);
        if (read.bytesRead === 0) break;
        count += read.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (count > maxBytes || after.size > BigInt(maxBytes))
        throw failure('WORKFLOW_RUN_EVIDENCE_TOO_LARGE', context);
      const current = await lstat(path, { bigint: true });
      await assertWorkflowEvidencePath(path, context);
      if (
        before.size !== BigInt(count) ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        before.mode !== after.mode ||
        before.dev !== current.dev ||
        before.ino !== current.ino ||
        current.isSymbolicLink()
      )
        throw failure('WORKFLOW_RUN_EVIDENCE_IO_FAILED', context);
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count));
      } catch (cause) {
        throw failure('WORKFLOW_RUN_EVIDENCE_INVALID', context, cause);
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Missing files remain distinguishable to callers with optional evidence.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw asWorkflowRunReadError(error, context);
  }
}

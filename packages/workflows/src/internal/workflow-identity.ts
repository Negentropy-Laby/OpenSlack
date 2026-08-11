import { createHash } from 'node:crypto';
import type { RunResult, WorkflowFormat, WorkflowMeta, WorkflowRuntime } from '../types.js';
import { canonicalJson } from './canonical-json.js';

export interface WorkflowIdentitySource {
  readonly meta: WorkflowMeta;
  readonly hash?: string;
  readonly format?: WorkflowFormat;
  readonly sourceBody?: string;
  readonly preview?: (ctx: WorkflowRuntime, args: Record<string, unknown>) => Promise<unknown>;
  readonly run?: (ctx: WorkflowRuntime, args: Record<string, unknown>) => Promise<RunResult>;
}

const SHA256 = /^[0-9a-f]{64}$/u;

/** Resolve the same strong executable identity for initialize, CLI, and worker resume paths. */
export function resolveWorkflowIdentityHash(
  workflow: WorkflowIdentitySource,
  manifest: WorkflowMeta = workflow.meta,
): string {
  if (workflow.hash !== undefined) {
    if (!SHA256.test(workflow.hash)) {
      throw new TypeError('Workflow identity hash must be a full lowercase SHA-256 digest.');
    }
    return workflow.hash;
  }
  if (workflow.sourceBody !== undefined) return sha256(workflow.sourceBody);

  const previewSource = functionSource(workflow.preview);
  const runSource = functionSource(workflow.run);
  if (previewSource === null && runSource === null) {
    throw new TypeError(
      'Workflow executable identity cannot be derived without source or functions.',
    );
  }
  return sha256(canonicalJson({ manifest, previewSource, runSource }));
}

export function hashWorkflowSource(source: string | Uint8Array): string {
  return sha256(source);
}

function functionSource(
  value: WorkflowIdentitySource['preview'] | WorkflowIdentitySource['run'],
): string | null {
  return value === undefined ? null : Function.prototype.toString.call(value);
}

function sha256(value: string | Uint8Array): string {
  const hash = createHash('sha256');
  if (typeof value === 'string') hash.update(value, 'utf8');
  else hash.update(value);
  return hash.digest('hex');
}

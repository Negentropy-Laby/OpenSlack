import {
  isWorkflowRunReadDiagnostic,
  isWorkflowRunReadProvenance,
  type WorkflowRunReadDiagnostic,
  type WorkflowRunReadProvenance,
} from '@openslack/workflows';
import { types as utilTypes } from 'node:util';

function ownValue(value: object, key: string): unknown {
  if (utilTypes.isProxy(value)) throw new TypeError('Unsafe workflow metadata object.');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !Object.hasOwn(descriptor, 'value'))
    throw new TypeError('Unsafe workflow metadata accessor.');
  return descriptor?.value;
}

interface WorkflowReadMetadata {
  provenance?: WorkflowRunReadProvenance;
  degraded?: boolean;
  readDiagnostics: WorkflowRunReadDiagnostic[];
}

/** Both projection boundaries retain typed provenance, but never exception causes or extra keys. */
export function workflowReadMetadata(value: unknown): WorkflowReadMetadata {
  if (!value || typeof value !== 'object') return { readDiagnostics: [] };
  const candidate = ownValue(value, 'provenance');
  const provenance = isWorkflowRunReadProvenance(candidate) ? candidate : undefined;
  const degraded = ownValue(value, 'degraded');
  const entries = ownValue(value, 'readDiagnostics');
  const diagnostics: WorkflowRunReadDiagnostic[] = [];
  if (Array.isArray(entries)) {
    ownValue(entries, 'length'); // Reject a proxy before enumerating its data properties.
    for (const key of Object.keys(entries)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) continue;
      const diagnostic = ownValue(entries, key);
      if (isWorkflowRunReadDiagnostic(diagnostic)) diagnostics.push(diagnostic);
    }
  }
  return {
    provenance: provenance
      ? {
          backend: provenance.backend,
          selection: provenance.selection,
          authorityVerified: false,
        }
      : undefined,
    degraded: typeof degraded === 'boolean' ? degraded : undefined,
    readDiagnostics: diagnostics.map((diagnostic) => ({
      scope: diagnostic.scope,
      code: diagnostic.code,
      ...(diagnostic.backend ? { backend: diagnostic.backend } : {}),
      ...(diagnostic.runId !== undefined ? { runId: diagnostic.runId } : {}),
    })),
  };
}

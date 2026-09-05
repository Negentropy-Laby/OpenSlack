export type WorkflowRunProjectionBackend = 'ts-local' | 'go';

const READ_MESSAGES = {
  WORKFLOW_PROGRESS_LOCAL_EVIDENCE_INVALID:
    'Workflow progress evidence is malformed or does not match the requested run.',
  WORKFLOW_RUN_PROJECTION_ID_INVALID:
    'The workflow run identifier is invalid for a local evidence path.',
  WORKFLOW_RUN_PROJECTION_MISSING: 'The requested local workflow evidence is missing.',
  WORKFLOW_RUN_EVIDENCE_RECONCILIATION_REQUIRED:
    'Local copies disagree about the workflow evidence source. Use runs inspect.',
  WORKFLOW_RUN_ROUTED_PROJECTION_MISSING:
    'The routed projection is missing; the displayed copy is comparison evidence only.',
  WORKFLOW_RUN_ROUTE_UNAVAILABLE:
    'The immutable route could not be read. Local files are comparison evidence only.',
  WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE:
    'The route journal failed its ownership or path checks. Use runs inspect.',
  WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED:
    'The route receipt requires reconciliation. Use runs inspect.',
  WORKFLOW_RUN_UNROUTED_GO_PROJECTION:
    'The Go recovery snapshot has no route receipt. Use runs inspect.',
  WORKFLOW_RUN_EVIDENCE_PERMISSION_DENIED:
    'Local workflow evidence could not be accessed. Check directory permissions.',
  WORKFLOW_RUN_EVIDENCE_PATH_INVALID: 'The workflow evidence path is not a safe directory or file.',
  WORKFLOW_RUN_EVIDENCE_INVALID: 'Local workflow evidence is malformed or belongs to another run.',
  WORKFLOW_RUN_EVIDENCE_TOO_LARGE: 'Local workflow evidence exceeds its byte limit.',
  WORKFLOW_RUN_EVIDENCE_IO_FAILED:
    'Local workflow evidence could not be read because of an I/O failure.',
  WORKFLOW_RUN_EVIDENCE_INTERNAL_ERROR: 'An unexpected workflow evidence reader failure occurred.',
} as const;

export type WorkflowRunReadCode = keyof typeof READ_MESSAGES;

export function isWorkflowRunProjectionId(runId: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(runId) &&
    (process.platform !== 'win32' || !runId.includes(':'))
  );
}

export interface WorkflowRunReadDiagnostic {
  readonly scope: 'workspace' | 'backend' | 'run';
  readonly runId?: string;
  readonly backend?: WorkflowRunProjectionBackend;
  readonly code: WorkflowRunReadCode;
}

export class WorkflowRunReadError extends Error {
  readonly code: WorkflowRunReadCode;
  constructor(readonly diagnostics: readonly WorkflowRunReadDiagnostic[]) {
    const code = diagnostics[0]?.code ?? 'WORKFLOW_RUN_EVIDENCE_INTERNAL_ERROR';
    super(`${code}: ${READ_MESSAGES[code]}`);
    this.name = 'WorkflowRunReadError';
    this.code = code;
  }
}

/** Classify only known error kinds; never expose exception messages or filesystem paths. */
export function workflowRunReadDiagnostic(
  error: unknown,
  context: Omit<WorkflowRunReadDiagnostic, 'code'>,
): WorkflowRunReadDiagnostic {
  const errno = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const code: WorkflowRunReadCode =
    errno === 'EACCES' || errno === 'EPERM'
      ? 'WORKFLOW_RUN_EVIDENCE_PERMISSION_DENIED'
      : errno === 'ENOTDIR' || errno === 'ELOOP'
        ? 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID'
        : error instanceof SyntaxError
          ? 'WORKFLOW_RUN_EVIDENCE_INVALID'
          : errno === 'ENOENT'
            ? 'WORKFLOW_RUN_PROJECTION_MISSING'
            : typeof errno === 'string' && /^E[A-Z]+$/u.test(errno)
              ? 'WORKFLOW_RUN_EVIDENCE_IO_FAILED'
              : 'WORKFLOW_RUN_EVIDENCE_INTERNAL_ERROR';
  return { ...context, code };
}

export function renderWorkflowRunReadDiagnostic(diagnostic: WorkflowRunReadDiagnostic): string {
  const target =
    diagnostic.scope === 'run'
      ? `Run ${JSON.stringify(diagnostic.runId)}`
      : diagnostic.backend
        ? `Backend ${diagnostic.backend}`
        : 'Workflow workspace';
  return `${target}: ${diagnostic.code}. ${READ_MESSAGES[diagnostic.code]}`;
}

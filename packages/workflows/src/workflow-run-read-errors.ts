import { types as utilTypes } from 'node:util';
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

/** Disposition and precedence describe the required response, never diagnostic insertion order. */
export const WORKFLOW_RUN_READ_POLICIES = {
  WORKFLOW_PROGRESS_LOCAL_EVIDENCE_INVALID: { status: 'blocked', precedence: 3 },
  WORKFLOW_RUN_PROJECTION_ID_INVALID: { status: 'failed', precedence: 0 },
  WORKFLOW_RUN_PROJECTION_MISSING: { status: 'blocked', precedence: 5 },
  WORKFLOW_RUN_EVIDENCE_RECONCILIATION_REQUIRED: { status: 'blocked', precedence: 1 },
  WORKFLOW_RUN_ROUTED_PROJECTION_MISSING: { status: 'blocked', precedence: 4 },
  WORKFLOW_RUN_ROUTE_UNAVAILABLE: { status: 'blocked', precedence: 4 },
  WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE: { status: 'blocked', precedence: 2 },
  WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED: { status: 'blocked', precedence: 1 },
  WORKFLOW_RUN_UNROUTED_GO_PROJECTION: { status: 'blocked', precedence: 4 },
  WORKFLOW_RUN_EVIDENCE_PERMISSION_DENIED: { status: 'blocked', precedence: 2 },
  WORKFLOW_RUN_EVIDENCE_PATH_INVALID: { status: 'blocked', precedence: 2 },
  WORKFLOW_RUN_EVIDENCE_INVALID: { status: 'blocked', precedence: 3 },
  WORKFLOW_RUN_EVIDENCE_TOO_LARGE: { status: 'blocked', precedence: 3 },
  WORKFLOW_RUN_EVIDENCE_IO_FAILED: { status: 'failed', precedence: 6 },
  WORKFLOW_RUN_EVIDENCE_INTERNAL_ERROR: { status: 'failed', precedence: 7 },
} as const satisfies Record<
  WorkflowRunReadCode,
  { status: 'blocked' | 'failed'; precedence: number }
>;

export interface WorkflowRunReadProvenance {
  readonly backend: WorkflowRunProjectionBackend;
  readonly selection: 'routed' | 'legacy' | 'comparison' | 'explicit';
  readonly authorityVerified: false;
}

function dataRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value))
    return null;
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value')) return null;
    result[key] = descriptor.value;
  }
  return result;
}

export function isWorkflowRunReadProvenance(value: unknown): value is WorkflowRunReadProvenance {
  const candidate = dataRecord(value);
  if (!candidate) return false;
  return (
    (candidate.backend === 'go' || candidate.backend === 'ts-local') &&
    typeof candidate.selection === 'string' &&
    ['routed', 'legacy', 'comparison', 'explicit'].includes(candidate.selection) &&
    candidate.authorityVerified === false
  );
}

export function isWorkflowRunReadDiagnostic(value: unknown): value is WorkflowRunReadDiagnostic {
  const diagnostic = dataRecord(value);
  if (!diagnostic) return false;
  return (
    typeof diagnostic.scope === 'string' &&
    ['workspace', 'backend', 'run'].includes(diagnostic.scope) &&
    typeof diagnostic.code === 'string' &&
    Object.hasOwn(READ_MESSAGES, diagnostic.code) &&
    (diagnostic.runId === undefined || typeof diagnostic.runId === 'string') &&
    (diagnostic.backend === undefined ||
      diagnostic.backend === 'go' ||
      diagnostic.backend === 'ts-local')
  );
}

export function primaryWorkflowRunReadCode(
  diagnostics: readonly WorkflowRunReadDiagnostic[],
): WorkflowRunReadCode {
  return (
    [...diagnostics].sort(
      (left, right) =>
        WORKFLOW_RUN_READ_POLICIES[left.code].precedence -
          WORKFLOW_RUN_READ_POLICIES[right.code].precedence || left.code.localeCompare(right.code),
    )[0]?.code ?? 'WORKFLOW_RUN_EVIDENCE_INTERNAL_ERROR'
  );
}

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
  readonly diagnostics: readonly WorkflowRunReadDiagnostic[];
  constructor(
    diagnostics: readonly WorkflowRunReadDiagnostic[],
    options: ErrorOptions & { primaryCode?: WorkflowRunReadCode } = {},
  ) {
    const code = options.primaryCode ?? primaryWorkflowRunReadCode(diagnostics);
    super(`${code}: ${READ_MESSAGES[code]}`, options);
    this.name = 'WorkflowRunReadError';
    this.code = code;
    this.diagnostics = Object.freeze(
      diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })),
    );
  }
}

/** Preserve an existing error's scope and internal cause; public callers serialize diagnostics only. */
export function asWorkflowRunReadError(
  error: unknown,
  context: Omit<WorkflowRunReadDiagnostic, 'code'>,
): WorkflowRunReadError {
  if (error instanceof WorkflowRunReadError) {
    if (
      !context.backend ||
      !error.diagnostics.some((item) => item.scope === 'run' && !item.backend)
    )
      return error;
    return new WorkflowRunReadError(
      error.diagnostics.map((item) =>
        item.scope === 'run' ? { backend: context.backend, ...item } : item,
      ),
      { cause: error, primaryCode: error.code },
    );
  }
  return new WorkflowRunReadError([workflowRunReadDiagnostic(error, context)], { cause: error });
}

/** Classify only known error kinds; never expose exception messages or filesystem paths. */
export function workflowRunReadDiagnostic(
  error: unknown,
  context: Omit<WorkflowRunReadDiagnostic, 'code'>,
): WorkflowRunReadDiagnostic {
  if (error instanceof WorkflowRunReadError)
    return {
      ...context,
      ...error.diagnostics.find((item) => item.code === error.code),
      code: error.code,
    };
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

export function renderWorkflowRunReadError(error: WorkflowRunReadError): string {
  return [
    error.message,
    ...error.diagnostics
      .filter((item) => item.code !== error.code)
      .map(renderWorkflowRunReadDiagnostic),
  ].join('\n');
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

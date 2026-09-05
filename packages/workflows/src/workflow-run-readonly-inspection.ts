import { resolve } from 'node:path';

import type { RunStatus } from './types.js';
import {
  isWorkflowControlAuthorityHeadBoundToRoute,
  type WorkflowControlAuthorityPort,
  type WorkflowControlAuthorityRunRead,
} from './workflow-control-authority-client.js';
import { openWorkflowRunReadOnly } from './workflow-run-projection.js';
import {
  createWorkflowRunRouteJournal,
  WorkflowRunRoutingError,
  type WorkflowRunRouteJournal,
  type WorkflowRunRouteJournalEntry,
} from './workflow-run-routing.js';

export const WORKFLOW_RUN_READONLY_INSPECTION_SCHEMA =
  'openslack.workflow_run_readonly_inspection.v1' as const;

export interface WorkflowRunReadOnlyLocalEvidence {
  readonly typescriptHistorical: RunStatus | null;
  readonly goRecovery: RunStatus | null;
}

export interface WorkflowRunReadOnlyInspection {
  readonly schema: typeof WORKFLOW_RUN_READONLY_INSPECTION_SCHEMA;
  readonly runId: string;
  readonly ownership:
    | 'typescript-historical'
    | 'go-workflow-control'
    | 'unrouted-recovery-projection'
    | 'unresolved-route';
  readonly disposition:
    | 'evidence-only'
    | 'authoritative-head'
    | 'authority-required'
    | 'reconciliation-required';
  readonly route: WorkflowRunRouteJournalEntry | null;
  readonly authorityHead: WorkflowControlAuthorityRunRead | null;
  readonly localEvidence: WorkflowRunReadOnlyLocalEvidence;
  readonly diagnostics: readonly string[];
}

export interface InspectWorkflowRunReadOnlyOptions {
  readonly rootDir?: string;
  readonly journal?: Pick<WorkflowRunRouteJournal, 'locateReadOnly'>;
  readonly authority?: WorkflowControlAuthorityPort;
}

interface LocalRead {
  readonly value: RunStatus | null;
  readonly diagnostic?: string;
}

async function readLocalEvidence(
  rootDir: string,
  runId: string,
): Promise<{
  readonly evidence: WorkflowRunReadOnlyLocalEvidence;
  readonly diagnostics: readonly string[];
}> {
  const read = async (backend: 'ts-local' | 'go'): Promise<LocalRead> => {
    try {
      return {
        value: await openWorkflowRunReadOnly(rootDir, backend).getRunStatus(runId),
      };
    } catch {
      return {
        value: null,
        diagnostic:
          backend === 'ts-local'
            ? 'TYPESCRIPT_HISTORICAL_EVIDENCE_UNREADABLE'
            : 'GO_RECOVERY_PROJECTION_UNREADABLE',
      };
    }
  };
  const [typescriptHistorical, goRecovery] = await Promise.all([read('ts-local'), read('go')]);
  return {
    evidence: {
      typescriptHistorical: typescriptHistorical.value,
      goRecovery: goRecovery.value,
    },
    diagnostics: [typescriptHistorical.diagnostic, goRecovery.diagnostic].filter(
      (value): value is string => value !== undefined,
    ),
  };
}

/**
 * Build a closed GS9-H inspection view. This function never initializes or
 * repairs route journals and never writes a RunStore projection. For Go-owned
 * records the durable Workflow Control head is the only authoritative state;
 * local files are returned solely as comparison evidence.
 */
export async function inspectWorkflowRunReadOnly(
  runId: string,
  options: InspectWorkflowRunReadOnlyOptions = {},
): Promise<WorkflowRunReadOnlyInspection | null> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const journal = options.journal ?? createWorkflowRunRouteJournal(rootDir);
  let route: WorkflowRunRouteJournalEntry | null = null;
  let routeDiagnostic: string | undefined;
  try {
    route = await journal.locateReadOnly(runId);
  } catch (error) {
    routeDiagnostic =
      error instanceof WorkflowRunRoutingError
        ? error.code
        : 'WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED';
  }
  const local = await readLocalEvidence(rootDir, runId);
  const localEvidence = local.evidence;

  if (routeDiagnostic) {
    return freezeInspection({
      runId,
      ownership: 'unresolved-route',
      disposition: 'reconciliation-required',
      route: null,
      authorityHead: null,
      localEvidence,
      diagnostics: [routeDiagnostic, ...local.diagnostics],
    });
  }

  if (!route) {
    if (local.diagnostics.length > 0) {
      return freezeInspection({
        runId,
        ownership: 'unresolved-route',
        disposition: 'reconciliation-required',
        route: null,
        authorityHead: null,
        localEvidence,
        diagnostics: local.diagnostics,
      });
    }
    if (localEvidence.typescriptHistorical && localEvidence.goRecovery) {
      return freezeInspection({
        runId,
        ownership: 'unresolved-route',
        disposition: 'reconciliation-required',
        route: null,
        authorityHead: null,
        localEvidence,
        diagnostics: [
          'UNROUTED_TYPESCRIPT_HISTORICAL_EVIDENCE',
          'GO_RECOVERY_PROJECTION_WITHOUT_ROUTE_RECEIPT',
          'AMBIGUOUS_UNROUTED_LOCAL_PROJECTIONS',
        ],
      });
    }
    if (localEvidence.typescriptHistorical) {
      return freezeInspection({
        runId,
        ownership: 'typescript-historical',
        disposition: 'evidence-only',
        route: null,
        authorityHead: null,
        localEvidence,
        diagnostics: ['UNROUTED_TYPESCRIPT_HISTORICAL_EVIDENCE'],
      });
    }
    if (localEvidence.goRecovery) {
      return freezeInspection({
        runId,
        ownership: 'unrouted-recovery-projection',
        disposition: 'reconciliation-required',
        route: null,
        authorityHead: null,
        localEvidence,
        diagnostics: ['GO_RECOVERY_PROJECTION_WITHOUT_ROUTE_RECEIPT'],
      });
    }
    return null;
  }

  const diagnostics = [...local.diagnostics];
  if (route.receipt.route.backend === 'ts-local') {
    if (localEvidence.goRecovery) {
      diagnostics.push('GO_RECOVERY_PROJECTION_WITH_TYPESCRIPT_ROUTE');
    }
    const typescriptUnreadable = local.diagnostics.includes(
      'TYPESCRIPT_HISTORICAL_EVIDENCE_UNREADABLE',
    );
    if (!localEvidence.typescriptHistorical && !typescriptUnreadable) {
      diagnostics.push('TYPESCRIPT_EVIDENCE_MISSING');
    }
    return freezeInspection({
      runId,
      ownership: 'typescript-historical',
      disposition: typescriptUnreadable ? 'reconciliation-required' : 'evidence-only',
      route,
      authorityHead: null,
      localEvidence,
      diagnostics,
    });
  }

  if (localEvidence.typescriptHistorical) {
    diagnostics.push('TYPESCRIPT_HISTORICAL_EVIDENCE_WITH_GO_ROUTE');
  }
  if (!options.authority) {
    return freezeInspection({
      runId,
      ownership: 'go-workflow-control',
      disposition: 'authority-required',
      route,
      authorityHead: null,
      localEvidence,
      diagnostics: ['GO_AUTHORITY_HEAD_REQUIRED', ...diagnostics],
    });
  }

  let head: WorkflowControlAuthorityRunRead | null;
  try {
    head = await options.authority.readIfExists(runId, route.receipt.route);
  } catch {
    return freezeInspection({
      runId,
      ownership: 'go-workflow-control',
      disposition: 'reconciliation-required',
      route,
      authorityHead: null,
      localEvidence,
      diagnostics: ['GO_AUTHORITY_HEAD_READ_FAILED', ...diagnostics],
    });
  }
  if (!head) {
    return freezeInspection({
      runId,
      ownership: 'go-workflow-control',
      disposition: 'reconciliation-required',
      route,
      authorityHead: null,
      localEvidence,
      diagnostics: ['GO_ROUTE_RECEIPT_WITHOUT_AUTHORITY_HEAD', ...diagnostics],
    });
  }

  if (!isWorkflowControlAuthorityHeadBoundToRoute(route.receipt, head)) {
    diagnostics.push('GO_AUTHORITY_HEAD_ROUTE_RECEIPT_DRIFT');
  }
  if (localEvidence.goRecovery && localEvidence.goRecovery.status !== head.state) {
    diagnostics.push('GO_LOCAL_RECOVERY_PROJECTION_STATE_DRIFT');
  }
  if (localEvidence.goRecovery && localEvidence.goRecovery.workflowName !== head.workflowId) {
    diagnostics.push('GO_LOCAL_RECOVERY_PROJECTION_IDENTITY_DRIFT');
  }
  return freezeInspection({
    runId,
    ownership: 'go-workflow-control',
    disposition: diagnostics.includes('GO_AUTHORITY_HEAD_ROUTE_RECEIPT_DRIFT')
      ? 'reconciliation-required'
      : 'authoritative-head',
    route,
    authorityHead: head,
    localEvidence,
    diagnostics,
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function freezeInspection(
  value: Omit<WorkflowRunReadOnlyInspection, 'schema' | 'diagnostics'> & {
    readonly diagnostics: readonly string[];
  },
): WorkflowRunReadOnlyInspection {
  return deepFreeze(
    structuredClone({
      schema: WORKFLOW_RUN_READONLY_INSPECTION_SCHEMA,
      ...value,
      diagnostics: [...value.diagnostics],
    }),
  );
}

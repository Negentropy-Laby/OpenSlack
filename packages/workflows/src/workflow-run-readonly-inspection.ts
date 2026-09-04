import { resolve } from 'node:path';

import type { RunStatus } from './types.js';
import type {
  WorkflowControlAuthorityPort,
  WorkflowControlAuthorityRunRead,
} from './workflow-control-authority-client.js';
import { createWorkflowRunProjectionStore } from './workflow-run-projection.js';
import {
  WorkflowRunRouteJournal,
  type WorkflowRunRouteJournalEntry,
} from './workflow-run-routing.js';

export const WORKFLOW_RUN_READONLY_INSPECTION_SCHEMA =
  'openslack.workflow_run_readonly_inspection.v1' as const;

export interface WorkflowRunReadOnlyInspection {
  readonly schema: typeof WORKFLOW_RUN_READONLY_INSPECTION_SCHEMA;
  readonly runId: string;
  readonly ownership:
    | 'typescript-historical'
    | 'go-workflow-control'
    | 'unrouted-recovery-projection';
  readonly disposition:
    | 'evidence-only'
    | 'authoritative-head'
    | 'authority-required'
    | 'reconciliation-required';
  readonly route: WorkflowRunRouteJournalEntry | null;
  readonly authorityHead: WorkflowControlAuthorityRunRead | null;
  readonly localEvidence: RunStatus | null;
  readonly diagnostics: readonly string[];
}

export interface InspectWorkflowRunReadOnlyOptions {
  readonly rootDir?: string;
  readonly journal?: Pick<WorkflowRunRouteJournal, 'locateReadOnly'>;
  readonly authority?: WorkflowControlAuthorityPort;
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
  const journal =
    options.journal ??
    new WorkflowRunRouteJournal(resolve(rootDir, '.openslack.local', 'workflows', 'routes'));
  const route = await journal.locateReadOnly(runId);
  if (!route) {
    const [legacy, orphanedGoProjection] = await Promise.all([
      createWorkflowRunProjectionStore(rootDir, 'ts-local').getRunStatus(runId),
      createWorkflowRunProjectionStore(rootDir, 'go').getRunStatus(runId),
    ]);
    if (legacy) {
      return freezeInspection({
        runId,
        ownership: 'typescript-historical',
        disposition: 'evidence-only',
        route: null,
        authorityHead: null,
        localEvidence: legacy,
        diagnostics: ['UNROUTED_TYPESCRIPT_HISTORICAL_EVIDENCE'],
      });
    }
    if (orphanedGoProjection) {
      return freezeInspection({
        runId,
        ownership: 'unrouted-recovery-projection',
        disposition: 'reconciliation-required',
        route: null,
        authorityHead: null,
        localEvidence: orphanedGoProjection,
        diagnostics: ['GO_RECOVERY_PROJECTION_WITHOUT_ROUTE_RECEIPT'],
      });
    }
    return null;
  }

  const localEvidence = await createWorkflowRunProjectionStore(
    rootDir,
    route.receipt.route.backend,
  ).getRunStatus(runId);
  if (route.receipt.route.backend === 'ts-local') {
    return freezeInspection({
      runId,
      ownership: 'typescript-historical',
      disposition: 'evidence-only',
      route,
      authorityHead: null,
      localEvidence,
      diagnostics: localEvidence ? [] : ['TYPESCRIPT_EVIDENCE_MISSING'],
    });
  }
  if (!options.authority) {
    return freezeInspection({
      runId,
      ownership: 'go-workflow-control',
      disposition: 'authority-required',
      route,
      authorityHead: null,
      localEvidence,
      diagnostics: ['GO_AUTHORITY_HEAD_REQUIRED'],
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
      diagnostics: ['GO_AUTHORITY_HEAD_READ_FAILED'],
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
      diagnostics: ['GO_ROUTE_RECEIPT_WITHOUT_AUTHORITY_HEAD'],
    });
  }

  const diagnostics: string[] = [];
  if (
    head.runId !== route.receipt.runId ||
    head.workspaceId !== route.receipt.workspaceId ||
    head.workflowId !== route.receipt.workflowId ||
    head.workflowVersion !== route.receipt.workflowVersion ||
    head.workflowSourceHash !== route.receipt.workflowSourceHash ||
    head.manifestHash !== route.receipt.manifestHash ||
    head.inputHash !== route.receipt.inputHash ||
    head.route.backend !== route.receipt.route.backend ||
    head.route.authority !== route.receipt.route.authority ||
    head.route.routingEpoch !== route.receipt.route.routingEpoch ||
    head.route.authorityBuildHash !== route.receipt.route.authorityBuildHash
  ) {
    diagnostics.push('GO_AUTHORITY_HEAD_ROUTE_RECEIPT_DRIFT');
  }
  if (localEvidence && localEvidence.status !== head.state) {
    diagnostics.push('GO_LOCAL_RECOVERY_PROJECTION_STATE_DRIFT');
  }
  if (localEvidence && localEvidence.workflowName !== head.workflowId) {
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

function freezeInspection(
  value: Omit<WorkflowRunReadOnlyInspection, 'schema' | 'diagnostics'> & {
    readonly diagnostics: readonly string[];
  },
): WorkflowRunReadOnlyInspection {
  return Object.freeze({
    schema: WORKFLOW_RUN_READONLY_INSPECTION_SCHEMA,
    ...value,
    diagnostics: Object.freeze([...value.diagnostics]),
  });
}

import { WORKFLOW_RUN_ID_REGEX } from './internal/workflow-run-identity.js';
import { canonicalWorkflowControlAuthorityJson as canonical } from './workflow-control-authority-contract.js';
import {
  validateWorkflowControlAuthorityRunRecord,
  type WorkflowControlAuthorityPort,
} from './workflow-control-authority-client.js';
import {
  createWorkflowRunRecoveryEvidenceClient,
  type WorkflowRunnerAuthorityBindingClientConfig,
} from './workflow-runner-authority-binding-client.js';
import {
  readRecoveryBinding,
  recoveryConflict,
  WorkflowRunRecoveryError,
  validateWorkflowRunRecoveryEvidence,
  type WorkflowRunRecoveryEvidencePort,
} from './workflow-run-recovery-evidence.js';
import {
  prepareWorkflowBindingReconciliation,
  parseWorkflowBindingReconciliation,
  parseWorkflowBindingSettlement,
  validateWorkflowBindingSettlement,
  workflowReconciliationHash,
  type WorkflowBindingSettlementReceipt,
} from './workflow-binding-reconciliation-contract.js';
import {
  cancelWorkflowRunnerResponseBody,
  readWorkflowRunnerResponseBytes,
  throwIfWorkflowRunnerAborted,
} from './workflow-runner-control-http.js';
import { createWorkflowRunRouteJournal } from './workflow-run-routing.js';

export interface WorkflowBindingReconciliationPreview {
  schema: 'openslack.workflow_runner_binding_reconciliation_preview.v1';
  workspaceId: string;
  runId: string;
  items: readonly {
    bindingId: string;
    stageHash: string;
    outcome: 'committed' | 'not_committed' | 'unknown';
    code: string;
    proofKind: string;
    receipt: string | null;
  }[];
  nextCursor: string | null;
}
export interface WorkflowBindingReconciliationPort {
  preview(
    runId: string,
    bindingId?: string,
    signal?: AbortSignal,
  ): Promise<WorkflowBindingReconciliationPreview>;
  apply(
    request: ReturnType<typeof prepareWorkflowBindingReconciliation>,
    signal?: AbortSignal,
  ): Promise<WorkflowBindingSettlementReceipt>;
  readReceipt(
    runId: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<WorkflowBindingSettlementReceipt | null>;
  pause(
    runId: string,
    expectedRevision: number,
    expectedRecordHash: string,
    signal?: AbortSignal,
  ): Promise<WorkflowRecoveryPauseReceipt>;
}

export interface WorkflowRecoveryPauseReceipt {
  schema: 'openslack.workflow_runner_recovery_pause_receipt.v1';
  workspaceId: string;
  runId: string;
  expectedRevision: number;
  acceptedRevision: number;
  resumeGeneration: number;
  priorRecordHash: string;
  record: string;
  recordHash: string;
  committedAt: string;
}

export function createWorkflowBindingReconciliationClient(
  config: WorkflowRunnerAuthorityBindingClientConfig,
): WorkflowBindingReconciliationPort {
  // Reuse the exact loopback, workspace, bearer and fetch configuration validation.
  createWorkflowRunRecoveryEvidenceClient(config);
  const fetch = config.fetch ?? globalThis.fetch;
  const headers = {
    Authorization: `Bearer ${config.bearerToken}`,
    'X-OpenSlack-Workspace-ID': config.workspaceId,
  };
  const base = (run: string) => {
    if (!WORKFLOW_RUN_ID_REGEX.test(run))
      return recoveryConflict('Reconciliation run ID is invalid.');
    return `${config.origin}/v2/runner/runs/${encodeURIComponent(run)}`;
  };
  const request = async (
    url: string,
    signal?: AbortSignal,
    body?: string,
    key?: string,
    missing = false,
  ): Promise<string | null> => {
    throwIfWorkflowRunnerAborted(signal);
    let response: Response;
    try {
      response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        signal,
        headers: {
          ...headers,
          ...(body === undefined
            ? {}
            : {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(body)),
                ...(key ? { 'Idempotency-Key': key } : {}),
              }),
        },
        ...(body === undefined ? {} : { body }),
      });
    } catch (cause) {
      throwIfWorkflowRunnerAborted(signal);
      throw new WorkflowRunRecoveryError(
        'WORKFLOW_RUN_RECOVERY_UNKNOWN',
        'Reconciliation transport failed; preserve the original operation.',
        { cause },
      );
    }
    if (missing && response.status === 404) {
      cancelWorkflowRunnerResponseBody(response);
      return null;
    }
    if (response.status !== 200) {
      cancelWorkflowRunnerResponseBody(response);
      throw new WorkflowRunRecoveryError(
        response.status === 429 || response.status >= 500
          ? 'WORKFLOW_RUN_RECOVERY_UNKNOWN'
          : 'WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED',
        `Reconciliation returned HTTP ${response.status}; refresh diagnostics before further action.`,
      );
    }
    const bytes = await readWorkflowRunnerResponseBytes(response, {
      maxBytes: 2 * 1024 * 1024,
      minimumBytes: 1,
      validateContentLength: true,
      signal,
      failure: (_message, options) => {
        throw new WorkflowRunRecoveryError(
          options.kind === 'transport'
            ? 'WORKFLOW_RUN_RECOVERY_UNKNOWN'
            : 'WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED',
          'Reconciliation response is incomplete or invalid.',
          options,
        );
      },
      messages: {
        contentType: 'invalid type',
        contentLength: 'invalid length',
        missingBody: 'missing body',
        readFailed: 'read failed',
        exceeded: 'limit exceeded',
        empty: 'empty body',
        lengthMismatch: 'length mismatch',
        aborted: 'cancelled',
      },
    });
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new WorkflowRunRecoveryError(
        'WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED',
        'Reconciliation response is not valid UTF-8.',
        { cause },
      );
    }
  };
  const client: WorkflowBindingReconciliationPort = {
    async preview(runId, bindingId, signal) {
      if (bindingId !== undefined && !/^WFRUNNER-BINDING-[0-9a-f]{64}$/u.test(bindingId))
        return recoveryConflict('Binding ID is invalid.');
      let cursor: string | null = null;
      const items: WorkflowBindingReconciliationPreview['items'][number][] = [];
      do {
        const query = new URLSearchParams();
        if (bindingId) query.set('bindingId', bindingId);
        if (cursor) query.set('afterBindingId', cursor);
        const raw = (await request(
          `${base(runId)}/binding-reconciliation${query.size ? `?${query}` : ''}`,
          signal,
        ))!;
        let view: WorkflowBindingReconciliationPreview;
        try {
          view = JSON.parse(raw);
          if (
            canonical(view) + '\n' !== raw ||
            Object.keys(view).sort().join(',') !==
              ['schema', 'workspaceId', 'runId', 'items', 'nextCursor'].sort().join(',') ||
            view.schema !== 'openslack.workflow_runner_binding_reconciliation_preview.v1' ||
            view.workspaceId !== config.workspaceId ||
            view.runId !== runId ||
            !Array.isArray(view.items)
          )
            throw new Error();
          for (const item of view.items) {
            if (
              Object.keys(item).sort().join(',') !==
                ['bindingId', 'stageHash', 'outcome', 'code', 'proofKind', 'receipt']
                  .sort()
                  .join(',') ||
              !/^WFRUNNER-BINDING-[0-9a-f]{64}$/u.test(item.bindingId) ||
              !/^[0-9a-f]{64}$/u.test(item.stageHash) ||
              !['committed', 'not_committed', 'unknown'].includes(item.outcome) ||
              ![
                'WORKFLOW_RUNNER_BINDING_SETTLED',
                'WORKFLOW_RUNNER_BINDING_RECONCILABLE',
                'WORKFLOW_RUNNER_RECONCILIATION_REQUIRED',
              ].includes(item.code) ||
              ![
                '',
                'resolution',
                'source_receipt',
                'source_fence',
                'budget_source_result',
              ].includes(item.proofKind) ||
              (item.receipt !== null && typeof item.receipt !== 'string') ||
              (bindingId && item.bindingId !== bindingId) ||
              (items.length && item.bindingId <= items.at(-1)!.bindingId)
            )
              throw new Error();
            items.push(item);
          }
          if (
            view.nextCursor !== null &&
            (view.nextCursor !== items.at(-1)?.bindingId ||
              view.nextCursor === cursor ||
              bindingId !== undefined)
          )
            throw new Error();
        } catch (cause) {
          throw new WorkflowRunRecoveryError(
            'WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED',
            'Reconciliation preview contract is invalid.',
            { cause },
          );
        }
        cursor = view.nextCursor;
      } while (cursor);
      return {
        schema: 'openslack.workflow_runner_binding_reconciliation_preview.v1',
        workspaceId: config.workspaceId,
        runId,
        items,
        nextCursor: null,
      };
    },
    async apply(prepared, signal) {
      try {
        const checked = parseWorkflowBindingReconciliation(prepared.body);
        if (
          canonical(checked) !== canonical(prepared) ||
          checked.value.workspaceId !== config.workspaceId
        )
          throw new Error();
      } catch (cause) {
        throw new WorkflowRunRecoveryError(
          'WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED',
          'Reconciliation request identity or exact bytes differ.',
          { cause },
        );
      }
      const raw = await request(
        `${base(prepared.value.runId)}/binding-reconciliation`,
        signal,
        prepared.body,
        prepared.idempotencyKey,
      );
      try {
        const receipt = parseWorkflowBindingSettlement(raw!);
        if (receipt.idempotencyKey !== prepared.idempotencyKey) throw new Error();
        return receipt;
      } catch (cause) {
        throw new WorkflowRunRecoveryError(
          'WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED',
          'Settlement response does not match its request.',
          { cause },
        );
      }
    },
    async readReceipt(runId, key, signal) {
      if (!/^openslack\.workflow-runner-reconciliation\.v1\.[0-9a-f]{64}$/u.test(key))
        return recoveryConflict('Settlement receipt key is invalid.');
      const raw = await request(
        `${base(runId)}/binding-reconciliation/receipts/${encodeURIComponent(key)}`,
        signal,
        undefined,
        undefined,
        true,
      );
      if (raw === null) return null;
      try {
        const receipt = parseWorkflowBindingSettlement(raw);
        if (
          receipt.idempotencyKey !== key ||
          receipt.runId !== runId ||
          receipt.workspaceId !== config.workspaceId
        )
          throw new Error();
        return receipt;
      } catch (cause) {
        throw new WorkflowRunRecoveryError(
          'WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED',
          'Exact settlement receipt is invalid.',
          { cause },
        );
      }
    },
    async pause(runId, expectedRevision, expectedRecordHash, signal) {
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 1 ||
        expectedRevision >= Number.MAX_SAFE_INTEGER ||
        !/^[0-9a-f]{64}$/u.test(expectedRecordHash)
      )
        return recoveryConflict('Recovery pause expected head is invalid.');
      const body =
        canonical({
          schema: 'openslack.workflow_runner_recovery_pause.v1',
          workspaceId: config.workspaceId,
          runId,
          expectedRevision,
          expectedRecordHash,
        }) + '\n';
      const raw = (await request(`${base(runId)}/recovery-pause`, signal, body))!;
      try {
        const value: WorkflowRecoveryPauseReceipt = JSON.parse(raw);
        if (
          Object.keys(value).sort().join(',') !==
            [
              'schema',
              'workspaceId',
              'runId',
              'expectedRevision',
              'acceptedRevision',
              'resumeGeneration',
              'priorRecordHash',
              'record',
              'recordHash',
              'committedAt',
            ]
              .sort()
              .join(',') ||
          canonical(value) + '\n' !== raw ||
          value.schema !== 'openslack.workflow_runner_recovery_pause_receipt.v1' ||
          value.workspaceId !== config.workspaceId ||
          value.runId !== runId ||
          value.expectedRevision !== expectedRevision ||
          value.acceptedRevision !== expectedRevision + 1 ||
          value.priorRecordHash !== expectedRecordHash ||
          typeof value.record !== 'string' ||
          workflowReconciliationHash(value.record) !== value.recordHash ||
          new Date(value.committedAt).toISOString() !== value.committedAt
        )
          throw new Error();
        const record = validateWorkflowControlAuthorityRunRecord(JSON.parse(value.record));
        if (
          canonical(record) + '\n' !== value.record ||
          record.workspaceId !== config.workspaceId ||
          record.runId !== runId ||
          record.state !== 'paused' ||
          record.revision !== value.acceptedRevision ||
          record.resumeGeneration !== value.resumeGeneration
        )
          throw new Error();
        return value;
      } catch (cause) {
        throw new WorkflowRunRecoveryError(
          'WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED',
          'Recovery pause receipt is invalid.',
          { cause },
        );
      }
    },
  };
  return Object.freeze(client);
}

export interface WorkflowBindingReconciliationReport {
  schema: 'openslack.workflow_runner_binding_reconciliation_report.v1';
  runId: string;
  applied: boolean;
  paused: boolean;
  preview: WorkflowBindingReconciliationPreview | null;
  settled: WorkflowBindingSettlementReceipt[];
  diagnostics: string[];
}

export async function reconcileWorkflowBindings(
  runId: string,
  options: {
    rootDir: string;
    bindingId?: string;
    apply?: boolean;
    signal?: AbortSignal;
    authority: WorkflowControlAuthorityPort;
    recovery: WorkflowRunRecoveryEvidencePort;
    reconciliation: WorkflowBindingReconciliationPort;
  },
): Promise<WorkflowBindingReconciliationReport> {
  const report: WorkflowBindingReconciliationReport = {
    schema: 'openslack.workflow_runner_binding_reconciliation_report.v1',
    runId,
    applied: false,
    paused: false,
    preview: null,
    settled: [],
    diagnostics: [],
  };
  try {
    throwIfWorkflowRunnerAborted(options.signal);
    const route = await createWorkflowRunRouteJournal(options.rootDir).locateReadOnly(runId);
    if (!route || route.receipt.route.backend !== 'go')
      return recoveryConflict('Binding reconciliation requires a routed Go run.');
    const proof = await options.recovery.readRecoveryEvidence(runId, undefined, options.signal);
    validateWorkflowRunRecoveryEvidence(proof);
    if (
      !proof.complete ||
      proof.schema === 'openslack.workflow_runner_recovery_evidence.v1' ||
      proof.runId !== runId ||
      proof.workspaceId !== route.receipt.workspaceId ||
      canonical(proof.route) !== canonical(route.receipt.route)
    )
      return recoveryConflict('Binding reconciliation requires recovery v2 on the exact Go route.');
    report.preview = await options.reconciliation.preview(runId, options.bindingId, options.signal);
    if (!options.apply) return report;
    for (const item of report.preview.items) {
      if (item.outcome === 'unknown') {
        report.diagnostics.push(`${item.bindingId}:WORKFLOW_RUNNER_RECONCILIATION_REQUIRED`);
        continue;
      }
      const entry = proof.bindings.find((value) => value.bindingId === item.bindingId);
      if (!entry)
        return recoveryConflict(
          'Preview binding was not present in the verified recovery evidence.',
        );
      const { stage } = readRecoveryBinding(proof, entry);
      const prepared = prepareWorkflowBindingReconciliation(stage, item.outcome);
      if (prepared.value.stageHash !== item.stageHash)
        return recoveryConflict('Binding changed after reconciliation preview.');
      let receipt = item.receipt
        ? parseWorkflowBindingSettlement(item.receipt)
        : await options.reconciliation.readReceipt(runId, prepared.idempotencyKey, options.signal);
      if (!receipt) {
        try {
          receipt = await options.reconciliation.apply(prepared, options.signal);
        } catch (error) {
          if (
            !(error instanceof WorkflowRunRecoveryError) ||
            error.code !== 'WORKFLOW_RUN_RECOVERY_UNKNOWN'
          )
            throw error;
          receipt = await options.reconciliation.readReceipt(
            runId,
            prepared.idempotencyKey,
            options.signal,
          );
          if (!receipt) throw error;
        }
      }
      validateWorkflowBindingSettlement(receipt, stage, entry.resolution);
      report.settled.push(receipt);
    }
    const fresh = await options.recovery.readRecoveryEvidence(runId, undefined, options.signal);
    validateWorkflowRunRecoveryEvidence(fresh);
    if (
      !fresh.complete ||
      fresh.schema === 'openslack.workflow_runner_recovery_evidence.v1' ||
      fresh.runId !== runId ||
      fresh.workspaceId !== proof.workspaceId ||
      canonical(fresh.route) !== canonical(proof.route)
    )
      return recoveryConflict('Recovery identity changed before whole-run convergence.');
    if (fresh.activeAttempts.length || fresh.unfinished.length) {
      report.diagnostics.push('WORKFLOW_RUNNER_RECONCILIATION_REQUIRED');
      return report;
    }
    const head = await options.authority.read(runId, route.receipt.route, options.signal);
    if (
      head.workspaceId !== proof.workspaceId ||
      head.runId !== runId ||
      canonical(head.record.route) !== canonical(proof.route)
    )
      return recoveryConflict('Current authority head differs from the reconciled run.');
    if (head.state === 'running' || head.state === 'resuming') {
      const receipt = await options.reconciliation.pause(
        runId,
        head.revision,
        head.recordHash,
        options.signal,
      );
      if (
        receipt.record !==
        canonical({ ...head.record, state: 'paused', revision: head.revision + 1 }) + '\n'
      )
        return recoveryConflict(
          'Recovery pause changed the original authority identity or progress.',
        );
      report.paused = true;
    }
    report.applied = report.diagnostics.length === 0;
    return report;
  } catch (error) {
    report.diagnostics.push(
      options.signal?.aborted
        ? 'WORKFLOW_RUNNER_OPERATION_CANCELLED'
        : error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : 'WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED',
    );
    return report;
  }
}

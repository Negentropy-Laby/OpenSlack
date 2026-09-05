import {
  canonicalWorkflowBudgetAuthorityJson,
  deriveWorkflowBudgetLedgerEntry,
  hashWorkflowBudgetAuthorityValue,
  parseWorkflowBudgetAuthorityBytes,
  validateWorkflowBudgetAccount,
  validateWorkflowBudgetPreparedRequest,
  validateWorkflowBudgetReceiptForRequest,
  validateWorkflowBudgetReceiptForResult,
  validateWorkflowBudgetReconciliation,
  validateWorkflowBudgetReserveDecision,
  validateWorkflowBudgetSettlement,
  type WorkflowBudgetAccount,
  type WorkflowBudgetPreparedRequest,
  type WorkflowBudgetReceipt,
  type WorkflowBudgetRoute,
} from './workflow-budget-authority-contract.js';
import {
  WORKFLOW_RUNNER_BUDGET_SOURCE_RESULT_SCHEMA,
  validateWorkflowRunnerBudgetSourceResult,
  type WorkflowRunnerBudgetSourceResult,
} from './workflow-runner-authority-binding-contract.js';
import { isAcceptedWorkflowBudgetManifest } from './internal/workflow-budget-compatibility.generated.js';
import {
  cancelWorkflowRunnerResponseBody,
  readWorkflowRunnerResponseBytes,
} from './workflow-runner-control-http.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const RESPONSE_SCHEMA = 'openslack.workflow_control_budget_mutation_response.v1';
const DURABLE_SCHEMA = 'openslack.workflow_control_budget_durable_record.v1';
const DURABLE_WRITER = 'workflow-control/budget-authority-server';

type Data = Record<string, unknown>;

export class WorkflowRunnerBudgetAuthorityClientError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_RUNNER_BUDGET_AUTHORITY_TRANSPORT_FAILED'
      | 'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RESPONSE_INVALID'
      | 'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RECONCILIATION_REQUIRED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkflowRunnerBudgetAuthorityClientError';
  }
}

function data(value: unknown, fields: readonly string[], label: string): Data {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new WorkflowRunnerBudgetAuthorityClientError(
      'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RESPONSE_INVALID',
      `${label} must be an inert object.`,
    );
  }
  const record = value as Data;
  const keys = Object.keys(record).sort();
  if (
    canonicalWorkflowBudgetAuthorityJson(keys) !==
    canonicalWorkflowBudgetAuthorityJson([...fields].sort())
  ) {
    throw new WorkflowRunnerBudgetAuthorityClientError(
      'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RESPONSE_INVALID',
      `${label} fields are invalid.`,
    );
  }
  return record;
}

function durable(
  value: unknown,
  kind: string,
  buildHash: string,
): {
  readonly value: Data;
  readonly projection: unknown;
  readonly exactBytes: string;
} {
  const record = data(
    value,
    [
      'schema',
      'authority',
      'writer',
      'authorityMode',
      'productionAuthority',
      'contractManifestSha256',
      'authorityBuildHash',
      'recordKind',
      'operationalProjection',
      'operationalProjectionHash',
    ],
    'Durable budget record',
  );
  const projection = record.operationalProjection;
  const domain =
    kind === 'account'
      ? 'account'
      : kind === 'reserve_decision'
        ? 'reserve-decision'
        : kind === 'settlement'
          ? 'settlement'
          : kind === 'receipt'
            ? 'receipt'
            : kind === 'reconciliation'
              ? 'reconciliation'
              : '';
  if (
    !domain ||
    record.schema !== DURABLE_SCHEMA ||
    record.authority !== 'workflow-control' ||
    record.writer !== DURABLE_WRITER ||
    record.authorityMode !== 'local-qualification-v1' ||
    record.productionAuthority !== false ||
    !isAcceptedWorkflowBudgetManifest(record.contractManifestSha256) ||
    record.authorityBuildHash !== buildHash ||
    typeof projection !== 'object' ||
    projection === null ||
    (kind === 'receipt' &&
      (projection as { readonly serviceBuildHash?: unknown }).serviceBuildHash !==
        record.authorityBuildHash) ||
    record.recordKind !== kind ||
    record.operationalProjectionHash !== hashWorkflowBudgetAuthorityValue(domain, projection)
  ) {
    throw new WorkflowRunnerBudgetAuthorityClientError(
      'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RESPONSE_INVALID',
      'Durable budget record binding is invalid.',
    );
  }
  return Object.freeze({
    value: record,
    projection,
    exactBytes: canonicalWorkflowBudgetAuthorityJson(record),
  });
}

export interface WorkflowRunnerBudgetMutationResult {
  readonly receipt: WorkflowBudgetReceipt;
  readonly sourceResult?: WorkflowRunnerBudgetSourceResult;
}

function decodeMutationResponse(
  exactBytes: string,
  preparedValue: WorkflowBudgetPreparedRequest,
): WorkflowRunnerBudgetMutationResult {
  if (
    Buffer.byteLength(exactBytes, 'utf8') > MAX_RESPONSE_BYTES ||
    !exactBytes.endsWith('\n') ||
    exactBytes.endsWith('\n\n')
  ) {
    throw new WorkflowRunnerBudgetAuthorityClientError(
      'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RESPONSE_INVALID',
      'Budget mutation response framing is invalid.',
    );
  }
  const prepared = validateWorkflowBudgetPreparedRequest(preparedValue);
  const request = parseWorkflowBudgetAuthorityBytes(Buffer.from(prepared.body, 'utf8')) as {
    readonly route: { readonly authorityBuildHash: string };
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(exactBytes);
  } catch (error) {
    throw new WorkflowRunnerBudgetAuthorityClientError(
      'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RESPONSE_INVALID',
      'Budget mutation response is not JSON.',
      { cause: error },
    );
  }
  const response = data(
    parsed,
    ['schema', 'operation', 'record', 'receipt', 'reconciliation'],
    'Budget mutation response',
  );
  if (
    response.schema !== RESPONSE_SCHEMA ||
    response.operation !== prepared.operation ||
    `${canonicalWorkflowBudgetAuthorityJson(response)}\n` !== exactBytes
  ) {
    throw new WorkflowRunnerBudgetAuthorityClientError(
      'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RESPONSE_INVALID',
      'Budget mutation response canonical identity is invalid.',
    );
  }
  const buildHash = request.route.authorityBuildHash;
  if (!HASH.test(buildHash)) {
    throw new WorkflowRunnerBudgetAuthorityClientError(
      'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RESPONSE_INVALID',
      'Budget request build identity is invalid.',
    );
  }
  const receiptOuter = durable(response.receipt, 'receipt', buildHash);
  const receipt = validateWorkflowBudgetReceiptForRequest(receiptOuter.projection, prepared);
  if (receipt.status === 'database_reconciliation_required' || response.record === null) {
    throw new WorkflowRunnerBudgetAuthorityClientError(
      'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RECONCILIATION_REQUIRED',
      'Budget database outcome requires reconciliation.',
    );
  }
  const recordOuter = durable(
    response.record,
    prepared.operation === 'reserve' ? 'reserve_decision' : 'settlement',
    buildHash,
  );
  if (prepared.operation === 'reserve') {
    const decision = validateWorkflowBudgetReserveDecision(recordOuter.projection);
    const ledger = deriveWorkflowBudgetLedgerEntry(decision);
    validateWorkflowBudgetReceiptForResult(receipt, prepared, decision, ledger, null);
    return Object.freeze({
      receipt,
      sourceResult: validateWorkflowRunnerBudgetSourceResult(
        {
          schema: WORKFLOW_RUNNER_BUDGET_SOURCE_RESULT_SCHEMA,
          durableReceiptBytes: receiptOuter.exactBytes,
          decision,
          ledgerEntry: ledger,
        },
        prepared,
      ),
    });
  }
  const settlement = validateWorkflowBudgetSettlement(recordOuter.projection);
  const ledger = deriveWorkflowBudgetLedgerEntry(settlement);
  const reconciliation =
    response.reconciliation === null
      ? null
      : validateWorkflowBudgetReconciliation(
          durable(response.reconciliation, 'reconciliation', buildHash).projection,
        );
  validateWorkflowBudgetReceiptForResult(receipt, prepared, settlement, ledger, reconciliation);
  if (settlement.status !== 'settled' || receipt.status !== 'accepted' || reconciliation !== null) {
    throw new WorkflowRunnerBudgetAuthorityClientError(
      'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RECONCILIATION_REQUIRED',
      'Budget settlement requires provider reconciliation and cannot release its staged event.',
    );
  }
  return Object.freeze({ receipt });
}

async function exactBody(response: Response, signal?: AbortSignal): Promise<string> {
  const bytes = await readWorkflowRunnerResponseBytes(response, {
    maxBytes: MAX_RESPONSE_BYTES,
    signal,
    validateContentLength: true,
    minimumBytes: 2,
    failure: (message, options) => {
      throw new WorkflowRunnerBudgetAuthorityClientError(
        message === 'Budget authority response body could not be read.' ||
          message === 'Budget authority response read was aborted.'
          ? 'WORKFLOW_RUNNER_BUDGET_AUTHORITY_TRANSPORT_FAILED'
          : 'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RESPONSE_INVALID',
        message,
        options,
      );
    },
    messages: {
      contentType: 'Budget authority response content type is invalid.',
      contentLength: 'Budget authority response content length is invalid.',
      missingBody: 'Budget authority response body is missing.',
      readFailed: 'Budget authority response body could not be read.',
      exceeded: 'Budget authority response exceeds its byte limit.',
      empty: 'Budget authority response body is empty.',
      lengthMismatch: 'Budget authority response body length is inconsistent.',
      aborted: 'Budget authority response read was aborted.',
    },
  });
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new WorkflowRunnerBudgetAuthorityClientError(
      'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RESPONSE_INVALID',
      'Budget authority response is not valid UTF-8.',
      { cause: error },
    );
  }
}

export interface WorkflowRunnerBudgetAuthorityClient {
  mutate(
    prepared: WorkflowBudgetPreparedRequest,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerBudgetMutationResult>;
  pointRead(
    prepared: WorkflowBudgetPreparedRequest,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerBudgetMutationResult | null>;
  readAccount(
    runId: string,
    route: WorkflowBudgetRoute,
    signal?: AbortSignal,
  ): Promise<WorkflowBudgetAccount | null>;
}

export function createWorkflowRunnerBudgetAuthorityClient(config: {
  readonly origin: string;
  readonly workspaceId: string;
  readonly bearerToken: string;
  readonly callerId: string;
  readonly fetch?: typeof fetch;
}): WorkflowRunnerBudgetAuthorityClient {
  const send = config.fetch ?? fetch;
  const request = async (
    preparedValue: WorkflowBudgetPreparedRequest,
    method: 'GET' | 'POST',
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerBudgetMutationResult | null> => {
    const prepared = validateWorkflowBudgetPreparedRequest(preparedValue);
    const parsed = parseWorkflowBudgetAuthorityBytes(Buffer.from(prepared.body, 'utf8')) as {
      readonly workspaceId: string;
      readonly route: { readonly routingEpoch: number; readonly authorityBuildHash: string };
    };
    if (parsed.workspaceId !== config.workspaceId) {
      throw new WorkflowRunnerBudgetAuthorityClientError(
        'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RESPONSE_INVALID',
        'Budget prepared request workspace differs from the sealed client.',
      );
    }
    const url =
      method === 'POST'
        ? `${config.origin}${prepared.path}`
        : `${config.origin}/v1/authority/workflow-budgets/receipts/${encodeURIComponent(prepared.idempotencyKey)}`;
    let response: Response;
    try {
      response = await send(url, {
        method,
        headers: {
          Authorization: `Bearer ${config.bearerToken}`,
          'X-OpenSlack-Workflow-Budget-Caller-ID': config.callerId,
          'X-OpenSlack-Workflow-Budget-Workspace-ID': config.workspaceId,
          'X-OpenSlack-Workflow-Budget-Routing-Epoch': String(parsed.route.routingEpoch),
          'X-OpenSlack-Workflow-Budget-Expected-Build-SHA': parsed.route.authorityBuildHash,
          ...(method === 'POST'
            ? {
                'Content-Type': 'application/json',
                'Idempotency-Key': prepared.idempotencyKey,
                'X-OpenSlack-Request-Fingerprint': prepared.requestFingerprint,
              }
            : {}),
        },
        ...(method === 'POST' ? { body: prepared.body } : {}),
        signal,
      });
    } catch (error) {
      throw new WorkflowRunnerBudgetAuthorityClientError(
        'WORKFLOW_RUNNER_BUDGET_AUTHORITY_TRANSPORT_FAILED',
        'Budget authority transport failed.',
        { cause: error },
      );
    }
    if (method === 'GET' && response.status === 404) {
      await cancelWorkflowRunnerResponseBody(response);
      return null;
    }
    if (![200, 201, 202].includes(response.status)) {
      await cancelWorkflowRunnerResponseBody(response);
      throw new WorkflowRunnerBudgetAuthorityClientError(
        response.status === 429 || response.status >= 500
          ? 'WORKFLOW_RUNNER_BUDGET_AUTHORITY_TRANSPORT_FAILED'
          : 'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RESPONSE_INVALID',
        `Budget authority returned HTTP ${response.status}.`,
      );
    }
    return decodeMutationResponse(await exactBody(response, signal), prepared);
  };
  return Object.freeze({
    async mutate(prepared: WorkflowBudgetPreparedRequest, signal?: AbortSignal) {
      return (await request(prepared, 'POST', signal))!;
    },
    pointRead: (prepared: WorkflowBudgetPreparedRequest, signal?: AbortSignal) =>
      request(prepared, 'GET', signal),
    async readAccount(runId: string, route: WorkflowBudgetRoute, signal?: AbortSignal) {
      if (
        !SAFE_ID.test(runId) ||
        route.backend !== 'go' ||
        route.authority !== 'workflow-control'
      ) {
        throw new WorkflowRunnerBudgetAuthorityClientError(
          'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RESPONSE_INVALID',
          'Budget account point-read identity or route is invalid.',
        );
      }
      let response: Response;
      try {
        response = await send(
          `${config.origin}/v1/authority/workflow-budgets/runs/${encodeURIComponent(runId)}/account`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${config.bearerToken}`,
              'X-OpenSlack-Workflow-Budget-Caller-ID': config.callerId,
              'X-OpenSlack-Workflow-Budget-Workspace-ID': config.workspaceId,
              'X-OpenSlack-Workflow-Budget-Routing-Epoch': String(route.routingEpoch),
              'X-OpenSlack-Workflow-Budget-Expected-Build-SHA': route.authorityBuildHash,
            },
            signal,
          },
        );
      } catch (error) {
        throw new WorkflowRunnerBudgetAuthorityClientError(
          'WORKFLOW_RUNNER_BUDGET_AUTHORITY_TRANSPORT_FAILED',
          'Budget account point-read transport failed.',
          { cause: error },
        );
      }
      if (response.status === 404) {
        await cancelWorkflowRunnerResponseBody(response);
        return null;
      }
      if (response.status !== 200) {
        await cancelWorkflowRunnerResponseBody(response);
        throw new WorkflowRunnerBudgetAuthorityClientError(
          response.status === 429 || response.status >= 500
            ? 'WORKFLOW_RUNNER_BUDGET_AUTHORITY_TRANSPORT_FAILED'
            : 'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RESPONSE_INVALID',
          `Budget account point-read returned HTTP ${response.status}.`,
        );
      }
      const exactBytes = await exactBody(response, signal);
      if (!exactBytes.endsWith('\n') || exactBytes.endsWith('\n\n')) {
        throw new WorkflowRunnerBudgetAuthorityClientError(
          'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RESPONSE_INVALID',
          'Budget account point-read framing is invalid.',
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(exactBytes);
      } catch (error) {
        throw new WorkflowRunnerBudgetAuthorityClientError(
          'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RESPONSE_INVALID',
          'Budget account point-read is not JSON.',
          { cause: error },
        );
      }
      const outer = durable(parsed, 'account', route.authorityBuildHash);
      if (`${canonicalWorkflowBudgetAuthorityJson(outer.value)}\n` !== exactBytes) {
        throw new WorkflowRunnerBudgetAuthorityClientError(
          'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RESPONSE_INVALID',
          'Budget account point-read is not exact canonical LF data.',
        );
      }
      const account = validateWorkflowBudgetAccount(outer.projection);
      if (
        account.workspaceId !== config.workspaceId ||
        account.runId !== runId ||
        account.route.backend !== route.backend ||
        account.route.authority !== route.authority ||
        account.route.routingEpoch !== route.routingEpoch ||
        account.route.authorityBuildHash !== route.authorityBuildHash
      ) {
        throw new WorkflowRunnerBudgetAuthorityClientError(
          'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RESPONSE_INVALID',
          'Budget account point-read differs from the sealed run and route.',
        );
      }
      return account;
    },
  });
}

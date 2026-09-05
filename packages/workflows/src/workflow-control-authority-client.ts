import { createHash } from 'node:crypto';
import { closedDataRecord } from './internal/contract-validation.js';

import {
  canonicalWorkflowControlAuthorityJson,
  validateWorkflowControlAuthorityReceipt,
  validateWorkflowControlAuthorityRoute,
  WORKFLOW_CONTROL_AUTHORITY_RUN_STATES,
  type WorkflowControlAuthorityReceipt,
  type WorkflowControlAuthorityRoute,
  type WorkflowControlAuthorityRunState,
} from './workflow-control-authority-contract.js';
import {
  cancelWorkflowRunnerResponseBody,
  exactWorkflowRunnerLoopbackOrigin,
  readWorkflowRunnerResponseBytes,
} from './workflow-runner-control-http.js';
import { parseWorkflowEffectJson } from './workflow-effect-json.js';
import type { WorkflowRunRouteReceipt } from './workflow-run-routing.js';
import { isWorkflowControlBearerToken } from './workflow-control-routing-identity.js';

export const WORKFLOW_CONTROL_AUTHORITY_ACCEPT_SCHEMA =
  'openslack.workflow_control_authority_accept.v2' as const;
export const WORKFLOW_CONTROL_AUTHORITY_TRANSITION_SCHEMA =
  'openslack.workflow_control_authority_transition.v2' as const;
export const WORKFLOW_CONTROL_AUTHORITY_RUN_RECORD_SCHEMA =
  'openslack.workflow_control_authority_run_record.v2' as const;
export const WORKFLOW_CONTROL_AUTHORITY_READ_SCHEMA =
  'openslack.workflow_control_authority_read.v2' as const;

const AUTHORITY_KEY_PREFIX = 'openslack.workflow-control-authority.v2.';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const RUN_RECORD_FIELDS = Object.freeze([
  'schema',
  'workspaceId',
  'runId',
  'workflowId',
  'workflowVersion',
  'workflowSourceHash',
  'manifestHash',
  'inputHash',
  'route',
  'state',
  'revision',
  'currentPhaseId',
  'currentPhaseIndex',
  'resumeGeneration',
] as const);
const RUN_READ_FIELDS = Object.freeze([
  ...RUN_RECORD_FIELDS,
  'recordHash',
  'record',
  'updatedAt',
] as const);
const BINDING_FIELDS = Object.freeze([
  'schema',
  'workspaceId',
  'callerId',
  'mode',
  'activeRoutingEpoch',
  'drainRoutingEpochs',
  'buildSha',
  'acceptNewRecords',
] as const);

export interface WorkflowControlAuthorityExpectedHead {
  readonly revision: number;
  readonly state: WorkflowControlAuthorityRunState | null;
  readonly currentPhaseId: string | null;
  readonly currentPhaseIndex: number | null;
  readonly resumeGeneration: number;
}

export interface WorkflowControlAuthorityRunRecord {
  readonly schema: typeof WORKFLOW_CONTROL_AUTHORITY_RUN_RECORD_SCHEMA;
  readonly workspaceId: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly workflowSourceHash: string;
  readonly manifestHash: string;
  readonly inputHash: string;
  readonly route: WorkflowControlAuthorityRoute;
  readonly state: WorkflowControlAuthorityRunState;
  readonly revision: number;
  readonly currentPhaseId: string | null;
  readonly currentPhaseIndex: number | null;
  readonly resumeGeneration: number;
}

export interface WorkflowControlAuthorityMutation {
  readonly schema:
    | typeof WORKFLOW_CONTROL_AUTHORITY_ACCEPT_SCHEMA
    | typeof WORKFLOW_CONTROL_AUTHORITY_TRANSITION_SCHEMA;
  readonly operation: 'accept' | 'transition';
  readonly workspaceId: string;
  readonly runId: string;
  readonly expected: WorkflowControlAuthorityExpectedHead;
  readonly route: WorkflowControlAuthorityRoute;
  readonly record: WorkflowControlAuthorityRunRecord;
  readonly correlationId: string;
}

export interface PreparedWorkflowControlAuthorityMutation {
  readonly value: WorkflowControlAuthorityMutation;
  readonly path: string;
  readonly exactBody: string;
  readonly requestHash: string;
  readonly recordHash: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface WorkflowControlAuthorityRunRead {
  readonly schema: typeof WORKFLOW_CONTROL_AUTHORITY_READ_SCHEMA;
  readonly workspaceId: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly workflowSourceHash: string;
  readonly manifestHash: string;
  readonly inputHash: string;
  readonly route: WorkflowControlAuthorityRoute;
  readonly state: WorkflowControlAuthorityRunState;
  readonly revision: number;
  readonly currentPhaseId: string | null;
  readonly currentPhaseIndex: number | null;
  readonly resumeGeneration: number;
  readonly recordHash: string;
  readonly record: WorkflowControlAuthorityRunRecord;
  readonly updatedAt: string;
}

export interface WorkflowControlAuthorityPort {
  inspectBinding(
    routingEpoch: number,
    signal?: AbortSignal,
  ): Promise<WorkflowControlAuthorityBinding>;
  accept(
    route: WorkflowRunRouteReceipt,
    signal?: AbortSignal,
  ): Promise<WorkflowControlAuthorityReceipt>;
  transition(
    record: WorkflowControlAuthorityRunRecord,
    expected: WorkflowControlAuthorityExpectedHead,
    correlationId: string,
    signal?: AbortSignal,
  ): Promise<WorkflowControlAuthorityReceipt>;
  /** Exact receipt lookup for a previously persisted transition intent; never mutates. */
  readTransitionReceipt?(
    record: WorkflowControlAuthorityRunRecord,
    expected: WorkflowControlAuthorityExpectedHead,
    correlationId: string,
    signal?: AbortSignal,
  ): Promise<WorkflowControlAuthorityReceipt | null>;
  read(
    runId: string,
    route: WorkflowControlAuthorityRoute,
    signal?: AbortSignal,
  ): Promise<WorkflowControlAuthorityRunRead>;
  readIfExists(
    runId: string,
    route: WorkflowControlAuthorityRoute,
    signal?: AbortSignal,
  ): Promise<WorkflowControlAuthorityRunRead | null>;
}

export interface WorkflowControlResumeAuthorityPort extends WorkflowControlAuthorityPort {
  readTransitionReceipt: NonNullable<WorkflowControlAuthorityPort['readTransitionReceipt']>;
}

export interface WorkflowControlAuthorityBinding {
  readonly schema: 'openslack.workflow_control_authority_binding.v1';
  readonly workspaceId: string;
  readonly callerId: string;
  readonly mode: 'new-record-canary-v1';
  readonly activeRoutingEpoch: number;
  readonly drainRoutingEpochs: readonly number[];
  readonly buildSha: string;
  readonly acceptNewRecords: boolean;
}

export class WorkflowControlAuthorityClientError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_CONTROL_AUTHORITY_CLIENT_CONFIG_INVALID'
      | 'WORKFLOW_CONTROL_AUTHORITY_CLIENT_INPUT_INVALID'
      | 'WORKFLOW_CONTROL_AUTHORITY_CLIENT_TRANSPORT_FAILED'
      | 'WORKFLOW_CONTROL_AUTHORITY_CLIENT_RESPONSE_INVALID'
      | 'WORKFLOW_CONTROL_AUTHORITY_CLIENT_REJECTED'
      | 'WORKFLOW_CONTROL_AUTHORITY_CLIENT_RECONCILIATION_REQUIRED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkflowControlAuthorityClientError';
  }
}

function fail(
  code: WorkflowControlAuthorityClientError['code'],
  message: string,
  options?: ErrorOptions,
): never {
  throw new WorkflowControlAuthorityClientError(code, message, options);
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hasExactKeys(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const reject = (): never => {
    throw new TypeError('Expected a closed data record.');
  };
  try {
    closedDataRecord(value, fields, '$', {
      inert: reject,
      missing: reject,
      unknown: reject,
      dataField: reject,
    });
    return true;
  } catch {
    return false;
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validateId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    return fail('WORKFLOW_CONTROL_AUTHORITY_CLIENT_INPUT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function validateHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) {
    return fail('WORKFLOW_CONTROL_AUTHORITY_CLIENT_INPUT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function safeInteger(value: unknown, minimum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return fail('WORKFLOW_CONTROL_AUTHORITY_CLIENT_INPUT_INVALID', `${label} is invalid.`);
  }
  return value as number;
}

function validateExpected(value: WorkflowControlAuthorityExpectedHead) {
  const revision = safeInteger(value.revision, 0, 'expected.revision');
  const resumeGeneration = safeInteger(value.resumeGeneration, 0, 'expected.resumeGeneration');
  if (
    (value.currentPhaseId === null) !== (value.currentPhaseIndex === null) ||
    (value.currentPhaseId !== null && !SAFE_ID.test(value.currentPhaseId)) ||
    (value.currentPhaseIndex !== null &&
      (!Number.isSafeInteger(value.currentPhaseIndex) || value.currentPhaseIndex < 0))
  ) {
    return fail(
      'WORKFLOW_CONTROL_AUTHORITY_CLIENT_INPUT_INVALID',
      'Expected phase binding is invalid.',
    );
  }
  return Object.freeze({
    revision,
    state: value.state,
    currentPhaseId: value.currentPhaseId,
    currentPhaseIndex: value.currentPhaseIndex,
    resumeGeneration,
  });
}

function validateRecord(value: WorkflowControlAuthorityRunRecord) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(
      'WORKFLOW_CONTROL_AUTHORITY_CLIENT_RESPONSE_INVALID',
      'Workflow authority run record is invalid.',
    );
  }
  if (!hasExactKeys(value as unknown as Record<string, unknown>, RUN_RECORD_FIELDS)) {
    return fail(
      'WORKFLOW_CONTROL_AUTHORITY_CLIENT_INPUT_INVALID',
      'Run record fields are invalid.',
    );
  }
  let route: WorkflowControlAuthorityRoute;
  try {
    route = validateWorkflowControlAuthorityRoute(value.route, '$/record/route');
  } catch (error) {
    return fail('WORKFLOW_CONTROL_AUTHORITY_CLIENT_INPUT_INVALID', 'Run record route is invalid.', {
      cause: error,
    });
  }
  if (
    value.schema !== WORKFLOW_CONTROL_AUTHORITY_RUN_RECORD_SCHEMA ||
    value.route.backend !== 'go' ||
    value.route.authority !== 'workflow-control' ||
    !WORKFLOW_CONTROL_AUTHORITY_RUN_STATES.includes(value.state) ||
    (value.currentPhaseId === null) !== (value.currentPhaseIndex === null)
  ) {
    return fail(
      'WORKFLOW_CONTROL_AUTHORITY_CLIENT_INPUT_INVALID',
      'Run record schema or authority is invalid.',
    );
  }
  return Object.freeze({
    schema: WORKFLOW_CONTROL_AUTHORITY_RUN_RECORD_SCHEMA,
    workspaceId: validateId(value.workspaceId, 'record.workspaceId'),
    runId: validateId(value.runId, 'record.runId'),
    workflowId: validateId(value.workflowId, 'record.workflowId'),
    workflowVersion: validateId(value.workflowVersion, 'record.workflowVersion'),
    workflowSourceHash: validateHash(value.workflowSourceHash, 'record.workflowSourceHash'),
    manifestHash: validateHash(value.manifestHash, 'record.manifestHash'),
    inputHash: validateHash(value.inputHash, 'record.inputHash'),
    route,
    state: value.state,
    revision: safeInteger(value.revision, 1, 'record.revision'),
    currentPhaseId: value.currentPhaseId,
    currentPhaseIndex: value.currentPhaseIndex,
    resumeGeneration: safeInteger(value.resumeGeneration, 0, 'record.resumeGeneration'),
  } satisfies WorkflowControlAuthorityRunRecord);
}

export function prepareWorkflowControlAuthorityMutation(input: {
  readonly operation: 'accept' | 'transition';
  readonly record: WorkflowControlAuthorityRunRecord;
  readonly expected: WorkflowControlAuthorityExpectedHead;
  readonly correlationId: string;
  readonly callerId: string;
  readonly expectedBuildHash: string;
}): PreparedWorkflowControlAuthorityMutation {
  const record = validateRecord(input.record);
  const expected = validateExpected(input.expected);
  const schema =
    input.operation === 'accept'
      ? WORKFLOW_CONTROL_AUTHORITY_ACCEPT_SCHEMA
      : WORKFLOW_CONTROL_AUTHORITY_TRANSITION_SCHEMA;
  if (
    record.revision !== expected.revision + 1 ||
    record.resumeGeneration < expected.resumeGeneration ||
    (input.operation === 'accept' &&
      (expected.revision !== 0 || expected.state !== null || record.state !== 'created')) ||
    (input.operation === 'transition' && expected.state === null)
  ) {
    return fail(
      'WORKFLOW_CONTROL_AUTHORITY_CLIENT_INPUT_INVALID',
      'Authority expected head and target record disagree.',
    );
  }
  const value = Object.freeze({
    schema,
    operation: input.operation,
    workspaceId: record.workspaceId,
    runId: record.runId,
    expected,
    route: record.route,
    record,
    correlationId: validateId(input.correlationId, 'correlationId'),
  } satisfies WorkflowControlAuthorityMutation);
  const exactBody = `${canonicalWorkflowControlAuthorityJson(value)}\n`;
  const path =
    input.operation === 'accept'
      ? '/v1/workflow-control/runs:accept'
      : `/v1/workflow-control/runs/${record.runId}:transition`;
  const callerId = validateId(input.callerId, 'callerId');
  const expectedBuildHash = validateHash(input.expectedBuildHash, 'expectedBuildHash');
  if (record.route.authorityBuildHash !== expectedBuildHash) {
    return fail(
      'WORKFLOW_CONTROL_AUTHORITY_CLIENT_INPUT_INVALID',
      'Run route and expected authority build disagree.',
    );
  }
  const requestFingerprint = `sha256:${hash(
    `POST\n${path}\n${callerId}\n${record.workspaceId}\n${record.route.routingEpoch}\n${expectedBuildHash}\n${exactBody}`,
  )}`;
  const recordBody = `${canonicalWorkflowControlAuthorityJson(record)}\n`;
  const requestHash = hash(exactBody);
  return Object.freeze({
    value,
    path,
    exactBody,
    requestHash,
    recordHash: hash(recordBody),
    idempotencyKey: `${AUTHORITY_KEY_PREFIX}${requestHash}`,
    requestFingerprint,
  });
}

export function workflowControlAuthorityInitialRecord(
  route: WorkflowRunRouteReceipt,
): WorkflowControlAuthorityRunRecord {
  if (route.route.backend !== 'go' || route.route.authority !== 'workflow-control') {
    return fail(
      'WORKFLOW_CONTROL_AUTHORITY_CLIENT_INPUT_INVALID',
      'Only a Go route can create an authority record.',
    );
  }
  return validateRecord({
    schema: WORKFLOW_CONTROL_AUTHORITY_RUN_RECORD_SCHEMA,
    workspaceId: route.workspaceId,
    runId: route.runId,
    workflowId: route.workflowId,
    workflowVersion: route.workflowVersion,
    workflowSourceHash: route.workflowSourceHash,
    manifestHash: route.manifestHash,
    inputHash: route.inputHash,
    route: route.route,
    state: 'created',
    revision: 1,
    currentPhaseId: null,
    currentPhaseIndex: null,
    resumeGeneration: 0,
  });
}

export function isWorkflowControlAuthorityHeadBoundToRoute(
  route: WorkflowRunRouteReceipt,
  head: WorkflowControlAuthorityRunRead,
): boolean {
  try {
    const initial = workflowControlAuthorityInitialRecord(route);
    const expected: WorkflowControlAuthorityRunRecord = {
      ...initial,
      state: head.state,
      revision: head.revision,
      currentPhaseId: head.currentPhaseId,
      currentPhaseIndex: head.currentPhaseIndex,
      resumeGeneration: head.resumeGeneration,
    };
    const recordJson = canonicalWorkflowControlAuthorityJson(head.record);
    return (
      head.workspaceId === route.workspaceId &&
      head.runId === route.runId &&
      head.workflowId === route.workflowId &&
      head.workflowVersion === route.workflowVersion &&
      head.workflowSourceHash === route.workflowSourceHash &&
      head.manifestHash === route.manifestHash &&
      head.inputHash === route.inputHash &&
      head.route.backend === route.route.backend &&
      head.route.authority === route.route.authority &&
      head.route.routingEpoch === route.route.routingEpoch &&
      head.route.authorityBuildHash === route.route.authorityBuildHash &&
      head.record.workspaceId === head.workspaceId &&
      head.record.runId === head.runId &&
      head.record.revision === head.revision &&
      head.record.state === head.state &&
      head.recordHash === hash(`${recordJson}\n`) &&
      recordJson === canonicalWorkflowControlAuthorityJson(expected)
    );
  } catch {
    return false;
  }
}

function exactOrigin(value: string): string {
  return exactWorkflowRunnerLoopbackOrigin(
    value,
    (message, options) =>
      fail('WORKFLOW_CONTROL_AUTHORITY_CLIENT_CONFIG_INVALID', message, options),
    {
      invalid: 'Workflow authority origin is invalid.',
      nonLoopback: 'Workflow authority origin must be an exact loopback HTTP origin.',
    },
  );
}

async function readResponse(response: Response, signal?: AbortSignal): Promise<Buffer> {
  return readWorkflowRunnerResponseBytes(response, {
    maxBytes: MAX_RESPONSE_BYTES,
    signal,
    validateContentLength: true,
    minimumBytes: 2,
    failure: (message, options) =>
      fail(
        message === 'Workflow authority response read failed.' ||
          message === 'Workflow authority response read was aborted.'
          ? 'WORKFLOW_CONTROL_AUTHORITY_CLIENT_TRANSPORT_FAILED'
          : 'WORKFLOW_CONTROL_AUTHORITY_CLIENT_RESPONSE_INVALID',
        message,
        options,
      ),
    messages: {
      contentType: 'Workflow authority response content type is invalid.',
      contentLength: 'Workflow authority response content length is invalid.',
      missingBody: 'Workflow authority response body is missing.',
      readFailed: 'Workflow authority response read failed.',
      exceeded: 'Workflow authority response exceeds its byte limit.',
      empty: 'Workflow authority response body is empty.',
      lengthMismatch: 'Workflow authority response content length is inconsistent.',
      aborted: 'Workflow authority response read was aborted.',
    },
  });
}

function exactReceipt(
  bytes: Buffer,
  prepared: PreparedWorkflowControlAuthorityMutation,
  workspaceId: string,
  expectedBuildHash: string,
): WorkflowControlAuthorityReceipt {
  let receipt: WorkflowControlAuthorityReceipt;
  try {
    receipt = validateWorkflowControlAuthorityReceipt(parseWorkflowEffectJson(bytes));
  } catch (error) {
    return fail(
      'WORKFLOW_CONTROL_AUTHORITY_CLIENT_RESPONSE_INVALID',
      'Workflow authority receipt is invalid.',
      { cause: error },
    );
  }
  if (`${canonicalWorkflowControlAuthorityJson(receipt)}\n` !== bytes.toString('utf8')) {
    return fail(
      'WORKFLOW_CONTROL_AUTHORITY_CLIENT_RESPONSE_INVALID',
      'Workflow authority receipt is not exact canonical JSON plus LF.',
    );
  }
  if (
    receipt.workspaceId !== workspaceId ||
    receipt.runId !== prepared.value.runId ||
    receipt.expectedRevision !== prepared.value.expected.revision ||
    receipt.resumeGeneration !== prepared.value.record.resumeGeneration ||
    receipt.idempotencyKey !== prepared.idempotencyKey ||
    receipt.requestFingerprint !== prepared.requestFingerprint ||
    receipt.requestHash !== prepared.requestHash ||
    receipt.correlationId !== prepared.value.correlationId ||
    receipt.serviceBuildHash !== expectedBuildHash ||
    canonicalWorkflowControlAuthorityJson(receipt.route) !==
      canonicalWorkflowControlAuthorityJson(prepared.value.route) ||
    (receipt.status !== 'reconciliation_required' &&
      (receipt.acceptedRevision !== prepared.value.record.revision ||
        receipt.recordHash !== prepared.recordHash))
  ) {
    return fail(
      'WORKFLOW_CONTROL_AUTHORITY_CLIENT_RESPONSE_INVALID',
      'Workflow authority receipt does not bind the exact mutation.',
    );
  }
  if (receipt.status === 'reconciliation_required') {
    return fail(
      'WORKFLOW_CONTROL_AUTHORITY_CLIENT_RECONCILIATION_REQUIRED',
      'Workflow authority mutation requires reconciliation.',
    );
  }
  return receipt;
}

export class WorkflowControlAuthorityHttpClient implements WorkflowControlAuthorityPort {
  readonly #origin: string;
  readonly #workspaceId: string;
  readonly #callerId: string;
  readonly #bearerToken: string;
  readonly #expectedBuildHash: string;
  readonly #fetch: typeof fetch;

  constructor(config: {
    readonly origin: string;
    readonly workspaceId: string;
    readonly callerId: string;
    readonly bearerToken: string;
    readonly expectedBuildHash: string;
    readonly fetch?: typeof fetch;
  }) {
    this.#origin = exactOrigin(config.origin);
    this.#workspaceId = validateId(config.workspaceId, 'workspaceId');
    this.#callerId = validateId(config.callerId, 'callerId');
    this.#expectedBuildHash = validateHash(config.expectedBuildHash, 'expectedBuildHash');
    if (!isWorkflowControlBearerToken(config.bearerToken)) {
      fail(
        'WORKFLOW_CONTROL_AUTHORITY_CLIENT_CONFIG_INVALID',
        'Workflow authority bearer token is invalid.',
      );
    }
    this.#bearerToken = config.bearerToken;
    this.#fetch = config.fetch ?? fetch;
  }

  async accept(
    route: WorkflowRunRouteReceipt,
    signal?: AbortSignal,
  ): Promise<WorkflowControlAuthorityReceipt> {
    if (
      route.workspaceId !== this.#workspaceId ||
      route.route.authorityBuildHash !== this.#expectedBuildHash
    ) {
      return fail(
        'WORKFLOW_CONTROL_AUTHORITY_CLIENT_INPUT_INVALID',
        'Route receipt differs from the authority client binding.',
      );
    }
    const prepared = prepareWorkflowControlAuthorityMutation({
      operation: 'accept',
      record: workflowControlAuthorityInitialRecord(route),
      expected: {
        revision: 0,
        state: null,
        currentPhaseId: null,
        currentPhaseIndex: null,
        resumeGeneration: 0,
      },
      correlationId: route.correlationId,
      callerId: this.#callerId,
      expectedBuildHash: this.#expectedBuildHash,
    });
    return this.#mutate(prepared, signal);
  }

  async inspectBinding(
    routingEpoch: number,
    signal?: AbortSignal,
  ): Promise<WorkflowControlAuthorityBinding> {
    const selectedEpoch = safeInteger(routingEpoch, 1, 'routingEpoch');
    const response = await this.#send('/v1/workflow-control/binding', {
      method: 'GET',
      signal,
      headers: {
        Authorization: `Bearer ${this.#bearerToken}`,
        'X-OpenSlack-Workflow-Control-Caller-ID': this.#callerId,
        'X-OpenSlack-Workflow-Control-Workspace-ID': this.#workspaceId,
        'X-OpenSlack-Workflow-Control-Routing-Epoch': String(selectedEpoch),
        'X-OpenSlack-Workflow-Control-Expected-Build-SHA': this.#expectedBuildHash,
      },
    });
    if (response.redirected || response.status !== 200) {
      await cancelWorkflowRunnerResponseBody(response);
      return fail(
        'WORKFLOW_CONTROL_AUTHORITY_CLIENT_REJECTED',
        `Workflow authority binding inspection rejected (${response.status}).`,
      );
    }
    const bytes = await readResponse(response, signal);
    let value: unknown;
    try {
      value = parseWorkflowEffectJson(bytes);
    } catch (error) {
      return fail(
        'WORKFLOW_CONTROL_AUTHORITY_CLIENT_RESPONSE_INVALID',
        'Workflow authority binding response is invalid JSON.',
        { cause: error },
      );
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return fail(
        'WORKFLOW_CONTROL_AUTHORITY_CLIENT_RESPONSE_INVALID',
        'Workflow authority binding response is invalid.',
      );
    }
    const root = value as Record<string, unknown>;
    const drains = root.drainRoutingEpochs;
    if (
      !hasExactKeys(root, BINDING_FIELDS) ||
      root.schema !== 'openslack.workflow_control_authority_binding.v1' ||
      root.workspaceId !== this.#workspaceId ||
      root.callerId !== this.#callerId ||
      root.mode !== 'new-record-canary-v1' ||
      !Number.isSafeInteger(root.activeRoutingEpoch) ||
      (root.activeRoutingEpoch as number) < 1 ||
      !Array.isArray(drains) ||
      drains.some((epoch) => !Number.isSafeInteger(epoch) || (epoch as number) < 1) ||
      drains.some(
        (epoch, index) => index > 0 && (drains[index - 1] as number) >= (epoch as number),
      ) ||
      drains.includes(root.activeRoutingEpoch) ||
      root.buildSha !== this.#expectedBuildHash ||
      typeof root.acceptNewRecords !== 'boolean' ||
      `${canonicalWorkflowControlAuthorityJson(root)}\n` !== bytes.toString('utf8')
    ) {
      return fail(
        'WORKFLOW_CONTROL_AUTHORITY_CLIENT_RESPONSE_INVALID',
        'Workflow authority binding response is invalid.',
      );
    }
    return Object.freeze({
      schema: 'openslack.workflow_control_authority_binding.v1',
      workspaceId: root.workspaceId as string,
      callerId: root.callerId as string,
      mode: 'new-record-canary-v1',
      activeRoutingEpoch: root.activeRoutingEpoch as number,
      drainRoutingEpochs: Object.freeze([...(drains as number[])]),
      buildSha: root.buildSha as string,
      acceptNewRecords: root.acceptNewRecords as boolean,
    });
  }

  async transition(
    record: WorkflowControlAuthorityRunRecord,
    expected: WorkflowControlAuthorityExpectedHead,
    correlationId: string,
    signal?: AbortSignal,
  ): Promise<WorkflowControlAuthorityReceipt> {
    if (
      record.workspaceId !== this.#workspaceId ||
      record.route.authorityBuildHash !== this.#expectedBuildHash
    ) {
      return fail(
        'WORKFLOW_CONTROL_AUTHORITY_CLIENT_INPUT_INVALID',
        'Transition differs from the authority client binding.',
      );
    }
    return this.#mutate(
      prepareWorkflowControlAuthorityMutation({
        operation: 'transition',
        record,
        expected,
        correlationId,
        callerId: this.#callerId,
        expectedBuildHash: this.#expectedBuildHash,
      }),
      signal,
    );
  }

  async readTransitionReceipt(
    record: WorkflowControlAuthorityRunRecord,
    expected: WorkflowControlAuthorityExpectedHead,
    correlationId: string,
    signal?: AbortSignal,
  ): Promise<WorkflowControlAuthorityReceipt | null> {
    if (
      record.workspaceId !== this.#workspaceId ||
      record.route.authorityBuildHash !== this.#expectedBuildHash
    ) {
      return fail(
        'WORKFLOW_CONTROL_AUTHORITY_CLIENT_INPUT_INVALID',
        'Receipt lookup differs from the authority binding.',
      );
    }
    const prepared = prepareWorkflowControlAuthorityMutation({
      operation: 'transition',
      record,
      expected,
      correlationId,
      callerId: this.#callerId,
      expectedBuildHash: this.#expectedBuildHash,
    });
    const response = await this.#send(`/v1/workflow-control/receipts/${prepared.idempotencyKey}`, {
      method: 'GET',
      signal,
      headers: this.#headers(record.route),
    });
    if (!response.redirected && response.status === 404) {
      await cancelWorkflowRunnerResponseBody(response);
      return null;
    }
    if (response.redirected || response.status !== 200) {
      await cancelWorkflowRunnerResponseBody(response);
      return fail(
        !response.redirected && (response.status === 429 || response.status >= 500)
          ? 'WORKFLOW_CONTROL_AUTHORITY_CLIENT_TRANSPORT_FAILED'
          : 'WORKFLOW_CONTROL_AUTHORITY_CLIENT_RECONCILIATION_REQUIRED',
        'Exact transition receipt is unavailable.',
      );
    }
    return exactReceipt(
      await readResponse(response, signal),
      prepared,
      this.#workspaceId,
      this.#expectedBuildHash,
    );
  }

  async read(
    runId: string,
    route: WorkflowControlAuthorityRoute,
    signal?: AbortSignal,
  ): Promise<WorkflowControlAuthorityRunRead> {
    const result = await this.#read(runId, route, false, signal);
    return result!;
  }

  async readIfExists(
    runId: string,
    route: WorkflowControlAuthorityRoute,
    signal?: AbortSignal,
  ): Promise<WorkflowControlAuthorityRunRead | null> {
    return this.#read(runId, route, true, signal);
  }

  async #read(
    runId: string,
    route: WorkflowControlAuthorityRoute,
    allowMissing: boolean,
    signal?: AbortSignal,
  ): Promise<WorkflowControlAuthorityRunRead | null> {
    const id = validateId(runId, 'runId');
    const selected = validateWorkflowControlAuthorityRoute(route, '$/route');
    if (
      selected.backend !== 'go' ||
      selected.authority !== 'workflow-control' ||
      selected.authorityBuildHash !== this.#expectedBuildHash
    ) {
      return fail(
        'WORKFLOW_CONTROL_AUTHORITY_CLIENT_INPUT_INVALID',
        'Read route differs from the authority client binding.',
      );
    }
    const response = await this.#send(`/v1/workflow-control/runs/${id}`, {
      method: 'GET',
      signal,
      headers: this.#headers(selected),
    });
    if (!response.redirected && response.status === 404 && allowMissing) {
      await cancelWorkflowRunnerResponseBody(response);
      return null;
    }
    if (response.redirected || response.status !== 200) {
      await cancelWorkflowRunnerResponseBody(response);
      return fail(
        !response.redirected && (response.status === 429 || response.status >= 500)
          ? 'WORKFLOW_CONTROL_AUTHORITY_CLIENT_TRANSPORT_FAILED'
          : 'WORKFLOW_CONTROL_AUTHORITY_CLIENT_REJECTED',
        `Workflow authority read rejected (${response.status}).`,
      );
    }
    const bytes = await readResponse(response, signal);
    let value: unknown;
    try {
      value = parseWorkflowEffectJson(bytes);
    } catch (error) {
      return fail(
        'WORKFLOW_CONTROL_AUTHORITY_CLIENT_RESPONSE_INVALID',
        'Workflow authority read is invalid JSON.',
        { cause: error },
      );
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return fail(
        'WORKFLOW_CONTROL_AUTHORITY_CLIENT_RESPONSE_INVALID',
        'Workflow authority read root is invalid.',
      );
    }
    const root = value as Record<string, unknown>;
    if (!hasExactKeys(root, RUN_READ_FIELDS)) {
      return fail(
        'WORKFLOW_CONTROL_AUTHORITY_CLIENT_RESPONSE_INVALID',
        'Workflow authority read fields are invalid.',
      );
    }
    let record: WorkflowControlAuthorityRunRecord;
    try {
      record = validateRecord(root.record as WorkflowControlAuthorityRunRecord);
    } catch (error) {
      return fail(
        'WORKFLOW_CONTROL_AUTHORITY_CLIENT_RESPONSE_INVALID',
        'Workflow authority read record is invalid.',
        { cause: error },
      );
    }
    if (
      root.schema !== WORKFLOW_CONTROL_AUTHORITY_READ_SCHEMA ||
      root.workspaceId !== this.#workspaceId ||
      root.runId !== id ||
      root.workflowId !== record.workflowId ||
      root.workflowVersion !== record.workflowVersion ||
      root.workflowSourceHash !== record.workflowSourceHash ||
      root.manifestHash !== record.manifestHash ||
      root.inputHash !== record.inputHash ||
      root.state !== record.state ||
      root.revision !== record.revision ||
      root.currentPhaseId !== record.currentPhaseId ||
      root.currentPhaseIndex !== record.currentPhaseIndex ||
      root.resumeGeneration !== record.resumeGeneration ||
      root.recordHash !== hash(`${canonicalWorkflowControlAuthorityJson(record)}\n`) ||
      !isCanonicalTimestamp(root.updatedAt) ||
      canonicalWorkflowControlAuthorityJson(root.route) !==
        canonicalWorkflowControlAuthorityJson(selected) ||
      `${canonicalWorkflowControlAuthorityJson(root)}\n` !== bytes.toString('utf8')
    ) {
      return fail(
        'WORKFLOW_CONTROL_AUTHORITY_CLIENT_RESPONSE_INVALID',
        'Workflow authority read binding is invalid.',
      );
    }
    return Object.freeze(root) as unknown as WorkflowControlAuthorityRunRead;
  }

  async #mutate(
    prepared: PreparedWorkflowControlAuthorityMutation,
    signal?: AbortSignal,
  ): Promise<WorkflowControlAuthorityReceipt> {
    let response: Response;
    try {
      response = await this.#send(prepared.path, {
        method: 'POST',
        signal,
        body: prepared.exactBody,
        headers: {
          ...this.#headers(prepared.value.route),
          'Content-Type': 'application/json',
          'Idempotency-Key': prepared.idempotencyKey,
          'X-OpenSlack-Request-Fingerprint': prepared.requestFingerprint,
        },
      });
    } catch (error) {
      return this.#recoverReceipt(prepared, signal, error);
    }
    if (response.redirected || ![200, 201, 202].includes(response.status)) {
      const status = response.status;
      await cancelWorkflowRunnerResponseBody(response);
      if (!response.redirected && (status >= 500 || status === 429))
        return this.#recoverReceipt(prepared, signal);
      return fail(
        'WORKFLOW_CONTROL_AUTHORITY_CLIENT_REJECTED',
        `Workflow authority mutation rejected (${status}).`,
      );
    }
    const replay = response.headers.get('X-OpenSlack-Idempotent-Replay');
    if (
      (response.status === 200 && replay !== 'true') ||
      (response.status !== 200 && replay !== null)
    ) {
      await cancelWorkflowRunnerResponseBody(response);
      return fail(
        'WORKFLOW_CONTROL_AUTHORITY_CLIENT_RESPONSE_INVALID',
        'Workflow authority replay metadata is invalid.',
      );
    }
    const receipt = exactReceipt(
      await readResponse(response, signal),
      prepared,
      this.#workspaceId,
      this.#expectedBuildHash,
    );
    if (response.status === 202) {
      return fail(
        'WORKFLOW_CONTROL_AUTHORITY_CLIENT_RECONCILIATION_REQUIRED',
        'Workflow authority mutation requires reconciliation.',
      );
    }
    return receipt;
  }

  async #recoverReceipt(
    prepared: PreparedWorkflowControlAuthorityMutation,
    signal?: AbortSignal,
    cause?: unknown,
  ): Promise<WorkflowControlAuthorityReceipt> {
    let response: Response;
    try {
      response = await this.#send(`/v1/workflow-control/receipts/${prepared.idempotencyKey}`, {
        method: 'GET',
        signal,
        headers: this.#headers(prepared.value.route),
      });
    } catch (error) {
      return fail(
        'WORKFLOW_CONTROL_AUTHORITY_CLIENT_TRANSPORT_FAILED',
        'Workflow authority outcome is unknown after exact receipt recovery.',
        { cause: error },
      );
    }
    if (response.redirected || response.status !== 200) {
      await cancelWorkflowRunnerResponseBody(response);
      return fail(
        'WORKFLOW_CONTROL_AUTHORITY_CLIENT_TRANSPORT_FAILED',
        'Workflow authority outcome is unknown; no matching durable receipt was readable.',
        cause === undefined ? undefined : { cause },
      );
    }
    return exactReceipt(
      await readResponse(response, signal),
      prepared,
      this.#workspaceId,
      this.#expectedBuildHash,
    );
  }

  async #send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(new URL(path, this.#origin), { ...init, redirect: 'error' });
    } catch (error) {
      return fail(
        'WORKFLOW_CONTROL_AUTHORITY_CLIENT_TRANSPORT_FAILED',
        'Workflow authority transport failed.',
        { cause: error },
      );
    }
  }

  #headers(route: WorkflowControlAuthorityRoute): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#bearerToken}`,
      'X-OpenSlack-Workflow-Control-Caller-ID': this.#callerId,
      'X-OpenSlack-Workflow-Control-Workspace-ID': this.#workspaceId,
      'X-OpenSlack-Workflow-Control-Routing-Epoch': String(route.routingEpoch),
      'X-OpenSlack-Workflow-Control-Expected-Build-SHA': this.#expectedBuildHash,
    };
  }
}

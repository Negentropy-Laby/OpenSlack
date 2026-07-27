import { types as utilTypes } from 'node:util';

export const OPENSLACK_MCP_RESULT_SCHEMA = 'openslack.mcp_result.v1' as const;
export const OPENSLACK_MCP_RESULT_V2_SCHEMA = 'openslack.mcp_result.v2' as const;

export type OpenSlackMcpStatus =
  | 'completed'
  | 'preview'
  | 'needs_confirmation'
  | 'blocked'
  | 'failed';

export type OpenSlackMcpRisk = 'none' | 'low' | 'medium' | 'high';

export interface OpenSlackMcpGovernance {
  readonly risk: OpenSlackMcpRisk;
  readonly approvalRequired: boolean;
  readonly approvalKind?:
    | 'openslack_confirm'
    | 'openslack_workflow_effect'
    | 'github_human_review'
    | 'workflow_trust';
  readonly owner?: string;
  readonly blocker?: string;
}

export interface OpenSlackMcpNextAction {
  readonly id: string;
  readonly label: string;
  readonly tool?: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

export interface OpenSlackMcpNextActionV2 extends OpenSlackMcpNextAction {
  readonly requiresConfirmation: boolean;
}

/** Frozen compatibility contract for the nine QW2 foundation handlers and fixtures. */
export interface OpenSlackMcpResult<T = unknown> {
  readonly schema: typeof OPENSLACK_MCP_RESULT_SCHEMA;
  readonly status: OpenSlackMcpStatus;
  readonly summary: string;
  readonly data?: T;
  readonly governance: OpenSlackMcpGovernance;
  readonly nextActions: readonly OpenSlackMcpNextAction[];
  readonly evidenceRefs: readonly string[];
  readonly planId?: string;
  readonly executionId?: string;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface OpenSlackMcpAuthority {
  readonly mode: 'projection' | 'governed_mutation';
  readonly sources: readonly string[];
  readonly observedAt: string;
}

export interface OpenSlackMcpResultV2<T = unknown> {
  readonly schema: typeof OPENSLACK_MCP_RESULT_V2_SCHEMA;
  readonly correlationId: string;
  readonly status: OpenSlackMcpStatus;
  readonly summary: string;
  readonly authority: OpenSlackMcpAuthority;
  readonly data?: T;
  readonly governance: OpenSlackMcpGovernance;
  readonly nextActions: readonly OpenSlackMcpNextActionV2[];
  readonly evidenceRefs: readonly string[];
  readonly planId?: string;
  readonly executionId?: string;
  readonly approval?: {
    readonly approvalId: string;
    readonly kind: 'openslack_workflow_effect';
    readonly expiresAt: string;
    readonly risk: Exclude<OpenSlackMcpRisk, 'none'>;
  };
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface CreateOpenSlackMcpResultOptions<T> {
  readonly status?: OpenSlackMcpStatus;
  readonly summary: string;
  readonly data?: T;
  readonly governance?: Partial<OpenSlackMcpGovernance>;
  readonly nextActions?: readonly OpenSlackMcpNextAction[];
  readonly evidenceRefs?: readonly string[];
  readonly planId?: string;
  readonly executionId?: string;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface UpgradeOpenSlackMcpResultOptions {
  readonly correlationId: string;
  readonly authority: OpenSlackMcpAuthority;
}

const MAX_SUMMARY_LENGTH = 2_000;
const MAX_EVIDENCE_REFS = 50;
const MAX_EVIDENCE_REF_LENGTH = 512;
const MAX_NEXT_ACTIONS = 12;
const MAX_ID_LENGTH = 160;
const MAX_ERROR_CODE_LENGTH = 100;
const MAX_ERROR_MESSAGE_LENGTH = 1_000;
const MAX_INERT_JSON_DEPTH = 12;
const MAX_INERT_JSON_CONTAINER_ITEMS = 1_000;
const MAX_VERSIONED_REPO_PATH_LENGTH = 374;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/?#@+-]*$/;
const CANONICAL_TIMESTAMP_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const TYPED_EVIDENCE_PATTERN =
  /^(?:event|query|artifact|test|repo|workflow-run|run|plan|issue|pr|decision|handoff|notification|assumption|fixture):[A-Za-z0-9][A-Za-z0-9._~:/@+?%=&-]{0,499}$/;
const COMMIT_EVIDENCE_PATTERN = /^commit:[0-9a-f]{40}$/i;
const VERSIONED_REPO_EVIDENCE_PATTERN =
  /^repo:((?:(?!\.{1,2}\/)[A-Za-z0-9._-]+\/)*(?!\.{1,2}#)[A-Za-z0-9._-]+)#[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizeEvidenceRefs(refs: readonly string[]): readonly string[] {
  return Object.freeze(
    [...new Set(refs)]
      .slice(0, MAX_EVIDENCE_REFS)
      .map((reference) => truncate(reference.trim(), MAX_EVIDENCE_REF_LENGTH))
      .filter(Boolean),
  );
}

function normalizeAuthority(authority: OpenSlackMcpAuthority): OpenSlackMcpAuthority {
  if (authority.mode !== 'projection' && authority.mode !== 'governed_mutation') {
    throw new TypeError('authority.mode is invalid.');
  }
  if (
    !Array.isArray(authority.sources) ||
    authority.sources.length < 1 ||
    authority.sources.length > 20
  ) {
    throw new TypeError('authority.sources must contain between 1 and 20 sources.');
  }
  const sources = [...new Set(authority.sources)].map((source) => source.trim());
  if (
    sources.some(
      (source) => source.length < 1 || source.length > 160 || !SOURCE_PATTERN.test(source),
    )
  ) {
    throw new TypeError('authority.sources contains an invalid source.');
  }
  const observedAt = new Date(authority.observedAt);
  if (!Number.isFinite(observedAt.getTime()) || observedAt.toISOString() !== authority.observedAt) {
    throw new TypeError('authority.observedAt must be a canonical ISO timestamp.');
  }
  return Object.freeze({
    mode: authority.mode,
    sources: Object.freeze(sources),
    observedAt: authority.observedAt,
  });
}

function normalizeCorrelationId(value: string): string {
  const correlationId = value.trim();
  if (
    correlationId.length < 1 ||
    correlationId.length > MAX_ID_LENGTH ||
    !CORRELATION_ID_PATTERN.test(correlationId)
  ) {
    throw new TypeError('correlationId must be a bounded canonical identifier.');
  }
  return correlationId;
}

export function createOpenSlackMcpResult<T>(
  options: CreateOpenSlackMcpResultOptions<T>,
): OpenSlackMcpResult<T> {
  const summary = truncate(options.summary.trim(), MAX_SUMMARY_LENGTH);
  if (!boundedString(summary, MAX_SUMMARY_LENGTH)) {
    throw new TypeError('summary must be a non-empty bounded protocol string.');
  }
  const governance: OpenSlackMcpGovernance = Object.freeze({
    risk: options.governance?.risk ?? 'none',
    approvalRequired: options.governance?.approvalRequired ?? false,
    ...(options.governance?.approvalKind ? { approvalKind: options.governance.approvalKind } : {}),
    ...(options.governance?.owner ? { owner: options.governance.owner } : {}),
    ...(options.governance?.blocker ? { blocker: options.governance.blocker } : {}),
  });

  return Object.freeze({
    schema: OPENSLACK_MCP_RESULT_SCHEMA,
    status: options.status ?? 'completed',
    summary,
    ...(options.data === undefined ? {} : { data: options.data }),
    governance,
    nextActions: Object.freeze([...(options.nextActions ?? [])].slice(0, MAX_NEXT_ACTIONS)),
    evidenceRefs: normalizeEvidenceRefs(options.evidenceRefs ?? []),
    ...(options.planId ? { planId: truncate(options.planId.trim(), MAX_ID_LENGTH) } : {}),
    ...(options.executionId
      ? { executionId: truncate(options.executionId.trim(), MAX_ID_LENGTH) }
      : {}),
    ...(options.error
      ? {
          error: Object.freeze({
            code: truncate(options.error.code.trim(), MAX_ERROR_CODE_LENGTH),
            message: truncate(options.error.message.trim(), MAX_ERROR_MESSAGE_LENGTH),
          }),
        }
      : {}),
  });
}

export function upgradeOpenSlackMcpResult(
  result: OpenSlackMcpResult,
  options: UpgradeOpenSlackMcpResultOptions,
): OpenSlackMcpResultV2 {
  const nextActions = result.nextActions.map((action) =>
    Object.freeze({ ...action, requiresConfirmation: false }),
  );
  const upgraded: OpenSlackMcpResultV2 = Object.freeze({
    schema: OPENSLACK_MCP_RESULT_V2_SCHEMA,
    correlationId: normalizeCorrelationId(options.correlationId),
    status: result.status,
    summary: result.summary,
    authority: normalizeAuthority(options.authority),
    ...(result.data === undefined ? {} : { data: result.data }),
    governance: result.governance,
    nextActions: Object.freeze(nextActions),
    evidenceRefs: result.evidenceRefs,
    ...(result.planId ? { planId: result.planId } : {}),
    ...(result.executionId ? { executionId: result.executionId } : {}),
    ...(result.error ? { error: result.error } : {}),
  });
  if (!validateOpenSlackMcpResultV2(upgraded)) {
    throw new TypeError('MCP result v2 failed the closed runtime contract.');
  }
  return upgraded;
}

export function validateOpenSlackMcpResultV2(value: unknown): value is OpenSlackMcpResultV2 {
  const top = dataRecord(
    value,
    [
      'schema',
      'correlationId',
      'status',
      'summary',
      'authority',
      'data',
      'governance',
      'nextActions',
      'evidenceRefs',
      'planId',
      'executionId',
      'approval',
      'error',
    ],
    [
      'schema',
      'correlationId',
      'status',
      'summary',
      'authority',
      'governance',
      'nextActions',
      'evidenceRefs',
    ],
  );
  if (!top) return false;
  const authority = dataRecord(
    top.authority,
    ['mode', 'sources', 'observedAt'],
    ['mode', 'sources', 'observedAt'],
  );
  const governance = dataRecord(
    top.governance,
    ['risk', 'approvalRequired', 'approvalKind', 'owner', 'blocker'],
    ['risk', 'approvalRequired'],
  );
  const actions = dataArray(top.nextActions, MAX_NEXT_ACTIONS);
  const evidenceRefs = dataArray(top.evidenceRefs, MAX_EVIDENCE_REFS);
  if (!authority || !governance || !actions || !evidenceRefs) return false;
  const sources = dataArray(authority.sources, 20);
  if (
    top.schema !== OPENSLACK_MCP_RESULT_V2_SCHEMA ||
    !boundedPattern(top.correlationId, MAX_ID_LENGTH, CORRELATION_ID_PATTERN) ||
    !['completed', 'preview', 'needs_confirmation', 'blocked', 'failed'].includes(
      String(top.status),
    ) ||
    !boundedString(top.summary, MAX_SUMMARY_LENGTH) ||
    !['projection', 'governed_mutation'].includes(String(authority.mode)) ||
    !sources ||
    sources.length < 1 ||
    sources.some((source) => !boundedPattern(source, 160, SOURCE_PATTERN)) ||
    new Set(sources).size !== sources.length ||
    !canonicalIso(authority.observedAt) ||
    !['none', 'low', 'medium', 'high'].includes(String(governance.risk)) ||
    typeof governance.approvalRequired !== 'boolean' ||
    (governance.approvalKind !== undefined &&
      ![
        'openslack_confirm',
        'openslack_workflow_effect',
        'github_human_review',
        'workflow_trust',
      ].includes(String(governance.approvalKind))) ||
    (governance.owner !== undefined && !boundedString(governance.owner, 160)) ||
    (governance.blocker !== undefined && !boundedString(governance.blocker, 160)) ||
    evidenceRefs.some((reference) => !boundedEvidenceRef(reference)) ||
    (top.planId !== undefined && !boundedString(top.planId, MAX_ID_LENGTH)) ||
    (top.executionId !== undefined && !boundedString(top.executionId, MAX_ID_LENGTH)) ||
    (top.data !== undefined && !inertJson(top.data))
  ) {
    return false;
  }
  for (const value of actions) {
    const action = dataRecord(
      value,
      ['id', 'label', 'tool', 'arguments', 'requiresConfirmation'],
      ['id', 'label', 'requiresConfirmation'],
    );
    if (
      !action ||
      !boundedString(action.id, MAX_ID_LENGTH) ||
      !boundedString(action.label, 1_000) ||
      typeof action.requiresConfirmation !== 'boolean' ||
      (action.tool !== undefined && !boundedString(action.tool, MAX_ID_LENGTH)) ||
      (action.arguments !== undefined &&
        (!dataRecord(action.arguments, undefined, [], MAX_INERT_JSON_CONTAINER_ITEMS) ||
          !inertJson(action.arguments)))
    ) {
      return false;
    }
  }
  if (top.error !== undefined) {
    const error = dataRecord(top.error, ['code', 'message'], ['code', 'message']);
    if (
      !error ||
      !boundedString(error.code, MAX_ERROR_CODE_LENGTH) ||
      !boundedString(error.message, MAX_ERROR_MESSAGE_LENGTH)
    ) {
      return false;
    }
  }
  if (top.approval !== undefined) {
    const approval = dataRecord(
      top.approval,
      ['approvalId', 'kind', 'expiresAt', 'risk'],
      ['approvalId', 'kind', 'expiresAt', 'risk'],
    );
    if (
      !approval ||
      !boundedString(approval.approvalId, MAX_ID_LENGTH) ||
      approval.kind !== 'openslack_workflow_effect' ||
      !canonicalIso(approval.expiresAt) ||
      !['low', 'medium', 'high'].includes(String(approval.risk))
    ) {
      return false;
    }
  }
  return true;
}

function dataRecord(
  value: unknown,
  allowed: readonly string[] | undefined,
  required: readonly string[],
  maxProperties = allowed?.length ?? MAX_INERT_JSON_CONTAINER_ITEMS,
): Record<string, unknown> | undefined {
  if (utilTypes.isProxy(value)) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > maxProperties ||
    keys.some(
      (key) => typeof key !== 'string' || (allowed !== undefined && !allowed.includes(key)),
    ) ||
    required.some((key) => !keys.includes(key))
  ) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      descriptor.value === undefined
    ) {
      return undefined;
    }
    result[key] = descriptor.value;
  }
  return result;
}

function dataArray(value: unknown, max: number): unknown[] | undefined {
  if (utilTypes.isProxy(value)) return undefined;
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max
  ) {
    return undefined;
  }
  const allowed = new Set(['length']);
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    allowed.add(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return undefined;
    }
    result.push(descriptor.value);
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key))) {
    return undefined;
  }
  return result;
}

function boundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function boundedPattern(value: unknown, max: number, pattern: RegExp): value is string {
  return boundedString(value, max) && pattern.test(value);
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP_PATTERN.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function boundedEvidenceRef(value: unknown): value is string {
  if (!boundedString(value, MAX_EVIDENCE_REF_LENGTH)) return false;
  if (TYPED_EVIDENCE_PATTERN.test(value) || COMMIT_EVIDENCE_PATTERN.test(value)) return true;
  const versionedRepository = VERSIONED_REPO_EVIDENCE_PATTERN.exec(value);
  return (
    versionedRepository !== null && versionedRepository[1]!.length <= MAX_VERSIONED_REPO_PATH_LENGTH
  );
}

function inertJson(value: unknown, depth = 0): boolean {
  if (depth > MAX_INERT_JSON_DEPTH || utilTypes.isProxy(value)) return false;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  const array = dataArray(value, MAX_INERT_JSON_CONTAINER_ITEMS);
  if (array) return array.every((child) => inertJson(child, depth + 1));
  const record = dataRecord(value, undefined, [], MAX_INERT_JSON_CONTAINER_ITEMS);
  return record ? Object.values(record).every((child) => inertJson(child, depth + 1)) : false;
}

export function createBlockedMcpResult(
  summary: string,
  blocker: string,
  evidenceRefs: readonly string[] = [],
): OpenSlackMcpResult {
  return createOpenSlackMcpResult({
    status: 'blocked',
    summary,
    governance: { blocker },
    evidenceRefs,
  });
}

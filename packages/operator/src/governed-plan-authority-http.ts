import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import {
  canonicalGovernedJson,
  validateGovernedPlanRecord,
  type GovernedPlanRecord,
} from './governed-plan.js';
import {
  registerGovernanceAuthorityGoPort,
  type GovernanceAuthorityGoPort,
  type GovernanceAuthorityMutationOperation,
  type GovernanceAuthorityPendingAudit,
  type GovernanceAuthorityTransitionOperation,
  type GovernedPlanAuthorityRoute,
} from './governed-plan-authority-store.js';
import type { GovernedPlanAuditEvent } from './governed-plan-service.js';

type GovernanceAuthorityFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GovernanceAuthorityHttpOptions {
  readonly origin: string;
  readonly networkMode?: 'loopback' | 'internal';
  readonly workspaceId: string;
  readonly callerId: string;
  readonly expectedBuildSha: string;
  readonly expiresAt: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Test seam. */
  readonly fetch?: GovernanceAuthorityFetch;
  /** Test seam. */
  readonly now?: () => number;
}

export const GOVERNANCE_AUTHORITY_HTTP_LIMITS = Object.freeze({
  defaultTimeoutMs: 5_000,
  maxTimeoutMs: 30_000,
  defaultResponseBytes: 2 * 1024 * 1024,
  maxResponseBytes: 4 * 1024 * 1024,
} as const);

export class GovernanceAuthorityHttpError extends Error {
  constructor(
    readonly code:
      | 'GOVERNANCE_AUTHORITY_POLICY_INVALID'
      | 'GOVERNANCE_AUTHORITY_CONFLICT'
      | 'GOVERNANCE_AUTHORITY_HTTP_ERROR'
      | 'GOVERNANCE_AUTHORITY_RECEIPT_INVALID'
      | 'GOVERNANCE_AUTHORITY_EXECUTION_UNCERTAIN',
    message: string,
    readonly reconciliationToken?: string,
  ) {
    super(message);
    this.name = 'GovernanceAuthorityHttpError';
  }
}

type GovernanceAuthorityOperation = 'accept' | GovernanceAuthorityTransitionOperation;

interface PreparedMutation {
  readonly operation: GovernanceAuthorityOperation;
  readonly path: string;
  readonly body: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly expectedRevision: number;
  readonly target: GovernedPlanRecord;
  readonly route: GovernedPlanAuthorityRoute;
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const BUILD_SHA = /^[0-9a-f]{64}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const RECEIPT_SCHEMA = 'openslack.governance_authority_receipt.v1';
const READ_SCHEMA = 'openslack.governance_authority_read.v1';
const AUDIT_RECEIPT_SCHEMA = 'openslack.governance_authority_audit_receipt.v1';
const PENDING_AUDIT_SCHEMA = 'openslack.governance_authority_pending_audit.v1';
const AUTHORITY_OPERATIONS = new Set<GovernanceAuthorityMutationOperation>([
  'accept',
  'claim_execution',
  'complete_execution',
  'cancel',
  'expire',
  'require_reconciliation',
]);

function policyError(message: string): never {
  throw new GovernanceAuthorityHttpError('GOVERNANCE_AUTHORITY_POLICY_INVALID', message);
}

function safeIdentifier(value: string, name: string): string {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER.test(value)) {
    return policyError(`${name} must be a canonical bounded identifier.`);
  }
  return value;
}

function positiveInteger(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    return policyError(`${name} must be a positive bounded safe integer.`);
  }
  return value;
}

function ipv4Parts(address: string): readonly number[] {
  return address.split('.').map(Number);
}

function isLoopback(address: string, version: number): boolean {
  if (version === 4) return ipv4Parts(address)[0] === 127;
  return address.toLowerCase() === '::1';
}

function isInternal(address: string, version: number): boolean {
  if (isLoopback(address, version)) return true;
  if (version === 4) {
    const [first, second] = ipv4Parts(address);
    return (
      first === 10 ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  const first = Number.parseInt(address.toLowerCase().split(':')[0] ?? '', 16);
  return (
    (Number.isFinite(first) && (first & 0xfe00) === 0xfc00) ||
    (Number.isFinite(first) && (first & 0xffc0) === 0xfe80)
  );
}

function normalizeOrigin(value: string, networkMode: 'loopback' | 'internal'): string {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    return policyError('Governance authority origin must be an absolute HTTP URL.');
  }
  const address =
    origin.hostname.startsWith('[') && origin.hostname.endsWith(']')
      ? origin.hostname.slice(1, -1)
      : origin.hostname;
  const version = isIP(address);
  if (
    origin.protocol !== 'http:' ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.search !== '' ||
    origin.hash !== '' ||
    (origin.pathname !== '/' && origin.pathname !== '') ||
    version === 0 ||
    (networkMode === 'loopback' ? !isLoopback(address, version) : !isInternal(address, version))
  ) {
    return policyError('Governance authority origin is outside the selected private network mode.');
  }
  return origin.origin;
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validateRoute(value: unknown, expected: GovernedPlanAuthorityRoute): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const route = value as Readonly<Record<string, unknown>>;
  return (
    exactKeys(route, ['backend', 'routingEpoch', 'authority']) &&
    route.backend === 'go' &&
    route.backend === expected.backend &&
    route.routingEpoch === expected.routingEpoch &&
    route.authority === 'governance-control' &&
    route.authority === expected.authority
  );
}

function recordHash(record: GovernedPlanRecord): string {
  return createHash('sha256')
    .update(`${canonicalGovernedJson(validateGovernedPlanRecord(record))}\n`, 'utf8')
    .digest('hex');
}

function transitionPath(planId: string, operation: GovernanceAuthorityTransitionOperation): string {
  const action = operation.replaceAll('_', '-');
  return `/v1/governance/plans/${encodeURIComponent(planId)}:${action}`;
}

function prepareMutation(input: {
  readonly operation: GovernanceAuthorityOperation;
  readonly expectedRevision: number;
  readonly target: GovernedPlanRecord;
  readonly route: GovernedPlanAuthorityRoute;
  readonly callerId: string;
  readonly workspaceId: string;
  readonly expectedBuildSha: string;
}): PreparedMutation {
  const path =
    input.operation === 'accept'
      ? '/v1/governance/plans:accept'
      : transitionPath(input.target.planId, input.operation);
  const body = `${canonicalGovernedJson({
    schema:
      input.operation === 'accept'
        ? 'openslack.governance_authority_accept.v1'
        : 'openslack.governance_authority_transition.v1',
    operation: input.operation,
    workspaceId: input.workspaceId,
    planId: input.target.planId,
    expectedRevision: input.expectedRevision,
    route: input.route,
    record: input.target,
  })}\n`;
  const bodyDigest = createHash('sha256').update(body, 'utf8').digest('hex');
  const epoch = String(input.route.routingEpoch);
  const requestFingerprint = `sha256:${createHash('sha256')
    .update(
      `POST\n${path}\n${input.callerId}\n${input.workspaceId}\n${epoch}\n${input.expectedBuildSha}\n${body}`,
      'utf8',
    )
    .digest('hex')}`;
  return Object.freeze({
    operation: input.operation,
    path,
    body,
    idempotencyKey: `openslack.governance-authority.v1.${bodyDigest}`,
    requestFingerprint,
    expectedRevision: input.expectedRevision,
    target: input.target,
    route: input.route,
  });
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A failed response body is already unusable.
  }
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get('Content-Length');
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maximum) {
    await cancelBody(response);
    throw new GovernanceAuthorityHttpError(
      'GOVERNANCE_AUTHORITY_RECEIPT_INVALID',
      'Governance authority response exceeds its declared byte limit.',
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new GovernanceAuthorityHttpError(
          'GOVERNANCE_AUTHORITY_RECEIPT_INVALID',
          'Governance authority response exceeds its byte limit.',
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseCanonical(bytes: Uint8Array): Readonly<Record<string, unknown>> | null {
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    `${canonicalGovernedJson(parsed)}\n` !== text
  ) {
    return null;
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    CANONICAL_TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function expectedExecutionId(prepared: PreparedMutation): string | undefined {
  return prepared.operation === 'claim_execution' ||
    prepared.operation === 'complete_execution' ||
    prepared.operation === 'require_reconciliation'
    ? prepared.target.execution?.executionId
    : undefined;
}

function parseReceipt(
  bytes: Uint8Array,
  prepared: PreparedMutation,
  binding: { readonly workspaceId: string; readonly callerId: string; readonly build: string },
):
  | { readonly status: 'accepted' | 'duplicate'; readonly record: GovernedPlanRecord }
  | {
      readonly status: 'reconciliation_required';
      readonly reconciliationToken: string;
    }
  | null {
  const value = parseCanonical(bytes);
  if (!value) return null;
  const executionId = expectedExecutionId(prepared);
  const common = [
    'schema',
    'operation',
    'status',
    'workspaceId',
    'planId',
    'expectedRevision',
    'route',
    'idempotencyKey',
    'requestFingerprint',
    'recordHash',
    'correlationId',
    'callerId',
    'serviceBuildSha',
    ...(executionId === undefined ? [] : ['executionId']),
  ];
  if (
    value.schema !== RECEIPT_SCHEMA ||
    value.operation !== prepared.operation ||
    value.workspaceId !== binding.workspaceId ||
    value.planId !== prepared.target.planId ||
    value.expectedRevision !== prepared.expectedRevision ||
    !validateRoute(value.route, prepared.route) ||
    value.idempotencyKey !== prepared.idempotencyKey ||
    value.requestFingerprint !== prepared.requestFingerprint ||
    value.recordHash !== recordHash(prepared.target) ||
    value.correlationId !== prepared.target.bindings.correlationId ||
    value.callerId !== binding.callerId ||
    value.serviceBuildSha !== binding.build ||
    (executionId === undefined
      ? Object.hasOwn(value, 'executionId')
      : value.executionId !== executionId)
  ) {
    return null;
  }
  if (value.status === 'accepted' || value.status === 'duplicate') {
    if (
      !exactKeys(value, [...common, 'acceptedRevision', 'state', 'record', 'committedAt']) ||
      value.acceptedRevision !== prepared.target.revision ||
      value.state !== prepared.target.state ||
      !validTimestamp(value.committedAt)
    ) {
      return null;
    }
    let record: GovernedPlanRecord;
    try {
      record = validateGovernedPlanRecord(value.record);
    } catch {
      return null;
    }
    if (
      canonicalGovernedJson(record) !== canonicalGovernedJson(prepared.target) ||
      recordHash(record) !== value.recordHash
    ) {
      return null;
    }
    return Object.freeze({ status: value.status, record });
  }
  if (
    value.status !== 'reconciliation_required' ||
    !exactKeys(value, [...common, 'targetRevision', 'targetState', 'reconciliationToken']) ||
    value.targetRevision !== prepared.target.revision ||
    value.targetState !== prepared.target.state ||
    typeof value.reconciliationToken !== 'string' ||
    value.reconciliationToken.length < 16 ||
    value.reconciliationToken.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value.reconciliationToken)
  ) {
    return null;
  }
  return Object.freeze({
    status: 'reconciliation_required',
    reconciliationToken: value.reconciliationToken,
  });
}

class GovernanceAuthorityHttpClient implements GovernanceAuthorityGoPort {
  readonly #origin: string;
  readonly #workspaceId: string;
  readonly #callerId: string;
  readonly #build: string;
  readonly #expiresAt: number;
  readonly #timeoutMs: number;
  readonly #maximum: number;
  readonly #fetch: GovernanceAuthorityFetch;
  readonly #now: () => number;

  constructor(options: GovernanceAuthorityHttpOptions) {
    const networkMode = options.networkMode ?? 'loopback';
    if (networkMode !== 'loopback' && networkMode !== 'internal') {
      policyError('Governance authority network mode is invalid.');
    }
    this.#origin = normalizeOrigin(options.origin, networkMode);
    this.#workspaceId = safeIdentifier(options.workspaceId, 'workspaceId');
    this.#callerId = safeIdentifier(options.callerId, 'callerId');
    if (!BUILD_SHA.test(options.expectedBuildSha)) {
      policyError('expectedBuildSha must be 64 lowercase hexadecimal characters.');
    }
    this.#build = options.expectedBuildSha;
    if (!validTimestamp(options.expiresAt)) {
      policyError('expiresAt must be a canonical timestamp.');
    }
    this.#expiresAt = Date.parse(options.expiresAt);
    this.#timeoutMs = positiveInteger(
      options.timeoutMs ?? GOVERNANCE_AUTHORITY_HTTP_LIMITS.defaultTimeoutMs,
      GOVERNANCE_AUTHORITY_HTTP_LIMITS.maxTimeoutMs,
      'timeoutMs',
    );
    this.#maximum = positiveInteger(
      options.maxResponseBytes ?? GOVERNANCE_AUTHORITY_HTTP_LIMITS.defaultResponseBytes,
      GOVERNANCE_AUTHORITY_HTTP_LIMITS.maxResponseBytes,
      'maxResponseBytes',
    );
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    Object.freeze(this);
  }

  #assertActive(): void {
    let now: number;
    try {
      now = this.#now();
    } catch {
      now = Number.NaN;
    }
    if (!Number.isFinite(now) || now < 0 || now >= this.#expiresAt) {
      policyError('Governance authority binding is expired or its clock is invalid.');
    }
  }

  #headers(route: GovernedPlanAuthorityRoute, idempotencyKey?: string): Headers {
    if (
      route.backend !== 'go' ||
      route.authority !== 'governance-control' ||
      !Number.isSafeInteger(route.routingEpoch) ||
      route.routingEpoch < 1
    ) {
      policyError('Governance authority route is invalid.');
    }
    const headers = new Headers({
      'X-OpenSlack-Governance-Caller-ID': this.#callerId,
      'X-OpenSlack-Governance-Workspace-ID': this.#workspaceId,
      'X-OpenSlack-Governance-Routing-Epoch': String(route.routingEpoch),
      'X-OpenSlack-Governance-Expected-Build-SHA': this.#build,
    });
    if (idempotencyKey !== undefined) {
      headers.set('Content-Type', 'application/json');
      headers.set('Idempotency-Key', idempotencyKey);
    }
    return headers;
  }

  async #request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref?.();
    // The signal intentionally remains armed while the response body streams;
    // the authority deadline covers headers and bounded body consumption.
    return this.#fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
  }

  async #receiptFromResponse(
    response: Response,
    prepared: PreparedMutation,
    source: 'mutation' | 'readback',
  ): Promise<ReturnType<typeof parseReceipt>> {
    if (response.status >= 300 && response.status < 400) {
      await cancelBody(response);
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_HTTP_ERROR',
        'Governance authority redirects are forbidden.',
      );
    }
    if (response.status === 409) {
      await cancelBody(response);
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_CONFLICT',
        'Governance authority rejected a conflicting transition.',
      );
    }
    if (![200, 201, 202].includes(response.status)) {
      await cancelBody(response);
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_HTTP_ERROR',
        'Governance authority returned an unexpected HTTP status.',
      );
    }
    const contentType = response.headers.get('Content-Type');
    if (
      contentType === null ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType.trim())
    ) {
      await cancelBody(response);
      return null;
    }
    const receipt = parseReceipt(await readBounded(response, this.#maximum), prepared, {
      workspaceId: this.#workspaceId,
      callerId: this.#callerId,
      build: this.#build,
    });
    const statusMatchesBody =
      receipt !== null &&
      (source === 'readback'
        ? response.status === 200
        : (receipt.status === 'accepted' && response.status === 201) ||
          (receipt.status === 'duplicate' && response.status === 200) ||
          (receipt.status === 'reconciliation_required' && response.status === 202));
    if (receipt !== null && !statusMatchesBody) {
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_RECEIPT_INVALID',
        'Governance authority HTTP status does not match its receipt status.',
      );
    }
    if (response.status === 202) {
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_EXECUTION_UNCERTAIN',
        'Governance authority commit outcome requires reconciliation.',
        receipt?.status === 'reconciliation_required' ? receipt.reconciliationToken : undefined,
      );
    }
    return receipt;
  }

  async #recoverReceipt(prepared: PreparedMutation): Promise<GovernedPlanRecord> {
    let response: Response;
    try {
      response = await this.#request(
        `${this.#origin}/v1/governance/receipts/${prepared.idempotencyKey}`,
        { method: 'GET', headers: this.#headers(prepared.route) },
      );
    } catch {
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_EXECUTION_UNCERTAIN',
        'Governance authority response was lost and durable receipt readback failed.',
      );
    }
    if (response.status === 404) {
      await cancelBody(response);
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_EXECUTION_UNCERTAIN',
        'Governance authority response was lost and no durable receipt was found.',
      );
    }
    let receipt;
    try {
      receipt = await this.#receiptFromResponse(response, prepared, 'readback');
    } catch (error) {
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_EXECUTION_UNCERTAIN',
        'Governance authority durable receipt readback was interrupted or invalid.',
        error instanceof GovernanceAuthorityHttpError ? error.reconciliationToken : undefined,
      );
    }
    if (!receipt || receipt.status === 'reconciliation_required') {
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_EXECUTION_UNCERTAIN',
        'Governance authority durable receipt readback was invalid or uncertain.',
        receipt?.status === 'reconciliation_required' ? receipt.reconciliationToken : undefined,
      );
    }
    return receipt.record;
  }

  async #mutate(prepared: PreparedMutation): Promise<GovernedPlanRecord> {
    this.#assertActive();
    let response: Response;
    try {
      response = await this.#request(`${this.#origin}${prepared.path}`, {
        method: 'POST',
        headers: this.#headers(prepared.route, prepared.idempotencyKey),
        body: prepared.body,
      });
    } catch {
      return this.#recoverReceipt(prepared);
    }
    if (response.status === 408 || response.status >= 500) {
      await cancelBody(response);
      return this.#recoverReceipt(prepared);
    }
    let receipt;
    try {
      receipt = await this.#receiptFromResponse(response, prepared, 'mutation');
    } catch (error) {
      if (
        error instanceof GovernanceAuthorityHttpError &&
        (error.code === 'GOVERNANCE_AUTHORITY_EXECUTION_UNCERTAIN' ||
          error.code === 'GOVERNANCE_AUTHORITY_CONFLICT' ||
          error.code === 'GOVERNANCE_AUTHORITY_HTTP_ERROR' ||
          error.code === 'GOVERNANCE_AUTHORITY_RECEIPT_INVALID')
      ) {
        throw error;
      }
      return this.#recoverReceipt(prepared);
    }
    if (!receipt || receipt.status === 'reconciliation_required') {
      return this.#recoverReceipt(prepared);
    }
    return receipt.record;
  }

  async accept(
    recordValue: GovernedPlanRecord,
    route: GovernedPlanAuthorityRoute,
  ): Promise<GovernedPlanRecord> {
    const record = validateGovernedPlanRecord(recordValue);
    return this.#mutate(
      prepareMutation({
        operation: 'accept',
        expectedRevision: 0,
        target: record,
        route,
        callerId: this.#callerId,
        workspaceId: this.#workspaceId,
        expectedBuildSha: this.#build,
      }),
    );
  }

  async transition(
    operation: GovernanceAuthorityTransitionOperation,
    targetValue: GovernedPlanRecord,
    expectedRevision: number,
    route: GovernedPlanAuthorityRoute,
  ): Promise<GovernedPlanRecord> {
    const target = validateGovernedPlanRecord(targetValue);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      policyError('Governance authority transition revision is invalid.');
    }
    return this.#mutate(
      prepareMutation({
        operation,
        expectedRevision,
        target,
        route,
        callerId: this.#callerId,
        workspaceId: this.#workspaceId,
        expectedBuildSha: this.#build,
      }),
    );
  }

  async load(
    planId: string,
    route: GovernedPlanAuthorityRoute,
  ): Promise<GovernedPlanRecord | null> {
    this.#assertActive();
    let response: Response;
    try {
      response = await this.#request(
        `${this.#origin}/v1/governance/plans/${encodeURIComponent(planId)}`,
        { method: 'GET', headers: this.#headers(route) },
      );
    } catch {
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_EXECUTION_UNCERTAIN',
        'Governance authority plan read failed closed.',
      );
    }
    if (response.status === 404) {
      await cancelBody(response);
      return null;
    }
    if (response.status !== 200) {
      await cancelBody(response);
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_HTTP_ERROR',
        'Governance authority plan read returned an unexpected status.',
      );
    }
    const contentType = response.headers.get('Content-Type');
    if (
      contentType === null ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType.trim())
    ) {
      await cancelBody(response);
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_RECEIPT_INVALID',
        'Governance authority plan read content type is invalid.',
      );
    }
    let value: Readonly<Record<string, unknown>> | null;
    try {
      value = parseCanonical(await readBounded(response, this.#maximum));
    } catch {
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_EXECUTION_UNCERTAIN',
        'Governance authority plan read body was interrupted.',
      );
    }
    if (
      !value ||
      !exactKeys(value, [
        'schema',
        'workspaceId',
        'planId',
        'route',
        'recordHash',
        'record',
        'serviceBuildSha',
      ]) ||
      value.schema !== READ_SCHEMA ||
      value.workspaceId !== this.#workspaceId ||
      value.planId !== planId ||
      !validateRoute(value.route, route) ||
      value.serviceBuildSha !== this.#build
    ) {
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_RECEIPT_INVALID',
        'Governance authority plan read binding is invalid.',
      );
    }
    let record: GovernedPlanRecord;
    try {
      record = validateGovernedPlanRecord(value.record);
    } catch {
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_RECEIPT_INVALID',
        'Governance authority plan read record is invalid.',
      );
    }
    if (
      record.planId !== planId ||
      record.bindings.workspaceId !== this.#workspaceId ||
      value.recordHash !== recordHash(record)
    ) {
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_RECEIPT_INVALID',
        'Governance authority plan read record binding is invalid.',
      );
    }
    return record;
  }

  async pendingAudit(
    planId: string,
    revision: number,
    route: GovernedPlanAuthorityRoute,
  ): Promise<GovernanceAuthorityPendingAudit | null> {
    this.#assertActive();
    safeIdentifier(planId, 'planId');
    if (!Number.isSafeInteger(revision) || revision < 1) {
      policyError('Governance authority pending audit revision is invalid.');
    }
    let response: Response;
    try {
      response = await this.#request(
        `${this.#origin}/v1/governance/plans/${encodeURIComponent(planId)}/authority-events/${revision}:pending`,
        { method: 'GET', headers: this.#headers(route) },
      );
    } catch {
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_EXECUTION_UNCERTAIN',
        'Governance authority pending audit read failed closed.',
      );
    }
    if (response.status === 404) {
      await cancelBody(response);
      return null;
    }
    if (response.status !== 200) {
      await cancelBody(response);
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_HTTP_ERROR',
        'Governance authority pending audit read returned an unexpected status.',
      );
    }
    const contentType = response.headers.get('Content-Type');
    if (
      contentType === null ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType.trim())
    ) {
      await cancelBody(response);
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_RECEIPT_INVALID',
        'Governance authority pending audit content type is invalid.',
      );
    }
    let value: Readonly<Record<string, unknown>> | null;
    try {
      value = parseCanonical(await readBounded(response, this.#maximum));
    } catch {
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_EXECUTION_UNCERTAIN',
        'Governance authority pending audit body was interrupted.',
      );
    }
    if (
      !value ||
      !exactKeys(value, [
        'schema',
        'status',
        'workspaceId',
        'planId',
        'revision',
        'operation',
        'route',
        'recordHash',
        'serviceBuildSha',
      ]) ||
      value.schema !== PENDING_AUDIT_SCHEMA ||
      value.status !== 'pending' ||
      value.workspaceId !== this.#workspaceId ||
      value.planId !== planId ||
      value.revision !== revision ||
      typeof value.operation !== 'string' ||
      !AUTHORITY_OPERATIONS.has(value.operation as GovernanceAuthorityMutationOperation) ||
      !validateRoute(value.route, route) ||
      typeof value.recordHash !== 'string' ||
      !BUILD_SHA.test(value.recordHash) ||
      value.serviceBuildSha !== this.#build
    ) {
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_RECEIPT_INVALID',
        'Governance authority pending audit binding is invalid.',
      );
    }
    return Object.freeze({
      operation: value.operation as GovernanceAuthorityMutationOperation,
      recordHash: value.recordHash,
    });
  }

  async recordAudit(
    event: GovernedPlanAuditEvent,
    route: GovernedPlanAuthorityRoute,
  ): Promise<void> {
    this.#assertActive();
    if (event.workspaceId !== this.#workspaceId) {
      policyError('Governance authority audit workspace binding is invalid.');
    }
    const path = `/v1/governance/plans/${encodeURIComponent(event.planId)}/authority-events/${event.revision}:record`;
    const body = `${canonicalGovernedJson(event)}\n`;
    const eventHash = createHash('sha256').update(body, 'utf8').digest('hex');
    const idempotencyKey = `openslack.governance-authority-audit.v1.${eventHash}`;
    const requestFingerprint = `sha256:${createHash('sha256')
      .update(
        `POST\n${path}\n${this.#callerId}\n${this.#workspaceId}\n${route.routingEpoch}\n${this.#build}\n${body}`,
        'utf8',
      )
      .digest('hex')}`;
    const request = async (): Promise<Response> =>
      this.#request(`${this.#origin}${path}`, {
        method: 'POST',
        headers: this.#headers(route, idempotencyKey),
        body,
      });
    let response: Response;
    try {
      response = await request();
    } catch {
      // Audit acknowledgement is itself idempotent and has no external effect;
      // repeating the same exact body/key is the only available receipt readback.
      try {
        response = await request();
      } catch {
        throw new GovernanceAuthorityHttpError(
          'GOVERNANCE_AUTHORITY_EXECUTION_UNCERTAIN',
          'Governance authority audit acknowledgement is uncertain.',
        );
      }
    }
    if (response.status === 408 || response.status >= 500) {
      await cancelBody(response);
      try {
        response = await request();
      } catch {
        throw new GovernanceAuthorityHttpError(
          'GOVERNANCE_AUTHORITY_EXECUTION_UNCERTAIN',
          'Governance authority audit acknowledgement is uncertain.',
        );
      }
    }
    if (response.status === 408 || response.status >= 500) {
      await cancelBody(response);
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_EXECUTION_UNCERTAIN',
        'Governance authority audit acknowledgement remained uncertain after exact replay.',
      );
    }
    if (response.status === 409) {
      await cancelBody(response);
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_CONFLICT',
        'Governance authority audit acknowledgement conflicts with durable state.',
      );
    }
    if (response.status !== 200 && response.status !== 201) {
      await cancelBody(response);
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_HTTP_ERROR',
        'Governance authority audit acknowledgement returned an unexpected status.',
      );
    }
    const contentType = response.headers.get('Content-Type');
    if (
      contentType === null ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType.trim())
    ) {
      await cancelBody(response);
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_RECEIPT_INVALID',
        'Governance authority audit acknowledgement content type is invalid.',
      );
    }
    let value: Readonly<Record<string, unknown>> | null;
    try {
      value = parseCanonical(await readBounded(response, this.#maximum));
    } catch {
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_EXECUTION_UNCERTAIN',
        'Governance authority audit acknowledgement body was interrupted.',
      );
    }
    if (
      !value ||
      !exactKeys(value, [
        'schema',
        'status',
        'workspaceId',
        'planId',
        'revision',
        'eventId',
        'eventHash',
        'idempotencyKey',
        'requestFingerprint',
        'recordedAt',
      ]) ||
      value.schema !== AUDIT_RECEIPT_SCHEMA ||
      (value.status !== 'recorded' && value.status !== 'duplicate') ||
      (value.status === 'recorded' ? response.status !== 201 : response.status !== 200) ||
      value.workspaceId !== this.#workspaceId ||
      value.planId !== event.planId ||
      value.revision !== event.revision ||
      value.eventId !== event.eventId ||
      value.eventHash !== eventHash ||
      value.idempotencyKey !== idempotencyKey ||
      value.requestFingerprint !== requestFingerprint ||
      !validTimestamp(value.recordedAt)
    ) {
      throw new GovernanceAuthorityHttpError(
        'GOVERNANCE_AUTHORITY_RECEIPT_INVALID',
        'Governance authority audit acknowledgement receipt is invalid.',
      );
    }
  }
}

export function createGovernanceAuthorityHttpClient(
  options: GovernanceAuthorityHttpOptions,
): GovernanceAuthorityGoPort {
  return registerGovernanceAuthorityGoPort(new GovernanceAuthorityHttpClient(options));
}

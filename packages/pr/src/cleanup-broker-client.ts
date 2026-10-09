import { decodeStrictJSON } from '@openslack/core';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { PR_BRANCH_CLEANUP_STATES, type PRBranchCleanupState } from './cleanup-types.js';

const SOCKET = '/run/openslack-cleanup/broker.sock';
const MAX_RESPONSE_BYTES = 16 * 1024;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const modes = ['preview', 'execute', 'status'] as const;

export interface CleanupBrokerRequest {
  schema: 'openslack.cleanup_request.v1';
  mode: (typeof modes)[number];
  /** Claimed identity only. The broker must authenticate its operating-system peer. */
  agentId: string;
  principalId: string;
  runtimeUid: string;
  runId: string;
  repo: string;
  remote: string;
  prNumber: number;
  permitId: string;
  operationId?: string;
}

export interface CleanupBrokerResponse {
  schema: 'openslack.cleanup_response.v1';
  mode: CleanupBrokerRequest['mode'];
  permitId: string;
  operationId?: string;
  permitState:
    | 'issued'
    | 'reserved'
    | 'consumed'
    | 'reconciliation_required'
    | 'revoked'
    | 'expired'
    | 'unknown';
  claimRequirement: 'not_required';
  claimStatus: 'not_evaluated';
  state: PRBranchCleanupState | 'BLOCKED_BROKER' | 'OPERATION_NOT_FOUND' | 'OPERATION_IN_PROGRESS';
  attempted: boolean;
  auditStatus: 'NOT_REQUIRED' | 'RECORDED' | 'FAILED';
  reason: string;
}

export type CleanupBrokerClientErrorCode =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_PLATFORM'
  | 'BROKER_UNAVAILABLE'
  | 'BROKER_TIMEOUT'
  | 'BROKER_INVALID_RESPONSE';

export class CleanupBrokerClientError extends Error {
  constructor(
    public readonly code: CleanupBrokerClientErrorCode,
    public readonly outcomeUnknown = false,
  ) {
    super(
      `Cleanup broker: ${code}.${outcomeUnknown ? ' Query status with the same operation ID; do not repeat execute.' : ''}`,
    );
    this.name = 'CleanupBrokerClientError';
  }
}

const requestKeys = [
  'schema',
  'mode',
  'agentId',
  'principalId',
  'runtimeUid',
  'runId',
  'repo',
  'remote',
  'prNumber',
  'permitId',
];
const responseKeys = [
  'schema',
  'mode',
  'permitId',
  'permitState',
  'claimRequirement',
  'claimStatus',
  'state',
  'attempted',
  'auditStatus',
  'reason',
];
export const CLEANUP_BROKER_STATES = [
  ...PR_BRANCH_CLEANUP_STATES,
  'BLOCKED_BROKER',
  'OPERATION_NOT_FOUND',
  'OPERATION_IN_PROGRESS',
] as const;
export const CLEANUP_PERMIT_ONLY_CLAIM = Object.freeze({
  claimRequirement: 'not_required',
  claimStatus: 'not_evaluated',
} as const);
const states = new Set<string>(CLEANUP_BROKER_STATES);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[], operation: boolean): boolean {
  const expected = operation ? [...keys, 'operationId'] : keys;
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function validateRequest(value: unknown): asserts value is CleanupBrokerRequest {
  if (
    !record(value) ||
    !modes.includes(value.mode as CleanupBrokerRequest['mode']) ||
    !exactKeys(value, requestKeys, value.mode !== 'preview') ||
    value.schema !== 'openslack.cleanup_request.v1' ||
    typeof value.agentId !== 'string' ||
    !identifier.test(value.agentId) ||
    typeof value.remote !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value.remote) ||
    !['principalId', 'runtimeUid', 'runId'].every(
      (key) =>
        typeof value[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value[key]),
    ) ||
    typeof value.permitId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.permitId) ||
    typeof value.repo !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value.repo) ||
    !Number.isSafeInteger(value.prNumber) ||
    (value.prNumber as number) <= 0 ||
    (value.mode !== 'preview' &&
      (typeof value.operationId !== 'string' || !identifier.test(value.operationId)))
  ) {
    throw new CleanupBrokerClientError('INVALID_REQUEST');
  }
}

function validateResponse(
  value: unknown,
  input: CleanupBrokerRequest,
): value is CleanupBrokerResponse {
  if (
    !record(value) ||
    !exactKeys(value, responseKeys, input.mode !== 'preview') ||
    value.schema !== 'openslack.cleanup_response.v1' ||
    value.mode !== input.mode ||
    value.permitId !== input.permitId ||
    value.operationId !== input.operationId ||
    ![
      'issued',
      'reserved',
      'consumed',
      'reconciliation_required',
      'revoked',
      'expired',
      'unknown',
    ].includes(value.permitState as string) ||
    value.claimRequirement !== CLEANUP_PERMIT_ONLY_CLAIM.claimRequirement ||
    value.claimStatus !== CLEANUP_PERMIT_ONLY_CLAIM.claimStatus ||
    typeof value.state !== 'string' ||
    !states.has(value.state) ||
    typeof value.attempted !== 'boolean' ||
    !['NOT_REQUIRED', 'RECORDED', 'FAILED'].includes(value.auditStatus as string) ||
    typeof value.reason !== 'string' ||
    !/^[A-Z][A-Z0-9_]{0,127}$/.test(value.reason)
  )
    return false;
  if (
    input.mode === 'preview' &&
    (value.attempted || ['DELETED', 'ABSENT_AFTER_ATTEMPT'].includes(value.state))
  )
    return false;
  if (
    value.attempted &&
    (value.state === 'ALREADY_ABSENT' ||
      value.state === 'OPERATION_NOT_FOUND' ||
      (value.state.startsWith('BLOCKED_') && value.state !== 'BLOCKED_SHA_DRIFT'))
  )
    return false;
  if (
    value.state === 'BLOCKED_SHA_DRIFT' &&
    value.attempted &&
    (value.permitState !== 'consumed' || value.auditStatus !== 'RECORDED')
  )
    return false;
  if (['DELETED', 'ABSENT_AFTER_ATTEMPT'].includes(value.state) && !value.attempted) return false;
  if (
    value.state === 'DELETED' &&
    (value.permitState !== 'consumed' || value.auditStatus !== 'RECORDED')
  )
    return false;
  if (
    value.state === 'CLEANUP_READY' &&
    (input.mode !== 'preview' || value.permitState !== 'issued' || value.attempted)
  )
    return false;
  if (
    ['reserved', 'reconciliation_required'].includes(value.permitState as string) &&
    ['DELETED', 'ALREADY_ABSENT', 'CLEANUP_READY'].includes(value.state)
  )
    return false;
  return true;
}

/** Test seam only; not exported from the package. Production endpoint has no override. */
export function createCleanupBrokerClientForTesting(dependencies: {
  platform: NodeJS.Platform;
  request: typeof httpRequest;
}): typeof sendCleanupBrokerRequest {
  return (input, options) => send(input, options, dependencies);
}

/** Sends no credential, never retries, and does not authenticate caller-supplied identity fields. */
export function sendCleanupBrokerRequest(
  input: CleanupBrokerRequest,
  options: { timeoutMs?: number } = {},
): Promise<CleanupBrokerResponse> {
  return send(input, options, { platform: process.platform, request: httpRequest });
}

async function send(
  input: CleanupBrokerRequest,
  options: { timeoutMs?: number } = {},
  dependencies: { platform: NodeJS.Platform; request: typeof httpRequest },
): Promise<CleanupBrokerResponse> {
  validateRequest(input);
  if (!record(options) || Object.keys(options).some((key) => key !== 'timeoutMs'))
    throw new CleanupBrokerClientError('INVALID_REQUEST');
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
    throw new CleanupBrokerClientError('INVALID_REQUEST');
  if (dependencies.platform !== 'linux') throw new CleanupBrokerClientError('UNSUPPORTED_PLATFORM');
  const owned: CleanupBrokerRequest = { ...input };
  const body = JSON.stringify(owned);
  return new Promise((resolve, reject) => {
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let dispatched = false;
    let finished = false;
    const timer = setTimeout(() => fail('BROKER_TIMEOUT'), timeoutMs);
    function fail(code: CleanupBrokerClientErrorCode) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new CleanupBrokerClientError(code, owned.mode === 'execute' && dispatched));
      response?.destroy();
      request?.destroy();
    }
    try {
      request = dependencies.request(
        {
          socketPath: SOCKET,
          path: '/v1/cleanup',
          method: 'POST',
          agent: false,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          maxHeaderSize: 8192,
        },
        (incoming) => {
          response = incoming;
          const type = incoming.headers['content-type'];
          if (
            incoming.statusCode !== 200 ||
            typeof type !== 'string' ||
            !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type) ||
            incoming.headers['content-encoding']
          ) {
            fail('BROKER_INVALID_RESPONSE');
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          incoming.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_RESPONSE_BYTES) fail('BROKER_INVALID_RESPONSE');
            else chunks.push(chunk);
          });
          incoming.on('aborted', () => fail('BROKER_INVALID_RESPONSE'));
          incoming.on('error', () => fail('BROKER_INVALID_RESPONSE'));
          incoming.on('end', () => {
            if (finished) return;
            try {
              const value = decodeStrictJSON(Buffer.concat(chunks), MAX_RESPONSE_BYTES);
              if (!validateResponse(value, owned)) {
                fail('BROKER_INVALID_RESPONSE');
                return;
              }
              finished = true;
              clearTimeout(timer);
              resolve(value);
            } catch {
              fail('BROKER_INVALID_RESPONSE');
            }
          });
        },
      );
      request.on('error', () => fail('BROKER_UNAVAILABLE'));
      dispatched = true;
      request.end(body);
    } catch {
      fail('BROKER_UNAVAILABLE');
    }
  });
}

import { parseGitHubRepoSpec } from '@openslack/github/repo-spec';
import {
  validateCleanupBrokerRequest,
  type CleanupBrokerRequest,
} from './cleanup-broker-client.js';
import {
  assertCleanupOperationRecord,
  type CleanupOperationQueryRecord,
} from './cleanup-operation-record.js';

export class CleanupRequestInputError extends Error {}

/** Decimal input syntax shared by both application entries. */
export function parseCleanupPositiveInteger(
  value: string,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed) || parsed > maximum)
    throw new CleanupRequestInputError(
      `${name} must be a positive safe integer no greater than ${maximum}.`,
    );
  return parsed;
}

export function parseCleanupRepository(value: string): string {
  const target = parseGitHubRepoSpec(value);
  if (!target) throw new CleanupRequestInputError('--repo must identify a GitHub owner/name.');
  return `${target.owner}/${target.repo}`;
}

export type CleanupRequestBinding = Pick<
  CleanupBrokerRequest,
  | 'agentId'
  | 'principalId'
  | 'runtimeUid'
  | 'runId'
  | 'repo'
  | 'remote'
  | 'prNumber'
  | 'permitId'
  | 'operationId'
>;
const bindingLabels: Record<keyof CleanupRequestBinding, string> = {
  agentId: '--agent-id',
  principalId: '--principal-id',
  runtimeUid: '--runtime-uid',
  runId: '--run-id',
  repo: '--repo',
  remote: '--remote',
  prNumber: 'PR number',
  permitId: '--permit-id',
  operationId: '--operation-id',
};

/** Explicit values only check the original binding; they never replace it. */
export function buildCleanupStatusRequest(
  record: CleanupOperationQueryRecord,
  explicit: Partial<CleanupRequestBinding> = {},
): CleanupBrokerRequest {
  const validated = assertCleanupOperationRecord(record);
  const conflicts = (Object.keys(bindingLabels) as (keyof CleanupRequestBinding)[])
    .filter((key) => explicit[key] !== undefined && explicit[key] !== validated.request[key])
    .map((key) => bindingLabels[key]);
  if (conflicts.length)
    throw new CleanupRequestInputError(
      `--operation-record conflicts with ${conflicts.join(', ')}.`,
    );
  const request: CleanupBrokerRequest = { ...validated.request, mode: 'status' };
  validateCleanupBrokerRequest(request);
  return request;
}

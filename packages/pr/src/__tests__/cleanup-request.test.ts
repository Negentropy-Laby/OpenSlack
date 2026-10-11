import { describe, expect, it } from 'vitest';
import { buildCleanupOperationRecord } from '../cleanup-operation-record.js';
import {
  buildCleanupStatusRequest,
  parseCleanupPositiveInteger,
  parseCleanupRepository,
} from '../cleanup-request.js';
import { isSensitiveCleanupInput } from '../internal/cleanup-validation.js';

const record = Object.freeze(
  buildCleanupOperationRecord({
    schema: 'openslack.cleanup_request.v1',
    mode: 'execute',
    agentId: 'worker',
    principalId: 'principal:worker',
    runtimeUid: 'worker',
    runId: 'run-1',
    repo: 'owner/repo',
    remote: 'origin',
    prNumber: 417,
    permitId: 'PERMIT-1',
    operationId: 'OP-1',
  }),
);
describe('shared cleanup request binding', () => {
  it.each([
    'agentId',
    'principalId',
    'runtimeUid',
    'runId',
    'repo',
    'remote',
    'prNumber',
    'permitId',
    'operationId',
  ] as const)('checks explicit %s without replacing any original claim', (field) => {
    const unchanged = JSON.stringify(record);
    expect(buildCleanupStatusRequest(record, { [field]: record.request[field] })).toEqual({
      ...record.request,
      mode: 'status',
    });
    expect(() =>
      buildCleanupStatusRequest(record, { [field]: field === 'prNumber' ? 418 : 'different' }),
    ).toThrow('conflicts');
    expect(JSON.stringify(record)).toBe(unchanged);
  });
  it.each([
    'owner/repo',
    ' https://github.com/owner/repo.git ',
    'git@github.com:owner/repo.git',
    'github.com/owner/repo',
  ])('normalizes repository %s before comparing', (value) => {
    expect(buildCleanupStatusRequest(record, { repo: parseCleanupRepository(value) }).repo).toBe(
      'owner/repo',
    );
  });
  it.each(['0', '-1', '0x1a1', '4.17e2', '417.0', ' 417 ', '9007199254740992'])(
    'refuses noncanonical integer %s',
    (value) => {
      expect(() => parseCleanupPositiveInteger(value, 'PR number')).toThrow(
        'positive safe integer',
      );
    },
  );
  it('never turns a record into an execute request', () => {
    expect(buildCleanupStatusRequest(record).mode).toBe('status');
    expect(record.request.mode).toBe('execute');
  });
  it.each([
    'private/history.json',
    'prod-tokens/history.json',
    'credentials/history.json',
    'secrets/history.json',
    '.env',
    'key.pem',
  ])('refuses declared-root sensitive input %s without touching files', (value) => {
    expect(isSensitiveCleanupInput(`/work/repo/${value}`, '/work/repo')).toBe(true);
  });
  it('does not treat the macOS system temporary prefix as a repository Black path', () => {
    expect(
      isSensitiveCleanupInput('/private/var/folders/fixture/evidence.json', '/work/repo'),
    ).toBe(false);
  });
});

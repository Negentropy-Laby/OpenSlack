import {
  createServer,
  request,
  type Server,
  type ServerResponse,
  type RequestOptions,
  type IncomingMessage,
} from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCleanupBrokerClientForTesting,
  type CleanupBrokerRequest,
  type CleanupBrokerResponse,
} from '../cleanup-broker-client.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function input(mode: CleanupBrokerRequest['mode'] = 'preview'): CleanupBrokerRequest {
  return {
    schema: 'openslack.cleanup_request.v1',
    mode,
    agentId: 'agent',
    principalId: 'principal:agent',
    runtimeUid: 'uid',
    runId: 'RUN-1',
    repo: 'owner/repo',
    remote: 'qualification',
    prNumber: 12,
    permitId: 'PERMIT-1',
    ...(mode === 'preview' ? {} : { operationId: 'OP-1' }),
  };
}
function reply(value: CleanupBrokerRequest): CleanupBrokerResponse {
  return {
    schema: 'openslack.cleanup_response.v1',
    mode: value.mode,
    permitId: value.permitId,
    ...(value.operationId ? { operationId: value.operationId } : {}),
    permitState: 'issued',
    claimRequirement: 'not_required',
    claimStatus: 'not_evaluated',
    state: 'CLEANUP_READY',
    attempted: false,
    auditStatus: 'NOT_REQUIRED',
    reason: 'CLEANUP_READY',
    ...(value.mode !== 'preview'
      ? {
          permitState: 'consumed',
          state: 'DELETED',
          attempted: true,
          auditStatus: 'RECORDED',
          reason: 'CLEANUP_DELETED',
        }
      : {}),
  };
}
async function fixture(handle: (value: CleanupBrokerRequest, response: ServerResponse) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'cleanup-client-'));
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\cleanup-client-${process.pid}-${directory.split(/[\\/]/).at(-1)}`
      : join(directory, 'broker.sock');
  let calls = 0;
  const server: Server = createServer((incoming, response) => {
    calls++;
    expect(incoming.method).toBe('POST');
    expect(incoming.url).toBe('/v1/cleanup');
    expect(incoming.headers.authorization).toBeUndefined();
    let body = '';
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => {
      body += chunk;
    });
    incoming.on('end', () => handle(JSON.parse(body), response));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  const client = createCleanupBrokerClientForTesting({
    platform: 'linux',
    request: ((options: RequestOptions, callback?: (response: IncomingMessage) => void) => {
      expect(options.socketPath).toBe('/run/openslack-cleanup/broker.sock');
      expect(options.agent).toBe(false);
      return request({ ...options, socketPath }, callback);
    }) as typeof request,
  });
  return { client, calls: () => calls };
}

describe('cleanup broker Unix socket client contract', () => {
  it.each(['preview', 'execute', 'status'] as const)(
    'sends bounded %s protocol once without credentials',
    async (mode) => {
      const f = await fixture((value, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(reply(value)));
      });
      expect(await f.client(input(mode))).toEqual(reply(input(mode)));
      expect(f.calls()).toBe(1);
    },
  );

  it('owns request fields before an asynchronous response', async () => {
    const f = await fixture((value, res) => {
      expect(value.repo).toBe('owner/repo');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(reply(value)));
    });
    const value = input();
    const pending = f.client(value);
    value.permitId = 'changed';
    value.repo = 'another/repository';
    await expect(pending).resolves.toMatchObject({ permitId: 'PERMIT-1' });
  });

  it.each([
    { operationId: 'unexpected' },
    { token: 'never-send' },
    { socketPath: '/tmp/evil' },
    { agentId: '../agent' },
    { principalId: '\n' },
    { runtimeUid: 'a'.repeat(129) },
    { repo: 'https://github.com/owner/repo' },
    { repo: 'owner/*' },
    { remote: '-evil' },
    { remote: 'a'.repeat(101) },
    { prNumber: 0 },
    { prNumber: 1.5 },
    { schema: 'future' },
    { mode: 'delete' },
  ])('rejects malformed or extra fields before transport: %j', async (patch) => {
    const transport = vi.fn();
    const client = createCleanupBrokerClientForTesting({
      platform: 'linux',
      request: transport as typeof request,
    });
    await expect(client({ ...input(), ...patch } as CleanupBrokerRequest)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      outcomeUnknown: false,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['execute', 'status'] as const)('requires explicit operation ID for %s', async (mode) => {
    const value = input(mode);
    delete value.operationId;
    const client = createCleanupBrokerClientForTesting({
      platform: 'linux',
      request: vi.fn() as typeof request,
    });
    await expect(client(value)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it.each(['win32', 'darwin'] as const)('fails closed on unsupported host %s', async (platform) => {
    const transport = vi.fn();
    const client = createCleanupBrokerClientForTesting({
      platform,
      request: transport as typeof request,
    });
    await expect(client(input())).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    { schema: 'future' },
    { permitId: 'wrong' },
    { operationId: 'wrong' },
    { mode: 'preview' },
    { state: 'SUCCESS' },
    { claimStatus: 'verified' },
    { secret: 'unexpected' },
    { state: 'DELETED', attempted: false },
    { reason: 'unsafe raw server text' },
    { permitState: 'issued' },
    { permitState: 'reserved' },
    { auditStatus: 'NOT_REQUIRED' },
    { auditStatus: 'FAILED' },
    { state: 'CLEANUP_READY' },
  ])('rejects inconsistent execute response and never retries: %j', async (patch) => {
    const f = await fixture((value, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ...reply(value), ...patch }));
    });
    await expect(f.client(input('execute'))).rejects.toMatchObject({
      code: 'BROKER_INVALID_RESPONSE',
      outcomeUnknown: true,
    });
    expect(f.calls()).toBe(1);
  });

  it.each([
    'duplicate',
    'oversize',
    'invalid-json',
    'invalid-utf8',
    'redirect',
    'html',
    'compressed',
    'partial',
  ])('rejects %s response without exposing payload', async (kind) => {
    const f = await fixture((value, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (kind === 'duplicate')
        res.end(JSON.stringify(reply(value)).replace('{', '{"state":"DELETED",'));
      if (kind === 'oversize') res.end('x'.repeat(17000));
      if (kind === 'invalid-json') res.end('server secret');
      if (kind === 'invalid-utf8') res.end(Buffer.from([0xff]));
      if (kind === 'redirect') {
        res.statusCode = 302;
        res.setHeader('Location', 'https://example.invalid');
        res.end();
      }
      if (kind === 'html') {
        res.setHeader('Content-Type', 'text/html');
        res.end('server secret');
      }
      if (kind === 'compressed') {
        res.setHeader('Content-Encoding', 'gzip');
        res.end('not gzip');
      }
      if (kind === 'partial') {
        res.setHeader('Content-Length', '500');
        res.write('{');
        res.socket?.destroy();
      }
    });
    await expect(f.client(input('execute'))).rejects.toMatchObject({ outcomeUnknown: true });
    expect(f.calls()).toBe(1);
  });

  it('bounds wall time even if the server never ends its response', async () => {
    const f = await fixture((_value, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.write('{');
    });
    await expect(f.client(input('execute'), { timeoutMs: 100 })).rejects.toMatchObject({
      code: 'BROKER_TIMEOUT',
      outcomeUnknown: true,
    });
    expect(f.calls()).toBe(1);
  });

  it.each(['RECONCILIATION_REQUIRED', 'OPERATION_IN_PROGRESS'])(
    'does not turn unresolved %s into a completed deletion',
    async (state) => {
      const f = await fixture((value, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            ...reply(value),
            permitState: 'reserved',
            state,
            attempted: true,
          }),
        );
      });
      await expect(f.client(input('status'))).resolves.toMatchObject({
        permitState: 'reserved',
        state,
      });
      expect(f.calls()).toBe(1);
    },
  );

  it.each([0, -1, 600001, NaN, 1.1])('rejects invalid timeout %s', async (timeoutMs) => {
    const transport = vi.fn();
    const client = createCleanupBrokerClientForTesting({
      platform: 'linux',
      request: transport as typeof request,
    });
    await expect(client(input(), { timeoutMs })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(transport).not.toHaveBeenCalled();
  });
});

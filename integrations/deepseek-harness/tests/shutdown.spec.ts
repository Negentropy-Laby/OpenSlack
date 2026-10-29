/** Real Cordis/public SDK composition; contained disposer errors cannot replace an owned stop receipt. */
import { PassThrough } from 'node:stream';
import { Context } from '@deepseek-ai/cordis';
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import * as SdkHost from '../src/sdk-host.ts';
import { RUNTIME_PEERS } from '../src/runtime-bindings.ts';
import { pathToFileURL } from 'node:url';
import { adoptShutdownDeadline, OWNED_SHUTDOWN_MS, shutdownBudget, shutdownDeadline, shutdownRemaining, withinShutdown } from '../src/shutdown.ts';
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server';
import type { HarnessEligibilityRestriction } from '../src/scope-evidence.ts';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import { execFileSync } from 'node:child_process';

async function setup(fails = false, startEligibility: HarnessEligibilityRestriction = { mode: 'not_applicable' }) {
  const ctx = new Context();
  onTestFinished(() => ctx.fiber.dispose());
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
  const stop = vi.fn(async (_deadline?: number) => {
    if (fails) throw new Error('fixture owned-resource stop failed');
    return { pid: 12345, code: 0, signal: null, terminationRequested: false };
  });
  ctx.provide('openslackConnection', { connected: true, tool: () => undefined, stop });
  ctx.effect(() => async () => { await stop(); });
  const input = new PassThrough();
  const output = new PassThrough();
  const responses: Array<{ id: string; result?: Record<string, unknown>; error?: unknown }> = [];
  output.on('data', bytes => {
    for (const line of String(bytes).split('\n').filter(Boolean)) responses.push(JSON.parse(line));
  });
  const exits: number[] = [];
  const entries = Object.fromEntries(RUNTIME_PEERS.map(name => [name, '/fixture-only/public-entry.js']));
  await ctx.plugin(SdkHost, { generation: 'g1', runtimeEntries: JSON.stringify(entries),
    startEligibility: JSON.stringify(startEligibility),
    resolveRuntime: name => pathToFileURL(entries[name]!).href, input, output, exit: code => { exits.push(code); } });
  const request = async (id: string, method: string, params: object = {}) => {
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    await vi.waitFor(() => expect(responses.some(response => response.id === id)).toBe(true));
    return responses.find(response => response.id === id)!;
  };
  return { ctx, stop, exits, request };
}

describe('owned shutdown duration and process-local monotonic deadlines', () => {
  it.each([0, -1, OWNED_SHUTDOWN_MS + 1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])('rejects the invalid or exhausted wire budget %s', remainingMs => {
    expect(() => shutdownBudget(remainingMs)).toThrow('Invalid owned-resource shutdown budget');
    expect(() => shutdownDeadline(remainingMs)).toThrow('Invalid owned-resource shutdown budget');
  });
  it('transfers only the unspent duration between independent monotonic clock origins', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1_000.25);
    try {
      const senderDeadline = shutdownDeadline();
      expect(senderDeadline).toBe(25_000.25);
      clock.mockReturnValue(1_001.75);
      const wireRemaining = shutdownRemaining(senderDeadline);
      expect(wireRemaining).toBe(23_998);
      clock.mockReturnValue(10.125);
      const receiverDeadline = shutdownDeadline(wireRemaining);
      expect(receiverDeadline).toBe(24_008.125);
      expect(adoptShutdownDeadline(receiverDeadline)).toBe(receiverDeadline);
      clock.mockReturnValue(25_000.25);
      expect(() => shutdownRemaining(senderDeadline)).toThrow('deadline exceeded');
    } finally { clock.mockRestore(); }
  });
  it('does not renew or expire the monotonic budget when wall-clock readings move', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    const wall = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const deadline = shutdownDeadline();
      clock.mockReturnValue(110);
      wall.mockReturnValue(-1_000_000);
      expect(shutdownRemaining(deadline)).toBe(23_990);
      wall.mockReturnValue(Number.MAX_SAFE_INTEGER);
      expect(shutdownRemaining(deadline)).toBe(23_990);
      clock.mockReturnValue(deadline);
      expect(() => adoptShutdownDeadline(deadline)).toThrow('Invalid local');
      expect(() => shutdownRemaining(deadline)).toThrow('deadline exceeded');
    } finally { wall.mockRestore(); clock.mockRestore(); }
  });
  it('passes a bounded duration to a real Node child with a deliberately earlier wall-clock reading', () => {
    const deadline = shutdownDeadline();
    const remainingMs = shutdownRemaining(deadline);
    const parentWall = Date.now();
    const script = [
      'const [entry, wall, remaining] = process.argv.slice(1);',
      'Date.now = () => Number(wall) - 1;',
      'const { shutdownDeadline, shutdownRemaining } = await import(entry);',
      'const local = shutdownDeadline(Number(remaining));',
      'process.stdout.write(JSON.stringify({ wall: Date.now(), remaining: shutdownRemaining(local) }));',
    ].join('\n');
    const actual = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script,
      new URL('../.build/fixtures/shutdown-probe.js', import.meta.url).href, String(parentWall), String(remainingMs)],
    { encoding: 'utf8', timeout: 5_000, env: { PATH: process.env.PATH } })) as { wall: number; remaining: number };
    expect(actual.wall).toBe(parentWall - 1);
    expect(actual.remaining).toBeGreaterThan(0);
    expect(actual.remaining).toBeLessThanOrEqual(remainingMs);
    expect(shutdownRemaining(deadline)).toBeLessThanOrEqual(remainingMs);
  });
  it('rejects a late resolution even before an overdue timer is dispatched', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const deadline = shutdownDeadline(10);
      await expect(withinShutdown(deadline, async () => { now = deadline; return 'late'; })).rejects.toThrow('deadline exceeded');
    } finally { clock.mockRestore(); }
  });
});

describe('external strict SDK host over the unmodified public server', () => {
  it('shares one absolute budget across serial resource phases instead of restarting each timeout', async () => {
    vi.useFakeTimers();
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const deadline = shutdownDeadline(100);
      const first = withinShutdown(deadline, () => new Promise<void>(resolve => setTimeout(resolve, 60)));
      now = 60;
      await vi.advanceTimersByTimeAsync(60);
      await first;
      const second = withinShutdown(deadline, () => new Promise<void>(resolve => setTimeout(resolve, 60)));
      const rejected = expect(second).rejects.toThrow('shutdown deadline exceeded');
      now = 100;
      await vi.advanceTimersByTimeAsync(40);
      await rejected;
    } finally { clock.mockRestore(); vi.clearAllTimers(); vi.useRealTimers(); }
  });
  it('prepares owned stops before a normal empty shutdown ACK and actual exit request', async () => {
    const { request, stop, exits } = await setup();
    const prepared = await request('prepare', 'openslack/prepare-shutdown', { generation: 'g1', remainingMs: 24_000 });
    expect(prepared.result).toMatchObject({ generation: 'g1', resources: [{ pid: 12345, code: 0 }] });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([]);
    expect((await request('shutdown', 'shutdown')).result).toEqual({});
    await vi.waitFor(() => expect(exits).toEqual([0]));
  });
  it('rejects another generation and denies host authorization while closing', async () => {
    const { ctx, request, stop, exits } = await setup();
    expect((await request('other', 'openslack/prepare-shutdown', { generation: 'other', remainingMs: 24_000 })).error).toBeDefined();
    expect(stop).not.toHaveBeenCalled();
    await request('prepare', 'openslack/prepare-shutdown', { generation: 'g1', remainingMs: 24_000 });
    await expect(ctx.bail('openslack/host-request', 'openslack/tool-authorize', {}, new AbortController().signal)).rejects.toThrow('unavailable');
    expect(exits).toEqual([]);
  });
  it('rejects an owned stop failure before ACK despite Cordis disposer containment', async () => {
    const { request, exits, stop } = await setup(true);
    expect((await request('prepare', 'openslack/prepare-shutdown', { generation: 'g1', remainingMs: 24_000 })).error).toBeDefined();
    expect((await request('shutdown', 'shutdown')).error).toBeDefined();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([]);
  });
  it('rejects an expired first prompt before delegating it but permits prepare, shutdown and disposal', async () => {
    const expiry = Date.now() + 30_000;
    const { request, stop, exits } = await setup(false, { mode: 'required', expiresAt: expiry });
    const delegated = vi.spyOn(HarnessSdkJsonRpcServer.prototype, 'handleRequest');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expiry);
    try {
      const refused = await request('prompt', 'session/prompt', { sessionId: 'fixture', content: [] });
      expect(refused.error).toBeDefined();
      expect(JSON.stringify(refused.error)).toMatch(/lease expired/);
      expect(delegated.mock.calls.some(([method]) => method === 'session/prompt')).toBe(false);
      expect((await request('prepare', 'openslack/prepare-shutdown', { generation: 'g1', remainingMs: 24_000 })).result).toHaveProperty('resources');
      expect(stop).toHaveBeenCalledOnce();
      expect((await request('shutdown', 'shutdown')).result).toEqual({});
      await vi.waitFor(() => expect(exits).toEqual([0]));
      // setup registers a separate disposer which also requests the same
      // owner's idempotent stop. Preparation and disposal must both still run.
      expect(stop).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); delegated.mockRestore(); }
  });
  it('rejects invalid private budgets before stopping resources and reuses the first valid deadline', async () => {
    const { request, stop } = await setup();
    for (const [id, params] of [
      ['missing', { generation: 'g1' }],
      ['expired', { generation: 'g1', remainingMs: 0 }],
      ['overlarge', { generation: 'g1', remainingMs: 24_001 }],
      ['fractional', { generation: 'g1', remainingMs: 1.5 }],
      ['old-clock', { generation: 'g1', deadlineAt: Date.now() + 24_000 }],
    ] as const) expect((await request(id, 'openslack/prepare-shutdown', params)).error).toBeDefined();
    expect(stop).not.toHaveBeenCalled();
    expect((await request('first', 'openslack/prepare-shutdown', { generation: 'g1', remainingMs: 5_000 })).result).toHaveProperty('resources');
    const originalDeadline = stop.mock.calls[0]?.[0];
    expect(originalDeadline).toBeGreaterThan(performance.now());
    expect(originalDeadline).toBeLessThanOrEqual(performance.now() + 5_000);
    expect((await request('repeat', 'openslack/prepare-shutdown', { generation: 'g1', remainingMs: 24_000 })).result).toHaveProperty('resources');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop.mock.calls[0]?.[0]).toBe(originalDeadline);
    expect((await request('invalid-repeat', 'openslack/prepare-shutdown', { generation: 'g1', remainingMs: 0 })).error).toBeDefined();
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it('refuses a late repeated prepare or shutdown ACK without renewing the stopped owner', async () => {
    const { request, stop, exits } = await setup();
    expect((await request('prepare', 'openslack/prepare-shutdown', { generation: 'g1', remainingMs: 5_000 })).result).toHaveProperty('resources');
    const deadline = stop.mock.calls[0]?.[0];
    if (deadline === undefined) throw new Error('The fixture did not observe its owned deadline');
    const clock = vi.spyOn(performance, 'now').mockReturnValue(deadline);
    try {
      expect((await request('late-prepare', 'openslack/prepare-shutdown', { generation: 'g1', remainingMs: 24_000 })).error).toBeDefined();
      expect((await request('late-ack', 'shutdown')).error).toBeDefined();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(exits).toEqual([]);
    } finally { clock.mockRestore(); }
  });
  it.each(['before-iteration', 'next-stream'] as const)('denies %s at the public model stream boundary without mutating its request', async boundary => {
    const expiry = Date.now() + 30_000;
    const { ctx } = await setup(false, { mode: 'required', expiresAt: expiry });
    const dispatched = vi.fn();
    class Backend extends LlmAdapter {
      override async *stream(): AsyncIterable<StreamChunk> { dispatched(); yield { type: 'finish', reason: { kind: 'stop' } }; }
    }
    ctx.llm.registerAdapter(['fixture'], new Backend());
    const request = { provider: 'fixture', model: 'fixture', messages: [] };
    const initial = JSON.stringify(request);
    const consume = async (stream: AsyncIterable<StreamChunk>) => { for await (const chunk of stream) { expect(chunk.type).toBe('finish'); } };
    const stream = ctx.llm.stream(request);
    if (boundary === 'next-stream') { await consume(stream); expect(dispatched).toHaveBeenCalledOnce(); dispatched.mockClear(); }
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expiry);
    try {
      if (boundary === 'before-iteration') await expect(consume(stream)).rejects.toThrow(/lease expired/);
      else expect(() => ctx.llm.stream(request)).toThrow(/lease expired/);
      expect(dispatched).not.toHaveBeenCalled();
      expect(JSON.stringify(request)).toBe(initial);
    } finally { clock.mockRestore(); }
  });
  it.each(['closing', 'lease-expired'] as const)('stops an existing stream at the next chunk when %s, and closes its iterator', async reason => {
    const expiry = Date.now() + 30_000;
    const { ctx, request: rpc } = await setup(false, { mode: 'required', expiresAt: expiry });
    const finished = vi.fn();
    class Backend extends LlmAdapter {
      override async *stream(): AsyncIterable<StreamChunk> {
        try {
          yield { type: 'finish', reason: { kind: 'stop' } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        } finally { finished(); }
      }
    }
    ctx.llm.registerAdapter(['fixture'], new Backend());
    const modelRequest = Object.freeze({ provider: 'fixture', model: 'fixture', messages: [] });
    const before = JSON.stringify(modelRequest);
    const stream = ctx.llm.stream(modelRequest)[Symbol.asyncIterator]();
    expect((await stream.next()).done).toBe(false);
    const wall = reason === 'lease-expired' ? vi.spyOn(Date, 'now').mockReturnValue(expiry) : undefined;
    try {
      if (reason === 'closing') await rpc('prepare-stream', 'openslack/prepare-shutdown', { generation: 'g1', remainingMs: 24_000 });
      await expect(stream.next()).rejects.toThrow(reason === 'closing' ? /closing/ : /lease expired/);
      expect(finished).toHaveBeenCalledOnce();
      expect(JSON.stringify(modelRequest)).toBe(before);
    } finally { wall?.mockRestore(); await stream.return?.(); }
  });
});

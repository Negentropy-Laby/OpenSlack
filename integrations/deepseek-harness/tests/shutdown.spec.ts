/** Real Cordis/public SDK composition; contained disposer errors cannot replace an owned stop receipt. */
import { PassThrough } from 'node:stream';
import { Context } from '@deepseek-ai/cordis';
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import * as SdkHost from '../src/sdk-host.ts';
import { RUNTIME_PEERS } from '../src/runtime-bindings.ts';
import { pathToFileURL } from 'node:url';
import { withinShutdown } from '../src/shutdown.ts';
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server';
import type { HarnessEligibilityRestriction } from '../src/scope-evidence.ts';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';

async function setup(fails = false, startEligibility: HarnessEligibilityRestriction = { mode: 'not_applicable' }) {
  const ctx = new Context();
  onTestFinished(() => ctx.fiber.dispose());
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
  const stop = vi.fn(async () => {
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

describe('external strict SDK host over the unmodified public server', () => {
  it('shares one absolute budget across serial resource phases instead of restarting each timeout', async () => {
    vi.useFakeTimers();
    try {
      const deadline = Date.now() + 100;
      const first = withinShutdown(deadline, () => new Promise<void>(resolve => setTimeout(resolve, 60)));
      await vi.advanceTimersByTimeAsync(60);
      await first;
      const second = withinShutdown(deadline, () => new Promise<void>(resolve => setTimeout(resolve, 60)));
      const rejected = expect(second).rejects.toThrow('shutdown deadline exceeded');
      await vi.advanceTimersByTimeAsync(40);
      await rejected;
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });
  it('prepares owned stops before a normal empty shutdown ACK and actual exit request', async () => {
    const { request, stop, exits } = await setup();
    const prepared = await request('prepare', 'openslack/prepare-shutdown', { generation: 'g1' });
    expect(prepared.result).toMatchObject({ generation: 'g1', resources: [{ pid: 12345, code: 0 }] });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([]);
    expect((await request('shutdown', 'shutdown')).result).toEqual({});
    await vi.waitFor(() => expect(exits).toEqual([0]));
  });
  it('rejects another generation and denies host authorization while closing', async () => {
    const { ctx, request, stop, exits } = await setup();
    expect((await request('other', 'openslack/prepare-shutdown', { generation: 'other' })).error).toBeDefined();
    expect(stop).not.toHaveBeenCalled();
    await request('prepare', 'openslack/prepare-shutdown', { generation: 'g1' });
    await expect(ctx.bail('openslack/host-request', 'openslack/tool-authorize', {}, new AbortController().signal)).rejects.toThrow('unavailable');
    expect(exits).toEqual([]);
  });
  it('rejects an owned stop failure before ACK despite Cordis disposer containment', async () => {
    const { request, exits, stop } = await setup(true);
    expect((await request('prepare', 'openslack/prepare-shutdown', { generation: 'g1' })).error).toBeDefined();
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
      expect((await request('prepare', 'openslack/prepare-shutdown', { generation: 'g1' })).result).toHaveProperty('resources');
      expect(stop).toHaveBeenCalledOnce();
      expect((await request('shutdown', 'shutdown')).result).toEqual({});
      await vi.waitFor(() => expect(exits).toEqual([0]));
      // setup registers a separate disposer which also requests the same
      // owner's idempotent stop. Preparation and disposal must both still run.
      expect(stop).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); delegated.mockRestore(); }
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
    const consume = async (stream: AsyncIterable<StreamChunk>) => { for await (const _chunk of stream) { /* exhaust */ } };
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
});

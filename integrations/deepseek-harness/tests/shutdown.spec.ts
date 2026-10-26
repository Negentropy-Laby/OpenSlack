/** Real Cordis/public SDK composition; contained disposer errors cannot replace an owned stop receipt. */
import { PassThrough } from 'node:stream';
import { Context } from '@deepseek-ai/cordis';
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import * as SdkHost from '../src/sdk-host.ts';
import { RUNTIME_PEERS } from '../src/runtime-bindings.ts';
import { pathToFileURL } from 'node:url';

async function setup(fails = false) {
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
    resolveRuntime: name => pathToFileURL(entries[name]!).href, input, output, exit: code => { exits.push(code); } });
  const request = async (id: string, method: string, params: object = {}) => {
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    await vi.waitFor(() => expect(responses.some(response => response.id === id)).toBe(true));
    return responses.find(response => response.id === id)!;
  };
  return { ctx, stop, exits, request };
}

describe('external strict SDK host over the unmodified public server', () => {
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
});

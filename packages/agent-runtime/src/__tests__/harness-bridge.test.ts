import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeProcessAdapter, type BridgeProcessAdapterOptions } from '../bridge-adapter.js';
import { createRunStore, generateRunId } from '../run-store.js';
import { createRunRecorder } from '../recorder.js';
import { ToolGuard } from '../adapter.js';
import { RepositoryToolExecutor } from '../tool-executor.js';
import { buildPermissionProfile } from '../permissions.js';
import { createDeepSeekHarnessProvider } from '../deepseek-harness-provider.js';
import { createConfiguredHarnessTaskHost } from '../harness-deployment.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup(source: string, timeoutMs = 2_000, extra: Partial<BridgeProcessAdapterOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'harness-bridge-'));
  roots.push(root);
  const runId = generateRunId();
  const resolvedConfig = { agentId: 'fixture', source: 'runtime', tools: ['Read'] };
  const permissionProfile = buildPermissionProfile(resolvedConfig);
  const recorder = createRunRecorder(createRunStore(root));
  const state = recorder.start({ runId, agentId: 'fixture', prompt: 'hello', resolvedConfig, permissionProfile });
  const toolGuard = new ToolGuard(permissionProfile, recorder, runId);
  const adapter = new BridgeProcessAdapter({
    command: process.execPath, args: ['--input-type=module', '-e', source],
    timeoutMs, confirmProcessExit: true, exitGraceMs: 100,
    ...extra,
  });
  const context = {
    prompt: 'hello', runId, agentId: 'fixture', resolvedConfig, permissionProfile,
    recorder, runState: state, toolGuard,
    toolExecutor: new RepositoryToolExecutor({ rootPath: root, recorder, runId, toolGuard }),
  };
  return { adapter, context };
}

const prefix = `
import readline from 'node:readline';
const lines = readline.createInterface({ input: process.stdin });
function reply(frame, kind, payload) { process.stdout.write(JSON.stringify({ ...frame, kind, payload }) + '\\n'); }
lines.on('line', text => {
  const frame = JSON.parse(text);
  if (frame.kind === 'handshake_request') reply(frame, 'handshake_response', { accepted: true });
  if (frame.kind === 'run_request') {
`;
const suffix = `\n  }\n});`;

describe('Harness bridge ownership', () => {
  it('returns complete.data only after an observed clean exit', async () => {
    const { adapter, context } = setup(prefix + `reply(frame, 'complete', { data: { text: 'done' } });` + suffix);
    expect((await adapter.execute(context)).data).toEqual({ text: 'done' });
    expect(adapter.processExitReceipt).toEqual({ code: 0, signal: null });
  });

  it.each(['deadline', 'cancel', 'elapsed'] as const)('does not return success when %s invalidates clean shutdown confirmation', async kind => {
    const controller = new AbortController();
    const started = Date.now();
    if (kind === 'deadline') vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const { adapter, context } = setup(prefix + `reply(frame, 'complete', { data: 'must not succeed' });` + suffix);
    const close = adapter.closeSession.bind(adapter);
    vi.spyOn(adapter, 'closeSession').mockImplementationOnce(async id => {
      if (kind !== 'elapsed') controller.abort(new Error('Cancelled during shutdown'));
      const result = await close(id);
      if (kind === 'elapsed') vi.spyOn(Date, 'now').mockReturnValue(started + 60_000);
      return result;
    });
    const outcome = await adapter.execute({ ...context, ...(kind === 'cancel' ? { signal: controller.signal } : {}) })
      .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    expect(adapter.processExitReceipt).toEqual({ code: 0, signal: null });
    expect(outcome.value).toBeUndefined();
    expect(outcome.error).toMatchObject({ kind: kind === 'cancel' ? 'unknown' : 'timeout' });
  });

  it('rejects frames from a different run', async () => {
    const { adapter, context } = setup(prefix + `reply({ ...frame, correlationId: 'other' }, 'complete', { data: {} });` + suffix);
    await expect(adapter.execute(context)).rejects.toThrow('another run');
    expect(adapter.processExitReceipt).toEqual({ code: 0, signal: null });
  });

  it('retains an explicit null data value and refuses a missing data field', async () => {
    const valid = setup(prefix + `reply(frame, 'complete', { data: null });` + suffix);
    expect((await valid.adapter.execute(valid.context)).data).toBeNull();
    const missing = setup(prefix + `reply(frame, 'complete', { result: 'not data' });` + suffix);
    await expect(missing.adapter.execute(missing.context)).rejects.toThrow(/data/);
  });

  it('rejects duplicate terminal frames even when the first complete would otherwise be valid', async () => {
    const { adapter, context } = setup(prefix + `reply(frame, 'complete', { data: 1 }); reply(frame, 'complete', { data: 2 });` + suffix);
    await expect(adapter.execute(context)).rejects.toThrow('Duplicate terminal');
  });

  it('decodes multibyte UTF-8 split across process writes', async () => {
    const { adapter, context } = setup(prefix + `
      const bytes = Buffer.from(JSON.stringify({ ...frame, kind: 'complete', payload: { data: '双向闭环' } }) + '\\n');
      const cut = bytes.indexOf(Buffer.from('双')) + 1;
      process.stdout.write(bytes.subarray(0, cut));
      setTimeout(() => process.stdout.write(bytes.subarray(cut)), 10);
    ` + suffix);
    expect((await adapter.execute(context)).data).toBe('双向闭环');
  });

  it('requires an acknowledged live host authorization before the peer proceeds', async () => {
    const authorizeTool = vi.fn(async () => {});
    const { adapter, context } = setup(prefix + `
      reply(frame, 'tool_request', { phase: 'authorize', authorizationRequestId: 'auth-1', toolName: 'Read', input: { file_path: '/fixture.txt' } });
    }
    if (frame.kind === 'tool_response' && frame.payload.authorizationRequestId === 'auth-1') {
      if (frame.payload.allowed !== true) process.exit(9);
      reply(frame, 'complete', { data: 'authorized' });
    ` + suffix, 2_000, { authorizeTool });
    expect((await adapter.execute(context)).data).toBe('authorized');
    expect(authorizeTool).toHaveBeenCalledTimes(1);
    expect(authorizeTool.mock.calls[0]?.slice(1)).toEqual(['Read', { file_path: '/fixture.txt' }]);
  });

  it('fails closed on a rejected or non-resolving live authority port without leaking its cause', async () => {
    for (const authorizeTool of [async () => { throw new Error('PRIVATE_AUTHORITY_DETAIL'); }, () => new Promise<void>(() => {})]) {
      const { adapter, context } = setup(prefix + `
        reply(frame, 'tool_request', { phase: 'authorize', authorizationRequestId: 'auth-1', toolName: 'Read', input: {} });
      ` + suffix, 100, { authorizeTool });
      await expect(adapter.execute(context)).rejects.not.toThrow('PRIVATE_AUTHORITY_DETAIL');
      expect(adapter.processExitReceipt).not.toBeNull();
    }
  });

  it('does not reset the deadline on heartbeat', async () => {
    const { adapter, context } = setup(prefix + `
      const timer = setInterval(() => reply(frame, 'heartbeat', {}), 5);
      lines.on('close', () => clearInterval(timer));
    ` + suffix, 100);
    await expect(adapter.execute(context)).rejects.toThrow(/deadline|timed out/);
  });

  it('does not publish success after forced shutdown', async () => {
    const { adapter, context } = setup(prefix + `
      reply(frame, 'complete', { data: { text: 'done' } });
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    ` + suffix);
    await expect(adapter.execute(context)).rejects.toThrow('clean owned shutdown');
    expect(adapter.processExitReceipt?.signal).toBe('SIGKILL');
  });

  it('fails closed without trusted deployment configuration', () => {
    expect(() => createDeepSeekHarnessProvider().resolve({
      agentId: 'fixture', source: 'runtime', runtimeProvider: 'deepseek-harness',
    })).toThrow('not configured');
  });

  it('does not spawn or send a run request for a pre-cancelled invocation', async () => {
    const { adapter, context } = setup('process.exit(99)');
    const controller = new AbortController();
    controller.abort(new Error('Already cancelled'));
    await expect(adapter.execute({ ...context, signal: controller.signal })).rejects.toThrow('Already cancelled');
    expect(adapter.processExitReceipt).toBeNull();
  });

  it('does not provision absent deployment and refuses a configuration parent link', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-deployment-'));
    roots.push(root);
    expect(createConfiguredHarnessTaskHost(root, 'fixture')).toBeUndefined();
    const target = join(root, 'target');
    mkdirSync(target);
    mkdirSync(join(target, 'harness'));
    writeFileSync(join(target, 'harness/deployment.json'), '{}');
    symlinkSync(target, join(root, '.openslack.local'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => createConfiguredHarnessTaskHost(root, 'fixture')).toThrow('cannot traverse a link');
  });
});

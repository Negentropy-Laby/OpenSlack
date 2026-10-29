import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channel } from 'node:diagnostics_channel';
import { ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { BridgeProcessAdapter } from '../bridge-adapter.js';
import { buildBridgeEnvelope } from '../bridge-contract.js';
import { createRunStore } from '../run-store.js';
import { createRunRecorder } from '../recorder.js';
import { ToolGuard } from '../adapter.js';
import { RepositoryToolExecutor } from '../tool-executor.js';
import { buildHarnessTaskPermissionProfile } from '../harness-permissions.js';
import { HARNESS_CALLBACK_TOOLS } from '../bridge-wire.js';
import { bindHarnessToolEligibility, bindHarnessRunStartEligibility, createHarnessTaskEligibility,
  type HarnessRunStartEligibility, type HarnessToolEligibility } from '../harness-eligibility.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// These internal minted observations are synthetic test restrictions. They do
// not stand in for a formal principal, approved task source or live authority.
function fixture(toolName: string, kind: 'matching' | 'missing' | 'forged' | 'wrong-domain' | 'expired', preprocessArgs?: () => void, authorizationChecks = 1) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-eligibility-')); roots.push(root);
  const marker = join(root, 'effect');
  const peerMarker = join(root, 'peer-started'), requestMarker = join(root, 'run-request');
  const callback = toolName !== 'Read';
  const targetPath = callback ? `mcp:${toolName}` : join(root, 'fixture.txt');
  const input = callback ? { objectKind: 'workflow', objectId: 'RUN-ELIGIBILITY' } : { file_path: targetPath };
  const runId = 'RUN-ELIGIBILITY', requestHash = 'c'.repeat(64), principalHash = 'a'.repeat(64), generation = 'fixture-owner';
  const config = { agentId: 'fixture', source: 'unit-fixture', runtimeProvider: 'deepseek-harness', tools: [toolName] };
  const permissionProfile = buildHarnessTaskPermissionProfile(config);
  const store = createRunStore(root, { sweepOrphans: false }), recorder = createRunRecorder(store, root);
  recorder.start({ runId, agentId: 'fixture', prompt: 'fixture', resolvedConfig: config, permissionProfile });
  const state = store.updateRun(runId, { harnessExecution: { schema: 'openslack.harness_execution.v1', taskId: 'TASK-ELIGIBILITY',
    requestHash, principalHash, baseline: 'b'.repeat(40), acceptance: 'pending', summary: 'fixture', reports: {}, evidenceRefs: [],
    lifecycle: { phase: 'started', ownerGeneration: generation, deadlineAt: new Date(Date.now() + 60_000).toISOString() },
    evidence: { reservedBytes: 0, calls: {} } } });
  let now = Date.now();
  const expiresAt = now + 1_000;
  if (kind === 'expired') vi.spyOn(Date, 'now').mockImplementation(() => now);
  const authorizeTool = vi.fn(async (): Promise<void | HarnessToolEligibility> => {
    if (kind === 'missing') return;
    if (kind === 'forged') return Object.freeze({}) as HarnessToolEligibility;
    const factTool = kind === 'wrong-domain' ? callback ? 'Read' : HARNESS_CALLBACK_TOOLS.query.bridge : toolName;
    const factTarget = factTool === 'Read' ? join(root, 'fixture.txt') : `mcp:${factTool}`;
    const task = createHarnessTaskEligibility({ taskId: 'TASK-ELIGIBILITY', taskHash: requestHash, principalId: 'unit-fixture-only',
      principalHash, phase: factTool === 'Read' ? 'execute' : 'report' },
    kind === 'expired' ? { mode: 'required', expiresAt } : { mode: 'not_applicable' });
    const value = bindHarnessToolEligibility(task, { runId, generation, toolName: factTool, targetPath: factTarget });
    if (kind === 'expired') now = expiresAt;
    return value;
  });
  const source = `import readline from 'node:readline';import {writeFileSync} from 'node:fs';
    writeFileSync(${JSON.stringify(peerMarker)},'peer-started');
    const lines=readline.createInterface({input:process.stdin});
    const toolName=${JSON.stringify(toolName)},input=${JSON.stringify(input)},targetPath=${JSON.stringify(targetPath)};
    let authorized=0;
    const reply=(frame,kind,payload)=>process.stdout.write(JSON.stringify({...frame,kind,payload})+'\\n');
    lines.on('line',text=>{const frame=JSON.parse(text);
      if(frame.kind==='handshake_request')reply(frame,'handshake_response',{accepted:true});
      if(frame.kind==='run_request'){
        writeFileSync(${JSON.stringify(requestMarker)},'run-request');
        reply(frame,'tool_request',{phase:'authorize',authorizationRequestId:'auth-1',toolName,input,
          evidence:{callId:'effect-1',generation:${JSON.stringify(generation)},input,targetPath,maxResultBytes:4096}});
      }
      if(frame.kind==='tool_response'&&frame.payload.allowed===true){
        if(++authorized<${authorizationChecks}){reply(frame,'tool_request',{phase:'authorize',authorizationRequestId:'auth-'+authorized,toolName,input,
          evidence:{callId:'effect-1',generation:${JSON.stringify(generation)},input,targetPath,maxResultBytes:4096}});return;}
        writeFileSync(${JSON.stringify(marker)},'effect');
        reply(frame,'tool_request',{phase:'observed',callId:'effect-1',toolName,input});
        reply(frame,'tool_response',{phase:'observed',callId:'effect-1',toolName,output:{restriction:frame.payload.restriction}});
        reply(frame,'complete',{data:frame.payload.restriction});
      }
    });`;
  // A production peer is a JS entry, whereas this subprocess fixture uses -e.
  // Keep the private peer flag in script argv, not in Node's option parser.
  const args = ['--input-type=module', '-e', source, '--'];
  if (preprocessArgs) Object.defineProperty(args, Symbol.iterator, { value: function* (this: string[]) {
    yield* Array.prototype.values.call(this);
    preprocessArgs();
  } });
  const adapter = new BridgeProcessAdapter({ command: process.execPath, args,
    timeoutMs: 5_000, confirmProcessExit: true, exitGraceMs: 100, requireToolEvidence: true, authorizeTool });
  const toolGuard = new ToolGuard(permissionProfile, recorder, runId);
  const startEligibility = bindHarnessRunStartEligibility(createHarnessTaskEligibility({ taskId: 'TASK-ELIGIBILITY', taskHash: requestHash,
    principalId: 'unit-fixture-only', principalHash, phase: 'execute' }, { mode: 'not_applicable' }), { runId, generation });
  return { adapter, marker, peerMarker, requestMarker, store, runId, requestHash, principalHash, generation, authorizeTool, context: { runId, agentId: 'fixture', prompt: 'fixture',
    resolvedConfig: config, permissionProfile, recorder, runState: state, toolGuard, startEligibility,
    toolExecutor: new RepositoryToolExecutor({ rootPath: root, recorder, runId, toolGuard }) } };
}

describe('nominal eligibility across Bridge pre-effect authorization', () => {
  it('permits the same native call\'s initial, preview and fs-intent checks without allocating or executing it three times', async () => {
    const f = fixture('Read', 'matching', undefined, 3);
    await expect(f.adapter.execute(f.context)).resolves.toBeDefined();
    expect(f.authorizeTool).toHaveBeenCalledTimes(3);
    expect(existsSync(f.marker)).toBe(true);
    expect(f.store.readRun(f.runId)?.toolCalls).toBe(1);
    expect(f.store.readRun(f.runId)?.harnessExecution?.evidence?.reservedBytes).toBe(0);
  });
  it.each(['Read', HARNESS_CALLBACK_TOOLS.query.bridge])('passes only an explicit matching %s observation through the live authority and durable reservation', async tool => {
    const f = fixture(tool, 'matching');
    expect((await f.adapter.execute(f.context)).data).toEqual({ mode: 'not_applicable' });
    expect(f.authorizeTool).toHaveBeenCalledOnce();
    expect(existsSync(f.marker)).toBe(true);
    expect(f.store.getRun(f.runId)?.harnessExecution?.evidence?.reservedBytes).toBe(0);
  });

  it.each(['missing', 'forged', 'wrong-domain', 'expired'] as const)('refuses %s observations before native or callback effects', async kind => {
    for (const tool of ['Read', HARNESS_CALLBACK_TOOLS.query.bridge]) {
      const f = fixture(tool, kind);
      await expect(f.adapter.execute(f.context)).rejects.toMatchObject({ kind: 'permission_denied' });
      expect(f.authorizeTool).toHaveBeenCalledOnce();
      expect(existsSync(f.marker)).toBe(false);
      expect(f.store.getRun(f.runId)?.harnessExecution?.evidence?.calls).toEqual({});
    }
  });
});

/** Observe actual ChildProcess construction, not a signal or a marker that may never execute. */
async function countChildren(work: () => Promise<void>): Promise<number> {
  const diagnostic = channel('child_process');
  let count = 0;
  const observe = (value: unknown) => {
    if (value && typeof value === 'object' && 'process' in value && value.process instanceof ChildProcess) count++;
  };
  diagnostic.subscribe(observe);
  try { await work(); return count; }
  finally { diagnostic.unsubscribe(observe); }
}

function requiredStart(f: ReturnType<typeof fixture>, expiresAt: number, override: Partial<{
  runId: string; generation: string; requestHash: string; principalHash: string;
}> = {}): HarnessRunStartEligibility {
  const task = createHarnessTaskEligibility({ taskId: 'TASK-ELIGIBILITY', taskHash: override.requestHash ?? f.requestHash,
    principalId: 'unit-fixture-only', principalHash: override.principalHash ?? f.principalHash, phase: 'execute' }, { mode: 'required', expiresAt });
  return bindHarnessRunStartEligibility(task, { runId: override.runId ?? f.runId, generation: override.generation ?? f.generation });
}

describe('known start cutoff at actual peer dispatch', () => {
  it('does not regrant a sampled duration after resolve/preflight consumes the same-process cutoff and the wall clock rolls back', async () => {
    const f = fixture('Read', 'matching'), wall = Date.now(), started = performance.now();
    const cutoff = started + 1000; // Host sampled before expensive provider resolution.
    vi.spyOn(performance, 'now').mockReturnValue(started + 1500);
    vi.spyOn(Date, 'now').mockReturnValue(wall - 60_000);
    const context = { ...f.context, executionDeadline: wall + 1000, executionMonotonicDeadline: cutoff };
    expect(await countChildren(async () => {
      await expect(f.adapter.execute(context)).rejects.toMatchObject({ kind: 'timeout' });
    })).toBe(0);
    expect(existsSync(f.peerMarker)).toBe(false); expect(existsSync(f.requestMarker)).toBe(false);
    expect(f.authorizeTool).not.toHaveBeenCalled(); expect(f.adapter.processExitReceipt).toBeNull();
  });
  it('accepts an explicit matching live required observation without replacing native/callback tool authority', async () => {
    for (const tool of ['Read', HARNESS_CALLBACK_TOOLS.query.bridge]) {
      const f = fixture(tool, 'matching');
      const startEligibility = requiredStart(f, Date.now() + 60_000);
      expect(await countChildren(async () => { await expect(f.adapter.execute({ ...f.context, startEligibility })).resolves.toBeDefined(); })).toBe(1);
      expect(existsSync(f.peerMarker)).toBe(true);
      expect(existsSync(f.requestMarker)).toBe(true);
      expect(existsSync(f.marker)).toBe(true);
      expect(f.authorizeTool).toHaveBeenCalledOnce();
    }
  });

  it.each(['missing', 'forged', 'wrong-run', 'wrong-generation', 'wrong-request', 'wrong-principal', 'wrong-domain', 'expired'] as const)(
    'rejects %s start observations before any actual peer process', async kind => {
      const base = Date.now(); let now = base;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const f = fixture('Read', 'matching');
      let startEligibility: HarnessRunStartEligibility | undefined;
      if (kind === 'forged') startEligibility = Object.freeze({}) as HarnessRunStartEligibility;
      else if (kind === 'wrong-domain') startEligibility = bindHarnessToolEligibility(createHarnessTaskEligibility({
        taskId: 'TASK-ELIGIBILITY', taskHash: f.requestHash, principalId: 'unit-fixture-only', principalHash: f.principalHash, phase: 'execute',
      }, { mode: 'required', expiresAt: base + 1_000 }), { runId: f.runId, generation: f.generation, toolName: 'Read', targetPath: join(tmpdir(), 'fixture.txt') }) as unknown as HarnessRunStartEligibility;
      else if (kind !== 'missing') startEligibility = requiredStart(f, base + 1_000, {
        ...(kind === 'wrong-run' ? { runId: 'RUN-OTHER' } : {}), ...(kind === 'wrong-generation' ? { generation: 'another-owner' } : {}),
        ...(kind === 'wrong-request' ? { requestHash: 'd'.repeat(64) } : {}), ...(kind === 'wrong-principal' ? { principalHash: 'e'.repeat(64) } : {}),
      });
      if (kind === 'expired') now = base + 1_000;
      expect(await countChildren(async () => { await expect(f.adapter.execute({ ...f.context, startEligibility })).rejects.toMatchObject({ kind: 'permission_denied' }); })).toBe(0);
      expect(existsSync(f.peerMarker)).toBe(false);
      expect(existsSync(f.requestMarker)).toBe(false);
      expect(existsSync(f.marker)).toBe(false);
      expect(f.authorizeTool).not.toHaveBeenCalled();
      expect(f.adapter.processExitReceipt).toBeNull();
    },
  );

  it.each(['recorder', 'argv-preprocessing'] as const)('rejects lease expiry after %s before actual spawn', async boundary => {
    const base = Date.now(); let now = base;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = fixture('Read', 'matching', boundary === 'argv-preprocessing' ? () => { now = base + 1_000; } : undefined);
    const startEligibility = requiredStart(f, base + 1_000);
    if (boundary === 'recorder') {
      const progress = f.context.recorder.progress.bind(f.context.recorder);
      vi.spyOn(f.context.recorder, 'progress').mockImplementation((runId, data) => {
        const result = progress(runId, data);
        if (data.step === 'bridge_mcp_availability') now = base + 1_000;
        return result;
      });
    }
    expect(await countChildren(async () => { await expect(f.adapter.execute({ ...f.context, startEligibility })).rejects.toMatchObject({ kind: 'permission_denied' }); })).toBe(0);
    expect(existsSync(f.peerMarker)).toBe(false);
    expect(existsSync(f.requestMarker)).toBe(false);
    expect(f.authorizeTool).not.toHaveBeenCalled();
  });

  it.each(['lease', 'business'] as const)('rechecks the separate %s cutoff after an earlier outbound write finishes', async cutoff => {
    const base = Date.now(); let now = base;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = fixture('Read', 'matching');
    const startEligibility = requiredStart(f, base + (cutoff === 'lease' ? 1_000 : 3_000));
    const progress = f.context.recorder.progress.bind(f.context.recorder);
    let barrier: Promise<void> | undefined;
    vi.spyOn(f.context.recorder, 'progress').mockImplementation((runId, data) => {
      const result = progress(runId, data);
      if (data.step === 'bridge_session_started') {
        barrier = f.adapter.sendEnvelope(`bridge-${runId}`, buildBridgeEnvelope(`bridge-${runId}`, runId, 'progress', { step: 'before-dispatch' }))
          .then(() => { now = base + 1_000; });
      }
      return result;
    });
    const context = { ...f.context, startEligibility, ...(cutoff === 'business' ? { executionDeadline: base + 1_000 } : {}) };
    expect(await countChildren(async () => { await expect(f.adapter.execute(context)).rejects.toMatchObject({ kind: cutoff === 'lease' ? 'permission_denied' : 'timeout' }); })).toBe(1);
    await barrier;
    expect(existsSync(f.peerMarker)).toBe(true);
    expect(existsSync(f.requestMarker)).toBe(false);
    expect(existsSync(f.marker)).toBe(false);
    expect(f.authorizeTool).not.toHaveBeenCalled();
    expect(f.adapter.processExitReceipt).toEqual({ code: 0, signal: null });
  });
});

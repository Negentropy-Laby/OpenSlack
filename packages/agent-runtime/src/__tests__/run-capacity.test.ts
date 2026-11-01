import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, truncateSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertRunCapacity, inspectRunCapacity, RUN_STORAGE_MAX_BYTES, RUN_STORAGE_NORMAL_MAX_BYTES,
  RUN_STORAGE_RECOVERY_RESERVE_BYTES, RUN_STORAGE_FINALIZATION_MAX_BYTES, RUN_INTENT_MAX_BYTES } from '../run-capacity.js';
import { createRunStore, decodeRunState } from '../run-store.js';
import { withRunOwnership } from '../run-ownership.js';
import type { AgentRunRequest } from '../types.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'run-capacity-')); roots.push(root); return root; }
function sized(root: string, bytes: number) { const file = join(root, 'existing'); writeFileSync(file, ''); truncateSync(file, bytes); }
function request(runId: string): AgentRunRequest {
  return { runId, agentId: 'capacity-fixture', prompt: 'offline', resolvedConfig: { agentId: 'capacity-fixture', source: 'test' },
    permissionProfile: { allowedTools: ['Read'], deniedTools: [], permissionMode: 'default', canApprovePR: false,
      canMerge: false, canReadSecrets: false, canBypassRulesets: false, acceptEdits: false, isReadOnly: true } };
}

describe('one charged storage budget for writers and maintenance', () => {
  it('charges empty members and accounts for simultaneous canonical and temporary files', () => {
    const root = fixture();
    for (const name of ['empty-a', 'empty-b', 'empty-c']) writeFileSync(join(root, name), '');
    expect(inspectRunCapacity(root).used).toBe(3 * 1024);
    const peak = fixture(); sized(peak, RUN_STORAGE_NORMAL_MAX_BYTES - 2 * 1024);
    expect(() => assertRunCapacity(peak, { canonical: 1024, temporary: 1024 })).not.toThrow();
    expect(() => assertRunCapacity(peak, { canonical: 1024, temporary: 1025 })).toThrow(expect.objectContaining({ code: 'RUN_STORAGE_LIMIT' }));
  });

  it('keeps normal, terminal and recovery ceilings distinct without changing the 96 MiB budget', () => {
    const root = fixture(); sized(root, RUN_STORAGE_NORMAL_MAX_BYTES);
    expect(() => assertRunCapacity(root, {})).not.toThrow();
    expect(() => assertRunCapacity(root, { new: 1 })).toThrow();
    expect(() => assertRunCapacity(root, { new: RUN_STORAGE_FINALIZATION_MAX_BYTES - RUN_STORAGE_NORMAL_MAX_BYTES }, { finalization: true })).not.toThrow();
    expect(() => assertRunCapacity(root, { new: RUN_STORAGE_RECOVERY_RESERVE_BYTES }, { recovery: true })).not.toThrow();
    expect(() => assertRunCapacity(root, { new: RUN_STORAGE_RECOVERY_RESERVE_BYTES + 1 }, { recovery: true })).toThrow();
    expect(RUN_STORAGE_MAX_BYTES).toBe(96 * 1024 * 1024);
    // Failed recovery's worst encoded peak: both snapshots, tail, bounded
    // intent/receipt/barrier, with canonical metadata retained. Terminal finalization
    // may spend only 768 KiB, leaving this independent maintenance allowance.
    const recoveryPeak = 2 * 512 * 1024 + 64 * 1024 + 3 * RUN_INTENT_MAX_BYTES;
    expect(RUN_STORAGE_MAX_BYTES - RUN_STORAGE_FINALIZATION_MAX_BYTES).toBeGreaterThanOrEqual(recoveryPeak);
  });

  it('refuses an overlarge event before touching an immutable intent or transcript', () => {
    const root = fixture(), store = createRunStore(root, { sweepOrphans: false }), id = 'RUN-CAPACITY-BOUNDS';
    store.createRun(request(id));
    const directory = join(root, '.openslack.local/agents/runs', id), before = readdirSync(directory).sort();
    expect(() => store.appendEvent(id, { type: 'progress', timestamp: new Date().toISOString(), data: { text: 'x'.repeat(16 * 1024 * 1024) } })).toThrow(expect.objectContaining({ code: 'RUN_TRANSCRIPT_LIMIT' }));
    expect(readdirSync(directory).sort()).toEqual(before);
    expect(store.readRun(id)!.persistence!.revision).toBe(0);
  });

  it.each(['run.json', 'metadata.json'])('rejects callback-time %s drift before publishing a new intent', name => {
    const root = fixture(), store = createRunStore(root, { sweepOrphans: false }), id = 'RUN-CALLBACK-CAS';
    store.createRun(request(id));
    const directory = join(root, '.openslack.local/agents/runs', id), path = join(directory, name), before = readdirSync(directory).sort();
    expect(() => store.withRunTransaction(id, () => {
      const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      writeFileSync(path, JSON.stringify({ ...value, outOfBandFixture: true }));
      return { patch: { tokensUsed: 1 } };
    })).toThrow(expect.objectContaining({ code: 'RUN_STATE_SNAPSHOT_CHANGED' }));
    expect(readdirSync(directory).sort()).toEqual(before);
  });

  it('rejects ambiguous owned JSON instead of silently accepting a duplicate key', () => {
    const root = fixture(), id = 'RUN-STRICT-JSON', store = createRunStore(root, { sweepOrphans: false });
    store.createRun(request(id));
    const original = readFileSync(join(root, '.openslack.local/agents/runs', id, 'run.json'), 'utf8');
    expect(() => decodeRunState(Buffer.from(original.replace('{', '{"tokensUsed":99,')), id)).toThrow('parse run.json');
  });

  it('reserves a generic transcript recovery tail before a nonterminal append can fill 64 MiB', () => {
    const root = fixture(), id = 'RUN-TRANSCRIPT-RECOVERY-TAIL', store = createRunStore(root, { sweepOrphans: false });
    store.createRun(request(id));
    const base = { type: 'progress' as const, timestamp: new Date().toISOString(), data: { text: '' } };
    const data = { text: 'x'.repeat(16 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(base)) - 1) };
    for (let i = 0; i < 3; i++) store.appendEvent(id, { ...base, data });
    const directory = join(root, '.openslack.local/agents/runs', id), before = readdirSync(directory).sort();
    expect(() => store.appendEvent(id, { ...base, data })).toThrow(expect.objectContaining({ code: 'RUN_TRANSCRIPT_LIMIT' }));
    expect(readdirSync(directory).sort()).toEqual(before);
    expect(store.readRun(id)!.persistence!.transcriptBytes).toBe(48 * 1024 * 1024);
  }, 20_000);

  it('reserves the actual failed-recovery encoding before publishing a near-bound snapshot', () => {
    const root = fixture(), id = 'RUN-SNAPSHOT-RECOVERY-TAIL', store = createRunStore(root, { sweepOrphans: false });
    const state = store.createRun(request(id));
    const empty = Buffer.byteLength(JSON.stringify({ ...state, model: '' }, null, 2));
    const directory = join(root, '.openslack.local/agents/runs', id), before = readdirSync(directory).sort();
    expect(() => store.updateRun(id, { model: 'x'.repeat(512 * 1024 - empty - 10) })).toThrow(expect.objectContaining({ code: 'RUN_STORAGE_LIMIT' }));
    expect(readdirSync(directory).sort()).toEqual(before);
    expect(store.readRun(id)!.persistence!.revision).toBe(0);
  });

  it('retains internal post-intent causes without exposing them in the public error message', () => {
    const root = fixture(), cause = new Error('secret-sentinel-not-for-public-diagnostics');
    createRunStore(root, { sweepOrphans: false }).createRun(request('RUN-CAUSE'));
    let observed: unknown;
    try { withRunOwnership(root, 'RUN-CAUSE', 'update', false, owner => { owner.touch(); throw cause; }); }
    catch (error) { observed = error; }
    expect(observed).toMatchObject({ code: 'RUN_PERSISTENCE_INDETERMINATE', cause });
    expect(String(observed)).not.toContain('secret-sentinel');
  });
});

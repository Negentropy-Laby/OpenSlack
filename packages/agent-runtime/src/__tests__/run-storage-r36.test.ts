import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import type * as FsModule from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRunStore, readRunStateSnapshot, readRunStateSnapshotWhenAvailable, listRunObservations } from '../run-store.js';
import { appendTranscriptEvent, readTranscript } from '../transcript.js';
import { buildPermissionProfile } from '../permissions.js';
import type { AgentRunRequest } from '../types.js';

vi.mock('node:fs', async load => {
  const fs = await load<typeof FsModule>();
  return { ...fs, linkSync: vi.fn(fs.linkSync), unlinkSync: vi.fn(fs.unlinkSync) };
});
const link = vi.mocked(linkSync), unlink = vi.mocked(unlinkSync);
const nativeLink = link.getMockImplementation()!, nativeUnlink = unlink.getMockImplementation()!;
const roots: string[] = [];
afterEach(() => {
  link.mockReset().mockImplementation(nativeLink); unlink.mockReset().mockImplementation(nativeUnlink);
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'run-storage-r36-')); roots.push(root);
  return { root, store: createRunStore(root, { sweepOrphans: false }) };
}
function request(runId: string): AgentRunRequest {
  const config = { agentId: 'fixture-only', source: 'test', tools: ['Read'] };
  return { runId, agentId: config.agentId, prompt: 'not a model call', resolvedConfig: config,
    permissionProfile: buildPermissionProfile(config) };
}
const event = { type: 'progress' as const, timestamp: '2026-10-28T00:00:00.000Z', data: { fixture: true } };

describe('R36 shared run ownership and isolated observations', () => {
  it.each(['second-link', 'metadata-unlink'] as const)('preserves a %s creation failure with its owned intent instead of overwriting or returning success', mode => {
    const { root, store } = fixture();
    store.createRun(request('RUN-HEALTHY'));
    const id = 'RUN-INCOMPLETE', directory = join(root, '.openslack.local/agents/runs', id);
    if (mode === 'second-link') link.mockImplementation((from, target) => {
      if (String(target) === join(directory, 'run.json')) throw Object.assign(new Error('fixture AV failure'), { code: 'EPERM' });
      return nativeLink(from, target);
    });
    else unlink.mockImplementation(path => {
      if (String(path).startsWith(join(directory, 'metadata.json.'))) throw Object.assign(new Error('fixture AV failure'), { code: 'EPERM' });
      return nativeUnlink(path);
    });
    expect(() => store.createRun(request(id))).toThrow(expect.objectContaining({ code: 'RUN_INITIALIZATION_INCOMPLETE' }));
    const originals = new Map(readdirSync(directory).map(name => [name, readFileSync(join(directory, name))]));
    expect([...originals.keys()]).toContain('metadata.json');
    expect([...originals.keys()].some(name => name.startsWith('run.intent.'))).toBe(true);
    expect(originals.has('run.transaction.lock')).toBe(true);
    expect(store.observeRun(id)).toMatchObject({ kind: 'unavailable', reason: 'locked' });
    expect(store.listRuns().map(state => state.runId)).toEqual(['RUN-HEALTHY']);
    expect(store.listRunObservations({ agentId: 'different-agent' }).unavailable.map(row => row.runId)).toEqual([id]);
    expect(() => store.createRun(request(id))).toThrow(expect.objectContaining({ code: 'RUN_STATE_BUSY' }));
    for (const [name, bytes] of originals) expect(readFileSync(join(directory, name))).toEqual(bytes);
  });

  it('publishes canonical append with its state watermark under the same owner', () => {
    const { root, store } = fixture(); const id = 'RUN-CANONICAL-APPEND';
    store.createRun(request(id)); appendTranscriptEvent(id, event, root);
    const bytes = readFileSync(join(root, '.openslack.local/agents/runs', id, 'transcript.jsonl'));
    expect(store.readRun(id)?.persistence).toMatchObject({ schemaVersion: 2, revision: 1, transcriptBytes: bytes.length });
    expect(readTranscript(id, root)).toEqual([event]);
  });

  it('owns legacy append first and refuses later same-ID creation without overwriting bytes', () => {
    const { root, store } = fixture(); const id = 'RUN-LEGACY-APPEND';
    appendTranscriptEvent(id, event, root);
    const path = join(root, '.openslack.local/agents/runs', id, 'transcript.jsonl'), bytes = readFileSync(path);
    expect(() => store.createRun(request(id))).toThrow('Run already exists');
    expect(readFileSync(path)).toEqual(bytes);
    expect(existsSync(join(root, '.openslack.local/agents/runs', id, 'run.json'))).toBe(false);
    expect(() => store.readRun(id)).toThrow(expect.objectContaining({ code: 'RUN_INITIALIZATION_INCOMPLETE' }));
  });

  it.each(['locked', 'mismatch', 'json', 'utf8', 'bad-sort'] as const)('keeps two healthy records visible beside %s and leaves all source bytes unchanged', kind => {
    const { root, store } = fixture();
    for (const id of ['RUN-HEALTHY-A', 'RUN-HEALTHY-B', 'RUN-UNAVAILABLE']) store.createRun(request(id));
    const directory = join(root, '.openslack.local/agents/runs/RUN-UNAVAILABLE'), path = join(directory, 'run.json');
    const state = store.readRun('RUN-UNAVAILABLE')!;
    if (kind === 'locked') writeFileSync(join(directory, 'run.transaction.lock'), 'preserved legacy orphan');
    else if (kind === 'mismatch') writeFileSync(path, JSON.stringify({ ...state, runId: 'RUN-OTHER' }));
    else if (kind === 'json') writeFileSync(path, '{broken');
    else if (kind === 'utf8') writeFileSync(path, Buffer.from([0xff]));
    else writeFileSync(path, JSON.stringify({ ...state, startedAt: { not: 'a date' } }));
    const before = new Map(readdirSync(directory).map(name => [name, readFileSync(join(directory, name))]));
    const observed = listRunObservations(root);
    expect(observed.runs.map(row => row.runId).sort()).toEqual(['RUN-HEALTHY-A', 'RUN-HEALTHY-B']);
    expect(observed.unavailable).toHaveLength(1);
    expect(observed.unavailable[0]?.runId).toBe('RUN-UNAVAILABLE');
    expect(store.getRun('RUN-UNAVAILABLE')).toBeNull();
    expect(() => readRunStateSnapshot('RUN-UNAVAILABLE', root)).toThrow();
    for (const [name, bytes] of before) expect(readFileSync(join(directory, name))).toEqual(bytes);
    expect(readdirSync(directory).sort()).toEqual([...before.keys()].sort());
  });

  it('honors a finite read wait longer than one second without accepting a locked snapshot', async () => {
    const { root, store } = fixture(); const id = 'RUN-SLOW-WRITER'; store.createRun(request(id));
    const path = join(root, '.openslack.local/agents/runs', id, 'run.transaction.lock');
    const script = "import{writeFileSync,unlinkSync}from'node:fs';writeFileSync(process.argv[1],'fixture live writer');process.stdout.write('locked');setTimeout(()=>unlinkSync(process.argv[1]),1250);";
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, path], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`Fixture exit ${code}`))); });
    await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); });
    expect(() => store.readRun(id)).toThrow();
    expect((await readRunStateSnapshotWhenAvailable(id, root, { waitMs: 2500 }))?.runId).toBe(id);
    await exited;
  });

  it('rejects unbounded wait and promptly aborts a read without deleting its lock', async () => {
    const { root, store } = fixture(); const id = 'RUN-ABORT-READ'; store.createRun(request(id));
    const path = join(root, '.openslack.local/agents/runs', id, 'run.transaction.lock'); writeFileSync(path, 'unchanged');
    await expect(readRunStateSnapshotWhenAvailable(id, root, { waitMs: Infinity })).rejects.toThrow('finite bounded');
    const controller = new AbortController(); const pending = readRunStateSnapshotWhenAvailable(id, root, { waitMs: 5000, signal: controller.signal });
    controller.abort(new Error('fixture cancelled'));
    await expect(pending).rejects.toThrow('fixture cancelled');
    expect(readFileSync(path, 'utf8')).toBe('unchanged');
  });

  it('does not silently promote a legacy checkpoint into version-2 creation proof', () => {
    const { root, store } = fixture(); const id = 'RUN-LEGACY-CHECKPOINT';
    const state = store.createRun(request(id));
    const path = join(root, '.openslack.local/agents/runs', id, 'run.json');
    writeFileSync(path, JSON.stringify({ ...state, persistence: undefined }));
    const updated = store.updateRun(id, { toolCalls: 1 });
    expect(updated.persistence).not.toHaveProperty('schemaVersion');
    expect(updated.persistence).not.toHaveProperty('creationId');
    expect(updated.persistence).not.toHaveProperty('transactionId');
  });
  it.each([null, false, 0, [], { schemaVersion: 3, revision: 0, transcriptBytes: 0 }])('rejects unsupported persistence containers/version %j in strict reads', persistence => {
    const { root, store } = fixture(); const id = 'RUN-UNKNOWN-FORMAT'; const state = store.createRun(request(id));
    writeFileSync(join(root, '.openslack.local/agents/runs', id, 'run.json'), JSON.stringify({ ...state, persistence }));
    expect(() => store.readRun(id)).toThrow('unsupported persistence format');
    expect(store.observeRun(id)).toMatchObject({ kind: 'unavailable' });
  });

  it('keeps the original authorization error when untampered state and failed lock retirement coexist', () => {
    const { root, store } = fixture(); const id = 'RUN-PRIMARY-ERROR'; store.createRun(request(id));
    const original = store.readRun(id);
    const primary = Object.assign(new Error('fixture authority denied', { cause: new Error('fixture upstream') }), { code: 'PERMISSION_DENIED', runId: id });
    unlink.mockImplementation(path => {
      if (String(path).endsWith('run.transaction.lock')) throw Object.assign(new Error('fixture EPERM'), { code: 'EPERM' });
      return nativeUnlink(path);
    });
    let error: unknown;
    try { store.withRunTransaction(id, () => { throw primary; }); } catch (caught) { error = caught; }
    expect(error).toBe(primary);
    expect(error).toMatchObject({ code: 'PERMISSION_DENIED', runId: id, persistenceDiagnostic: 'RUN_OWNERSHIP_RETIREMENT_UNCONFIRMED' });
    expect(JSON.parse(readFileSync(join(root, '.openslack.local/agents/runs', id, 'run.json'), 'utf8'))).toEqual(original);
    expect(store.observeRun(id)).toMatchObject({ kind: 'unavailable', reason: 'locked' });
  });

  it.each(['create', 'append'] as const)('serializes two actual processes when %s obtains ownership first', async firstOperation => {
    const { root, store } = fixture(), id = 'RUN-ORDERED-WRITERS';
    const script = fileURLToPath(new URL('./fixtures/run-ordered-writer.mjs', import.meta.url));
    const release = join(root, 'release-owner'), firstMarker = join(root, 'first'), secondMarker = join(root, 'second');
    const children: ReturnType<typeof spawn>[] = [];
    const closed: Promise<void>[] = [];
    const run = (operation: string, marker: string, held: boolean) => {
      const child = spawn(process.execPath, [script, root, id, operation, marker, ...(held ? [release] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child); let output = '', stderr = '';
      closed.push(new Promise(resolve => child.once('close', () => resolve())));
      child.stdout!.on('data', bytes => { output += bytes; }); child.stderr!.on('data', bytes => { stderr += bytes; });
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        child.once('error', reject); child.once('close', code => code === 0 && !stderr ? resolve(JSON.parse(output)) : reject(new Error(`Writer ${code}: ${stderr}`)));
      });
    };
    try {
      const first = run(firstOperation, firstMarker, true);
      await vi.waitFor(() => expect(existsSync(`${firstMarker}.acquired`)).toBe(true), { timeout: 10_000, interval: 5 });
      const second = run(firstOperation === 'create' ? 'append' : 'create', secondMarker, false);
      await vi.waitFor(() => expect(existsSync(`${secondMarker}.attempt`)).toBe(true), { timeout: 10_000, interval: 5 });
      writeFileSync(release, 'release only this synthetic writer');
      const results = await Promise.all([first, second]);
      expect(results[0]).toMatchObject({ operation: firstOperation, outcome: 'committed' });
      expect(readTranscript(id, root)).toMatchObject([{ type: 'progress', data: { independentAppend: true } }]);
      if (firstOperation === 'create') {
        expect(results[1]).toMatchObject({ operation: 'append', outcome: 'committed' });
        expect(store.readRun(id)?.persistence?.transcriptBytes).toBe(readFileSync(join(root, '.openslack.local/agents/runs', id, 'transcript.jsonl')).length);
        expect(store.readRun(id)?.agentId).toBe('ordered-create-fixture');
      } else {
        expect(results[1]).toMatchObject({ operation: 'create', outcome: 'rejected', alreadyExists: true });
        expect(store.observeRun(id)).toMatchObject({ kind: 'unavailable', reason: 'creation-incomplete' });
      }
    } finally {
      if (!existsSync(release)) writeFileSync(release, 'release fixture after assertion failure');
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.all(closed);
    }
  }, 25_000);
});

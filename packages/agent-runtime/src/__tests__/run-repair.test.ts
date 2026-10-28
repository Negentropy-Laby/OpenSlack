import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type * as FsModule from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunStore } from '../run-store.js';
import { applyRunRepair, authorizeRunRepair, createRunRepairAuthorityPort, inspectRunRepair, type RunRepairCapability } from '../run-repair.js';
import { runSha256 } from '../run-files.js';

vi.mock('node:fs', async load => {
  const fs = await load<typeof FsModule>(); return { ...fs, openSync: vi.fn(fs.openSync) };
});
const open = vi.mocked(openSync), nativeOpen = open.getMockImplementation()!;
const roots: string[] = [];
afterEach(() => {
  open.mockReset().mockImplementation(nativeOpen); vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function rootFixture() { const root = mkdtempSync(join(tmpdir(), 'run-repair-fixture-')); roots.push(root); return root; }
const writerFixture = fileURLToPath(new URL('./fixtures/run-crash-writer.mjs', import.meta.url));
async function crash(root: string, id: string, stage: string) {
  const child = spawn(process.execPath, [writerFixture, root, id, stage], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += String(bytes).slice(0, 4096); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    const code = await exited;
    expect({ code, stderr }).toEqual({ code: stage === 'create-second-link' ? 71 : stage === 'update-before-rename' ? 72 : ['terminal-unlock', 'live-lock'].includes(stage) ? 73 : 79, stderr: '' });
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; }
}
function before(root: string, id: string) {
  const directory = join(root, '.openslack.local/agents/runs', id);
  return new Map(readdirSync(directory).map(name => [name, readFileSync(join(directory, name))]));
}
function syntheticAuthority(runId: string, digest: string, workspaceIdentity: string) {
  return createRunRepairAuthorityPort(scope => scope.runId === runId && scope.inspectionSha256 === digest && scope.workspaceIdentity === workspaceIdentity);
}

describe('ADR-0004 explicit single-run fixture maintenance', () => {
  it.each(['create-second-link', 'create-intent-fsync', 'create-metadata-link', 'create-metadata-unlink', 'create-run-unlink', 'create-lock-unlink',
    'update-intent-fsync', 'update-before-append', 'update-after-append', 'update-temp-fsync', 'update-before-rename', 'terminal-unlock'] as const)('archives the exact %s crash bytes before safe retirement, without any task replay', async stage => {
    const root = rootFixture(), id = 'RUN-REAL-CRASH'; await crash(root, id, stage);
    const original = before(root, id), inspection = inspectRunRepair(root, id);
    expect(inspection.plan).toBe(stage === 'terminal-unlock' ? 'preserve_committed' : 'fail_incomplete');
    // Preview is pure and keeps every byte/path, including the old lock.
    expect(before(root, id)).toEqual(original);
    const authority = syntheticAuthority(id, inspection.inspectionSha256, inspection.workspaceIdentity);
    const capability = authorizeRunRepair(inspection, authority);
    const receipt = applyRunRepair(inspection, capability);
    expect(receipt).toMatchObject({ runId: id, outcome: stage === 'terminal-unlock' ? 'preserved_commit' : 'indeterminate', resources: 'unknown', requiresReconciliation: true });
    for (const [name, bytes] of original) expect(readFileSync(join(receipt.archivePath, name))).toEqual(bytes);
    expect(runSha256(readFileSync(join(receipt.archivePath, 'before-manifest.json')))).toBe(receipt.archiveManifestSha256);
    const state = createRunStore(root, { sweepOrphans: false }).readRun(id)!;
    expect(state.status).toBe(stage === 'terminal-unlock' ? 'completed' : 'failed');
    if (stage === 'terminal-unlock') for (const name of ['run.json', 'metadata.json', 'transcript.jsonl']) {
      expect(readFileSync(join(root, '.openslack.local/agents/runs', id, name))).toEqual(original.get(name));
    }
    if (stage !== 'terminal-unlock') expect(state.persistence?.recovery).toMatchObject({ inspectionSha256: inspection.inspectionSha256, outcome: 'indeterminate' });
    expect(existsSync(join(root, '.openslack.local/agents/runs', id, 'run.transaction.lock'))).toBe(false);
    expect(existsSync(join(root, '.openslack.local/agents/runs', id, 'run.maintenance.json'))).toBe(false);
    expect(() => applyRunRepair(inspection, capability)).toThrow(expect.objectContaining({ code: 'RUN_REPAIR_NOT_AUTHORIZED' }));
  }, 20_000);

  it('does not turn a JSON inspection or forged capability into maintenance authority', async () => {
    const root = rootFixture(), id = 'RUN-NOMINAL-REPAIR'; await crash(root, id, 'create-second-link');
    const inspection = inspectRunRepair(root, id), original = before(root, id);
    const authority = syntheticAuthority(id, inspection.inspectionSha256, inspection.workspaceIdentity);
    expect(() => authorizeRunRepair(JSON.parse(JSON.stringify(inspection)), authority)).toThrow('RUN_REPAIR_INSPECTION_CHANGED');
    expect(() => applyRunRepair(inspection, {} as RunRepairCapability)).toThrow('RUN_REPAIR_NOT_AUTHORIZED');
    expect(before(root, id)).toEqual(original);
  }, 20_000);

  it('denies a changed inspection before publishing any barrier or archive', async () => {
    const root = rootFixture(), id = 'RUN-INSPECTION-DRIFT'; await crash(root, id, 'create-second-link');
    const inspection = inspectRunRepair(root, id);
    const capability = authorizeRunRepair(inspection, syntheticAuthority(id, inspection.inspectionSha256, inspection.workspaceIdentity));
    const path = join(root, '.openslack.local/agents/runs', id, 'metadata.json');
    writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('\n')]));
    const changed = before(root, id);
    expect(() => applyRunRepair(inspection, capability)).toThrow('RUN_REPAIR_INSPECTION_CHANGED');
    expect(before(root, id)).toEqual(changed);
    expect(existsSync(join(root, '.openslack.local/agents/runs/.recovery'))).toBe(false);
  }, 20_000);

  it('keeps missing/legacy/tampered birth evidence unavailable instead of trusting a PID', async () => {
    const root = rootFixture(), id = 'RUN-WITNESS-DRIFT'; await crash(root, id, 'create-second-link');
    const path = join(root, '.openslack.local/agents/runs', id, 'run.transaction.lock');
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value.writer) value.writer.birth = '0';
    writeFileSync(path, JSON.stringify(value));
    const original = before(root, id), inspection = inspectRunRepair(root, id);
    expect(inspection.plan).toBe('unavailable');
    const capability = authorizeRunRepair(inspection, syntheticAuthority(id, inspection.inspectionSha256, inspection.workspaceIdentity));
    expect(() => applyRunRepair(inspection, capability)).toThrow('RUN_REPAIR_UNAVAILABLE');
    expect(before(root, id)).toEqual(original);
  }, 20_000);

  it('denies retirement of a real live writer without fencing or pretending descendants stopped', async () => {
    const root = rootFixture(), id = 'RUN-LIVE-OWNER';
    const child = spawn(process.execPath, [writerFixture, root, id, 'live-lock'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.resume(); const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); });
      const original = before(root, id), inspection = inspectRunRepair(root, id);
      expect(inspection.plan).toBe('preserve_committed');
      const capability = authorizeRunRepair(inspection, syntheticAuthority(id, inspection.inspectionSha256, inspection.workspaceIdentity));
      expect(() => applyRunRepair(inspection, capability)).toThrow('RUN_REPAIR_UNAVAILABLE');
      expect(before(root, id)).toEqual(original);
      expect(existsSync(join(root, '.openslack.local/agents/runs/.recovery'))).toBe(false);
    } finally { child.kill('SIGKILL'); await exited; }
  }, 20_000);

  it('preserves a maintenance barrier and all originals if archive publication fails', async () => {
    const root = rootFixture(), id = 'RUN-ARCHIVE-FAILURE'; await crash(root, id, 'create-second-link');
    const original = before(root, id), inspection = inspectRunRepair(root, id);
    const capability = authorizeRunRepair(inspection, syntheticAuthority(id, inspection.inspectionSha256, inspection.workspaceIdentity));
    open.mockImplementation((path, flags, mode) => {
      if (String(path).includes('.recovery') && flags === 'wx') throw Object.assign(new Error('isolated archive EPERM'), { code: 'EPERM' });
      return nativeOpen(path, flags, mode);
    });
    expect(() => applyRunRepair(inspection, capability)).toThrow('RUN_REPAIR_INDETERMINATE');
    for (const [name, bytes] of original) expect(readFileSync(join(root, '.openslack.local/agents/runs', id, name))).toEqual(bytes);
    expect(existsSync(join(root, '.openslack.local/agents/runs', id, 'run.maintenance.json'))).toBe(true);
    expect(inspectRunRepair(root, id)).toMatchObject({ plan: 'unavailable', reason: 'maintenance_unresolved' });
  }, 20_000);

  it.each(['barrier', 'archive-manifest', 'recovery-state', 'before-unlock', 'after-unlock'] as const)(
    'keeps an actual %s maintenance crash isolated across a read-only restart without replay', async stage => {
      const root = rootFixture(), id = 'RUN-MAINTENANCE-CRASH'; await crash(root, id, 'create-second-link');
      const originals = before(root, id);
      const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/run-crash-repair.mjs', import.meta.url)), root, id, stage],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = ''; child.stdout.resume(); child.stderr.on('data', bytes => { stderr += String(bytes); });
      const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
      expect({ code, stderr }).toEqual({ code: 83, stderr: '' });
      const stoppedBytes = before(root, id);
      expect(stoppedBytes.has('run.maintenance.json')).toBe(true);
      expect(inspectRunRepair(root, id)).toMatchObject({ plan: 'unavailable', reason: 'maintenance_unresolved' });
      const restarted = createRunStore(root, { sweepOrphans: false });
      expect(restarted.observeRun(id)).toMatchObject({ kind: 'unavailable', reason: 'persistence-unconfirmed' });
      expect(() => restarted.readRun(id)).toThrow();
      expect(before(root, id)).toEqual(stoppedBytes);
      const archiveRoot = join(root, '.openslack.local/agents/runs/.recovery', id);
      if (existsSync(archiveRoot)) {
        const archive = join(archiveRoot, readdirSync(archiveRoot)[0]!);
        for (const [name, bytes] of originals) expect(readFileSync(join(archive, name))).toEqual(bytes);
      } else expect(stage).toBe('barrier');
    }, 40_000);

  it.each(['partial-append', 'invalid-utf8', 'bad-jsonl', 'transcript-tamper', 'missing-intent', 'broken-base', 'broken-predecessor', 'external-hardlink'] as const)(
    'does not retire unprovable %s bytes or synthesize an executable result', async damage => {
      const root = rootFixture(), id = 'RUN-UNPROVABLE';
      await crash(root, id, damage === 'partial-append' ? 'update-partial-append' : ['broken-base', 'broken-predecessor'].includes(damage) ? 'update-before-append' : 'update-before-rename');
      const directory = join(root, '.openslack.local/agents/runs', id);
      const transcript = join(directory, 'transcript.jsonl');
      if (damage === 'invalid-utf8') writeFileSync(transcript, Buffer.from([0xff, 0x0a]));
      if (damage === 'bad-jsonl') writeFileSync(transcript, '{broken}\n');
      if (damage === 'transcript-tamper') writeFileSync(transcript, readFileSync(transcript).toString().replace('fixtureOnly', 'changedOnly'));
      const lock = JSON.parse(readFileSync(join(directory, 'run.transaction.lock'), 'utf8'));
      const intentPath = join(directory, `run.intent.${lock.transactionId}.json`);
      if (damage === 'missing-intent') rmSync(intentPath);
      if (damage === 'broken-base') {
        const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
        intent.base.stateSha256 = 'f'.repeat(64); writeFileSync(intentPath, JSON.stringify(intent));
      }
      if (damage === 'broken-predecessor') {
        const current = JSON.parse(readFileSync(intentPath, 'utf8'));
        const previousPath = join(directory, `run.intent.${current.base.transactionId}.json`);
        const previous = JSON.parse(readFileSync(previousPath, 'utf8'));
        // Keep canonical bytes/current base digest intact. Only the unchecked
        // predecessor edge differs, unlike the older broken-base counterexample.
        previous.target.stateSha256 = 'f'.repeat(64); writeFileSync(previousPath, JSON.stringify(previous));
      }
      if (damage === 'external-hardlink') linkSync(join(directory, 'run.json'), join(root, 'external-state-alias'));
      const bytes = before(root, id), inspection = inspectRunRepair(root, id);
      expect(inspection.plan).toBe('unavailable');
      const port = syntheticAuthority(id, inspection.inspectionSha256, inspection.workspaceIdentity);
      if (damage === 'external-hardlink') {
        // Unsafe descriptor collection cannot even mint a nominal inspection capability.
        expect(() => authorizeRunRepair(inspection, port)).toThrow('RUN_REPAIR_INSPECTION_CHANGED');
      } else {
        const capability = authorizeRunRepair(inspection, port);
        expect(() => applyRunRepair(inspection, capability)).toThrow('RUN_REPAIR_UNAVAILABLE');
      }
      expect(before(root, id)).toEqual(bytes);
      expect(existsSync(join(directory, 'run.maintenance.json'))).toBe(false);
    }, 20_000);

  it.each(['create-lock-fsync', 'create-metadata-temp-fsync', 'create-state-temp-fsync'] as const)(
    'isolates a real %s crash before complete intent instead of inferring recoverability', async stage => {
      const root = rootFixture(), id = 'RUN-PRE-INTENT'; await crash(root, id, stage);
      const original = before(root, id), inspection = inspectRunRepair(root, id);
      expect(inspection.plan).toBe('unavailable');
      const port = syntheticAuthority(id, inspection.inspectionSha256, inspection.workspaceIdentity);
      const capability = authorizeRunRepair(inspection, port);
      expect(() => applyRunRepair(inspection, capability)).toThrow('RUN_REPAIR_UNAVAILABLE');
      expect(before(root, id)).toEqual(original);
      expect(createRunStore(root, { sweepOrphans: false }).observeRun(id)).toMatchObject({ kind: 'unavailable', reason: 'locked' });
      expect(existsSync(join(root, '.openslack.local/agents/runs', id, 'run.maintenance.json'))).toBe(false);
      expect(existsSync(join(root, '.openslack.local/agents/runs/.recovery'))).toBe(false);
    }, 20_000);

  it.each(['input-after-archive', 'lock-path-after-archive', 'archive-tamper', 'directory-replacement'] as const)(
    'preserves the barrier when %s violates a fresh proof after copying', async kind => {
      const root = rootFixture(), id = 'RUN-MAINTENANCE-CAS'; await crash(root, id, 'create-second-link');
      const directory = join(root, '.openslack.local/agents/runs', id), original = before(root, id), inspection = inspectRunRepair(root, id);
      const capability = authorizeRunRepair(inspection, syntheticAuthority(id, inspection.inspectionSha256, inspection.workspaceIdentity));
      let injected = false;
      let mutationCompleted = false;
      let directoryRenameRejection: NodeJS.ErrnoException | undefined;
      let changedPath = '';
      const oldDirectory = lstatSync(directory, { bigint: true }), oldLock = lstatSync(join(directory, 'run.transaction.lock'), { bigint: true });
      open.mockImplementation((path, flags, mode) => {
        const name = String(path);
        if (!injected && flags === 'wx' && name.includes(`${join(directory, 'run.repair.')}`)) {
          injected = true;
          if (kind === 'input-after-archive') {
            changedPath = join(directory, 'metadata.json'); writeFileSync(changedPath, Buffer.concat([original.get('metadata.json')!, Buffer.from('\n')]));
          }
          if (kind === 'lock-path-after-archive') {
            renameSync(join(directory, 'run.transaction.lock'), join(root, 'displaced-lock'));
            writeFileSync(join(directory, 'run.transaction.lock'), original.get('run.transaction.lock')!);
          }
          if (kind === 'archive-tamper') {
            const parent = join(root, '.openslack.local/agents/runs/.recovery', id), archive = join(parent, readdirSync(parent)[0]!);
            changedPath = join(archive, 'before-manifest.json'); writeFileSync(changedPath, '{"tampered":true}');
          }
          if (kind === 'directory-replacement') {
            const displaced = join(root, 'displaced-owned-directory');
            try { renameSync(directory, displaced); }
            catch (error) { directoryRenameRejection = error as NodeJS.ErrnoException; throw error; }
            mkdirSync(directory);
            for (const entry of readdirSync(displaced)) writeFileSync(join(directory, entry), readFileSync(join(displaced, entry)));
          }
          mutationCompleted = true;
        }
        return nativeOpen(path, flags, mode);
      });
      expect(() => applyRunRepair(inspection, capability)).toThrow();
      expect(injected).toBe(true);
      if (directoryRenameRejection !== undefined) {
        // Windows may prevent replacing a directory with the repair's live
        // descriptors. Prove that exact OS refusal, not a fabricated CAS pass.
        expect(process.platform).toBe('win32');
        expect(kind).toBe('directory-replacement');
        expect(directoryRenameRejection).toMatchObject({ syscall: 'rename', path: directory, dest: join(root, 'displaced-owned-directory') });
        expect(['EPERM', 'EACCES', 'EBUSY']).toContain(directoryRenameRejection.code);
        expect(mutationCompleted).toBe(false);
        expect(existsSync(join(root, 'displaced-owned-directory'))).toBe(false);
        const current = lstatSync(directory, { bigint: true });
        expect([current.dev, current.ino]).toEqual([oldDirectory.dev, oldDirectory.ino]);
        for (const [name, bytes] of original) expect(readFileSync(join(directory, name))).toEqual(bytes);
        console.info(JSON.stringify({ scope: 'native directory substitution blocked before CAS', code: directoryRenameRejection.code,
          syscall: directoryRenameRejection.syscall, originalBytesRetained: true }));
      } else expect(mutationCompleted).toBe(true);
      if (kind === 'input-after-archive') expect(readFileSync(changedPath)).toEqual(Buffer.concat([original.get('metadata.json')!, Buffer.from('\n')]));
      if (kind === 'archive-tamper') expect(readFileSync(changedPath, 'utf8')).toBe('{"tampered":true}');
      if (kind === 'lock-path-after-archive') {
        const now = lstatSync(join(directory, 'run.transaction.lock'), { bigint: true });
        expect([now.dev, now.ino]).not.toEqual([oldLock.dev, oldLock.ino]);
        expect(readFileSync(join(directory, 'run.transaction.lock'))).toEqual(original.get('run.transaction.lock'));
      }
      if (kind === 'directory-replacement' && directoryRenameRejection === undefined) {
        const now = lstatSync(directory, { bigint: true }); expect([now.dev, now.ino]).not.toEqual([oldDirectory.dev, oldDirectory.ino]);
      }
      expect(existsSync(join(directory, 'run.maintenance.json'))).toBe(true);
      expect(createRunStore(root, { sweepOrphans: false }).observeRun(id)).toMatchObject({ kind: 'unavailable' });
      expect(inspectRunRepair(root, id).plan).toBe('unavailable');
    }, 20_000);
});

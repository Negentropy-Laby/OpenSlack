import { createHash } from 'node:crypto';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RunStore,
  WORKFLOW_CHECKPOINT_CONTROL_MAX_BYTES,
  parseWorkflowCheckpointReservation,
} from './run-store.js';
import { createWorkflowRunStoreRecoveryAccess } from './internal/workflow-run-store-recovery-access.js';
import { parseWorkflowResumeIntent } from './internal/workflow-runner-resume-source.js';
import { createWorkflowRunRouteJournal } from './workflow-run-routing.js';
import { resolveWorkflowRunProjectionRoot } from './workflow-run-projection.js';
import { canonicalWorkflowControlAuthorityJson as canonical } from './workflow-control-authority-contract.js';
import type { WorkflowControlAuthorityPort } from './workflow-control-authority-client.js';
import type { WorkflowCheckpointControlState } from './workflow-checkpoint-shadow-contract.js';
import {
  readOwnerFileBytes,
  writeExclusiveBytes,
  productionJournalSecurity,
} from './workflow-control-shadow.js';
import {
  recoveryCheckpointState,
  assertRecoveryFrontier,
  recoveryConflict,
  type WorkflowRunRecoveryEvidencePort,
} from './workflow-run-recovery-evidence.js';

export interface WorkflowCheckpointRepairReport {
  readonly schema: 'openslack.workflow_checkpoint_repair.v1';
  readonly runId: string;
  readonly applied: boolean;
  readonly repairable: boolean;
  readonly diagnostics: readonly string[];
  readonly actions: readonly string[];
  readonly backups: readonly string[];
}
export interface WorkflowCheckpointRepairOptions {
  readonly rootDir: string;
  readonly apply?: boolean;
  readonly authority?: WorkflowControlAuthorityPort;
  readonly recovery?: WorkflowRunRecoveryEvidencePort;
  readonly signal?: AbortSignal;
}
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Read and preserve corrupt bytes without decoding them as UTF-8. */
async function repairBytes(path: string): Promise<Buffer | null> {
  try {
    return await readOwnerFileBytes(
      path,
      productionJournalSecurity(),
      WORKFLOW_CHECKPOINT_CONTROL_MAX_BYTES,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

class CheckpointRepairStore extends RunStore {
  constructor(rootDir: string) {
    super({
      baseDir: resolveWorkflowRunProjectionRoot(rootDir, 'go'),
      access: createWorkflowRunStoreRecoveryAccess(),
    });
  }
  async snapshot(runId: string) {
    const directory = this.checkpointControlDir(runId);
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const selected = [
      this.checkpointControlPath(runId),
      `${this.checkpointControlPath(runId)}.intent`,
      ...names
        .filter((name) => /^resume-[0-9a-f]{64}\.json$/u.test(name))
        .sort()
        .map((name) => join(directory, name)),
    ];
    const entries = await Promise.all(
      selected.map(async (path) => [path, await repairBytes(path)] as const),
    );
    return new Map(entries);
  }
  async apply(
    runId: string,
    snapshot: Map<string, Buffer | null>,
    next: WorkflowCheckpointControlState,
    corruptIntents: string[],
    revalidate: () => Promise<void>,
  ): Promise<string[]> {
    const headPath = this.checkpointControlPath(runId);
    const markerPath = `${headPath}.intent`;
    const repairId = `repair.${digest(canonical(next))}`;
    const marker = canonical({
      schema: 'openslack.workflow_checkpoint_reservation.v1',
      bindingId: repairId,
    });
    if (!this.fs.withExclusiveLock || !this.fs.writeOwnerOnlyAtomic)
      return recoveryConflict(
        'Checkpoint repair requires the production filesystem safety boundary.',
      );
    await this.fs.ensureOwnerOnlyDirectory!(this.checkpointControlDir(runId));
    const locked = <T>(action: () => Promise<T>) =>
      this.fs.withExclusiveLock!(`${headPath}.lock`, action);
    const same = async (expected: Map<string, Buffer | null>) => {
      const current = await this.snapshot(runId);
      if (
        current.size !== expected.size ||
        [...expected].some(([path, bytes]) => {
          const actual = current.get(path);
          return (
            actual === undefined ||
            (bytes === null ? actual !== null : actual === null || !actual.equals(bytes))
          );
        })
      )
        recoveryConflict('Checkpoint files changed after diagnosis.');
    };
    const backups: string[] = [];
    const backup = async (path: string, bytes: Buffer | null) => {
      if (bytes === null) return;
      const destination = `${path}.repair-original-${digest(bytes)}`;
      const existing = await repairBytes(destination);
      if (existing && !existing.equals(bytes))
        return recoveryConflict('Checkpoint repair backup conflicts with preserved evidence.');
      if (!existing) {
        // A byte-preserving owner-only backup, including invalid UTF-8.
        await writeExclusiveBytes(destination, bytes, productionJournalSecurity());
      }
      backups.push(destination);
    };
    await locked(async () => {
      await same(snapshot);
      await backup(markerPath, snapshot.get(markerPath) ?? null);
      await this.fs.writeOwnerOnlyAtomic!(markerPath, marker);
    });
    // Network I/O remains outside the checkpoint lock. The durable reservation
    // prevents every local checkpoint writer from racing this revalidation.
    await revalidate();
    const reserved = new Map(snapshot);
    reserved.set(markerPath, Buffer.from(marker));
    await locked(async () => {
      await same(reserved);
      await backup(headPath, snapshot.get(headPath) ?? null);
      for (const path of corruptIntents) await backup(path, snapshot.get(path) ?? null);
      await this.writeCheckpointControl(runId, next);
      for (const path of corruptIntents) await unlink(path);
      await this.fs.writeOwnerOnlyAtomic!(
        markerPath,
        canonical({ schema: 'openslack.workflow_checkpoint_reservation.v1', bindingId: null }),
      );
    });
    return backups;
  }
}

export async function repairWorkflowCheckpoints(
  runId: string,
  options: WorkflowCheckpointRepairOptions,
): Promise<WorkflowCheckpointRepairReport> {
  const diagnostics: string[] = [];
  const actions: string[] = [];
  const report = (
    repairable = false,
    applied = false,
    backups: string[] = [],
  ): WorkflowCheckpointRepairReport => ({
    schema: 'openslack.workflow_checkpoint_repair.v1',
    runId,
    repairable,
    applied,
    diagnostics,
    actions,
    backups,
  });
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(runId) ||
    (process.platform === 'win32' && runId.includes(':'))
  ) {
    diagnostics.push('WORKFLOW_RUN_PROJECTION_ID_INVALID');
    return report();
  }
  try {
    const route = await createWorkflowRunRouteJournal(options.rootDir).locateReadOnly(runId);
    if (!route || route.receipt.route.backend !== 'go') {
      diagnostics.push('WORKFLOW_RUN_RECOVERY_ROUTE_REQUIRED');
      return report();
    }
    const store = new CheckpointRepairStore(options.rootDir);
    const snapshot = await store.snapshot(runId);
    let local: WorkflowCheckpointControlState | undefined;
    try {
      local = (await store.loadCheckpointControl(runId)) ?? undefined;
    } catch {
      diagnostics.push('WORKFLOW_CHECKPOINT_CONTROL_CORRUPT');
    }
    if (!local && diagnostics.length === 0) diagnostics.push('WORKFLOW_CHECKPOINT_CONTROL_MISSING');
    const corruptIntents: string[] = [];
    for (const [path, bytes] of snapshot)
      if (bytes && /resume-[0-9a-f]{64}\.json$/u.test(path)) {
        try {
          const value: unknown = JSON.parse(bytes.toString('utf8'));
          if (canonical(value) + '\n' !== bytes.toString('utf8')) throw new Error();
        } catch {
          corruptIntents.push(path);
          diagnostics.push('WORKFLOW_RUN_RESUME_INTENT_CORRUPT');
        }
      }
    if (!options.authority || !options.recovery) {
      diagnostics.push('WORKFLOW_RUN_RECOVERY_AUTHORITY_REQUIRED');
      return report();
    }
    const authority = options.authority,
      recovery = options.recovery;
    const proof = await recovery.readRecoveryEvidence(runId, undefined, options.signal);
    const head = await authority.read(runId, route.receipt.route, options.signal);
    const unknownOperation = proof.unfinished.some(
      (entry) =>
        !proof.bindings.some(
          (binding) => binding.bindingId === entry.bindingId && binding.resolution !== null,
        ),
    );
    if (
      proof.activeAttempts.length ||
      unknownOperation ||
      !['paused', 'paused_waiting_approval', 'resuming', 'running'].includes(head.state)
    )
      return recoveryConflict('Active or unproven authority operations prevent checkpoint repair.');
    const next = recoveryCheckpointState(proof, local);
    if (!next)
      return recoveryConflict(
        'There is not enough durable checkpoint history to rebuild this cache.',
      );
    // Accepted immutable resolutions remain usable after a startup
    // reconciliation latch. This cache-only repair cannot authorize execution.
    assertRecoveryFrontier({ ...proof, unfinished: [] }, head, next);
    if (local && local.resumeGeneration > next.resumeGeneration)
      return recoveryConflict('Repair cannot rewind the local authority generation.');
    for (const [path, bytes] of snapshot) {
      if (!bytes || !/resume-[0-9a-f]{64}\.json$/u.test(path)) continue;
      const match = proof.bindings.find((entry) =>
        path.endsWith(`resume-${digest(entry.bindingId)}.json`),
      );
      if (!match) return recoveryConflict('A resume intent has no matching durable operation.');
      const stage = JSON.parse(match.stage);
      try {
        const intent = parseWorkflowResumeIntent(
          bytes.toString('utf8'),
          stage,
          JSON.parse(stage.target.body),
        );
        if (match.resolution) {
          const resolution = JSON.parse(match.resolution);
          if (
            intent.priorRevision !== resolution.evidence.sourceAuthority.expectedRevision ||
            intent.record.resumeGeneration !==
              resolution.evidence.sourceAuthority.acceptedResumeGeneration ||
            (intent.schema === 'openslack.workflow_runner_resume_source_intent.v2' &&
              canonical(intent.evidence) !== canonical(resolution.evidence))
          )
            throw new Error();
        }
      } catch {
        if (!match.resolution)
          return recoveryConflict('A corrupt resume intent has no exact durable resolution.');
        if (!corruptIntents.includes(path)) {
          corruptIntents.push(path);
          diagnostics.push('WORKFLOW_RUN_RESUME_INTENT_CORRUPT');
        }
      }
    }
    const marker = snapshot.get(`${store.checkpointControlPath(runId)}.intent`);
    let clearMarker = false;
    if (marker) {
      try {
        clearMarker = parseWorkflowCheckpointReservation(marker.toString('utf8')) !== null;
      } catch {
        clearMarker = true;
        diagnostics.push('WORKFLOW_CHECKPOINT_RESERVATION_CORRUPT');
      }
    }
    const matches =
      local &&
      local.revision === next.revision &&
      local.resumeGeneration === next.resumeGeneration &&
      canonical(local.seenBindingHashes) === canonical(next.seenBindingHashes) &&
      canonical(local.checkpoints) === canonical(next.checkpoints) &&
      canonical(local.activeBinding) === canonical(next.activeBinding);
    if (matches && !clearMarker && !corruptIntents.length) {
      diagnostics.push('WORKFLOW_CHECKPOINT_CACHE_HEALTHY');
      return report();
    }
    actions.push(
      'Preserve original checkpoint files and rebuild the local cache from exact Go receipts.',
    );
    if (corruptIntents.length)
      actions.push(
        'Preserve and remove torn intents whose committed history is point-readable in Go.',
      );
    if (!options.apply) return report(true);
    const backups = await store.apply(runId, snapshot, next, corruptIntents, async () => {
      options.signal?.throwIfAborted();
      const fresh = await recovery.readRecoveryEvidence(runId, undefined, options.signal);
      const freshHead = await authority.read(runId, route.receipt.route, options.signal);
      if (
        fresh.snapshot !== proof.snapshot ||
        canonical(freshHead.record) !== canonical(head.record) ||
        fresh.activeAttempts.length
      )
        recoveryConflict('Authority evidence changed before checkpoint repair.');
      const freshRoute = await createWorkflowRunRouteJournal(options.rootDir).locateReadOnly(runId);
      if (canonical(freshRoute) !== canonical(route))
        recoveryConflict('Route changed before checkpoint repair.');
    });
    return report(true, true, backups);
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED';
    diagnostics.push(code);
    return report();
  }
}

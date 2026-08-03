import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowControlObservationError } from '../workflow-control-observation.js';
import {
  WORKFLOW_CONTROL_SHADOW_RECEIPT_SCHEMA,
  createWorkflowControlObservationPort,
  createWorkflowControlShadowPublisherPort,
  prepareWorkflowControlShadowRequest,
  type WorkflowControlShadowDiagnostic,
} from '../workflow-control-shadow.js';
import { hashWorkflowControlValue } from '../workflow-control-contract.js';
import { shadowObservation } from './workflow-control-shadow-fixtures.js';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function journalRoot(name: string) {
  const temporaryRoot = process.platform === 'win32' ? tmpdir() : '/tmp';
  const parent = resolve(await mkdtemp(join(temporaryRoot, `${name}-`)));
  roots.push(parent);
  await chmod(parent, 0o700);
  return join(parent, 'journal');
}

function receiptFor(
  envelope: Parameters<ReturnType<typeof createWorkflowControlShadowPublisherPort>['publish']>[0],
) {
  const request = prepareWorkflowControlShadowRequest(envelope);
  return {
    schema: WORKFLOW_CONTROL_SHADOW_RECEIPT_SCHEMA,
    operation: 'observation_ingest',
    status: 'accepted',
    parity: 'matched',
    idempotencyKey: request.idempotencyKey,
    requestFingerprint: request.requestFingerprint,
    workspaceId: envelope.source.workspaceId,
    runId: envelope.source.runId,
    sourceSequence: envelope.source.sourceSequence,
    observationDigest: createHash('sha256').update(request.body).digest('hex'),
    observationHash: envelope.projection.observationHash,
    committedAt: '2026-08-03T00:00:03.000Z',
  } as const;
}

describe('Workflow Control GS7-B durable observation journal', () => {
  it('is default-off and requires no journal, network, or authority dependencies', async () => {
    const port = await createWorkflowControlObservationPort();
    expect(() => port.observeRun('run-disabled')).not.toThrow();
    await expect(port.flush()).resolves.toBeUndefined();
  });

  it('coalesces identical snapshots and allocates monotonic sequence per workspace/run', async () => {
    const published: number[] = [];
    const publisher = createWorkflowControlShadowPublisherPort(async (envelope) => {
      published.push(envelope.source.sourceSequence);
      return receiptFor(envelope);
    });
    let observation = shadowObservation();
    const root = await journalRoot('workflow-shadow-coalesce');
    const port = await createWorkflowControlObservationPort({
      enabled: true,
      workspaceId: 'workspace.test',
      journalRoot: root,
      publisher,
      buildObservation: async () => observation,
    });
    port.observeRun(observation.runId);
    port.observeRun(observation.runId);
    await port.flush();
    observation = shadowObservation({ updatedAt: '2026-08-03T00:00:02.000Z' });
    port.observeRun(observation.runId);
    await port.flush();
    expect(published).toEqual([1, 2]);
    expect(await readdir(join(root, 'entries'))).toEqual([]);
    const [stateName] = await readdir(join(root, 'states'));
    const state = JSON.parse(await readFile(join(root, 'states', stateName!), 'utf8')) as {
      lastSequence: number;
      ackedSequence: number;
      lastObservationHash: string;
    };
    expect(state).toMatchObject({ lastSequence: 2, ackedSequence: 2 });
    expect(state.lastObservationHash).toBe(hashWorkflowControlValue(observation));
  });

  it('persists before publish and replays the exact entry after an unavailable publisher', async () => {
    const root = await journalRoot('workflow-shadow-replay');
    const unavailable = createWorkflowControlShadowPublisherPort(async () => {
      throw new Error('offline');
    });
    const observation = shadowObservation();
    const first = await createWorkflowControlObservationPort({
      enabled: true,
      workspaceId: 'workspace.test',
      journalRoot: root,
      publisher: unavailable,
      buildObservation: async () => observation,
    });
    first.observeRun(observation.runId);
    await first.flush();
    expect(await readdir(join(root, 'entries'))).toHaveLength(1);

    const sequences: number[] = [];
    const available = createWorkflowControlShadowPublisherPort(async (envelope) => {
      sequences.push(envelope.source.sourceSequence);
      return receiptFor(envelope);
    });
    const second = await createWorkflowControlObservationPort({
      enabled: true,
      workspaceId: 'workspace.test',
      journalRoot: root,
      publisher: available,
      buildObservation: async () => observation,
    });
    await second.flush();
    expect(sequences).toEqual([1]);
    expect(await readdir(join(root, 'entries'))).toEqual([]);
  });

  it('recovers an entry orphaned between durable entry and state publication', async () => {
    const root = await journalRoot('workflow-shadow-orphan');
    const observation = shadowObservation();
    const first = await createWorkflowControlObservationPort({
      enabled: true,
      workspaceId: 'workspace.test',
      journalRoot: root,
      publisher: createWorkflowControlShadowPublisherPort(async () => {
        throw new Error('offline');
      }),
      buildObservation: async () => observation,
    });
    first.observeRun(observation.runId);
    await first.flush();
    const [stateName] = await readdir(join(root, 'states'));
    await rm(join(root, 'states', stateName!));

    const sequences: number[] = [];
    const second = await createWorkflowControlObservationPort({
      enabled: true,
      workspaceId: 'workspace.test',
      journalRoot: root,
      publisher: createWorkflowControlShadowPublisherPort(async (envelope) => {
        sequences.push(envelope.source.sourceSequence);
        return receiptFor(envelope);
      }),
      buildObservation: async () => observation,
    });
    await second.flush();
    expect(sequences).toEqual([1]);
    expect(await readdir(join(root, 'entries'))).toEqual([]);
  });

  it('keeps invalid and legacy observations out of the durable journal with hashed diagnostics', async () => {
    const diagnostics: WorkflowControlShadowDiagnostic[] = [];
    const publisher = createWorkflowControlShadowPublisherPort(
      vi.fn(async (envelope) => receiptFor(envelope)),
    );
    const root = await journalRoot('workflow-shadow-invalid');
    const port = await createWorkflowControlObservationPort({
      enabled: true,
      workspaceId: 'workspace.test',
      journalRoot: root,
      publisher,
      buildObservation: async () => {
        throw new WorkflowControlObservationError(
          'WORKFLOW_CONTROL_OBSERVATION_LEGACY_MANIFEST_HASH',
          'legacy hash',
        );
      },
      diagnosticSink: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    });
    port.observeRun('run-shadow-test');
    await port.flush();
    expect(await readdir(join(root, 'entries'))).toEqual([]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        outcome: 'legacy_manifest_skipped',
        workspaceIdHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        runIdHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain('workspace.test');
    expect(JSON.stringify(diagnostics)).not.toContain('run-shadow-test');
  });
});

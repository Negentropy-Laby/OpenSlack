import { describe, expect, it } from 'vitest';
import type { WorkflowMeta } from '../types.js';
import { hashWorkflowSource, resolveWorkflowIdentityHash } from '../internal/workflow-identity.js';
import { bindWorkflowSourceIdentity } from '../internal/workflow-identity.js';
import { runMetaWorkflowIdentity } from '../internal/workflow-run-identity.js';
import {
  createWorkflowSourceSnapshot,
  verifyWorkflowSourceSnapshot,
  verifyWorkflowSourceManifest,
  requireWorkflowSourceSnapshot,
  WorkflowSourceEvidenceError,
  workflowSourceEvidenceCause,
  renderWorkflowSourceEvidence,
} from '../internal/workflow-source-snapshot.js';

const meta: WorkflowMeta = {
  name: 'identity-test',
  version: '1.0.0',
  description: 'Workflow identity test.',
  phases: [{ title: 'Run', detail: 'Run phase' }],
};

describe('workflow executable identity', () => {
  it.each([
    ['raw-sha256', 'recorded'],
    ['openslack.workflow-runner.workflow-source.v2', 'recorded'],
    [undefined, 'unknown'],
  ] as const)(
    'classifies persisted domain %s without inferring current source',
    (domain, provenance) => {
      expect(
        runMetaWorkflowIdentity({ manifestHash: 'a'.repeat(64), manifestHashDomain: domain }),
      ).toEqual({
        digest: 'a'.repeat(64),
        domain: domain ?? 'unknown',
        provenance,
      });
      const original = { manifestHash: 'historical-weak-id' };
      expect(runMetaWorkflowIdentity(original)).toEqual({
        digest: 'historical-weak-id',
        domain: 'unknown',
        provenance: 'unknown',
      });
      expect(original).toEqual({ manifestHash: 'historical-weak-id' });
    },
  );
  it('renders only fixed source diagnostics and safe hashes at frontend boundaries', () => {
    const error = new WorkflowSourceEvidenceError('SOURCE_DRIFT', 'PRIVATE_SOURCE_SENTINEL', {
      domain: 'runner-v2-source',
      stored: 'a'.repeat(64),
      current: 'PRIVATE_SOURCE_SENTINEL',
    });
    const output = renderWorkflowSourceEvidence(error, 'Reload the reviewed workflow.').join('\n');
    expect(output).toContain('SOURCE_DRIFT');
    expect(output).toContain('a'.repeat(64));
    expect(output).not.toContain('PRIVATE_SOURCE_SENTINEL');
    Object.assign(error, { code: 'PRIVATE_CODE_SENTINEL' });
    expect(renderWorkflowSourceEvidence(error, 'Reload.').join('\n')).not.toContain('PRIVATE_');
    const getter = () => {
      throw new Error('must not execute');
    };
    Object.defineProperty(error, 'identities', { get: getter });
    expect(renderWorkflowSourceEvidence(error, 'Reload.').join('\n')).not.toContain('PRIVATE_');
  });
  it('preserves typed evidence through frontend boundary causes without duck-typing arbitrary errors', () => {
    const evidence = new WorkflowSourceEvidenceError('MANIFEST_DRIFT', 'Manifest changed', {
      domain: 'runner-v2-manifest',
      stored: 'a'.repeat(64),
      current: 'b'.repeat(64),
    });
    expect(workflowSourceEvidenceCause(evidence)).toBe(evidence);
    expect(workflowSourceEvidenceCause(new Error('boundary', { cause: evidence }))).toBe(evidence);
    expect(workflowSourceEvidenceCause({ reasonCode: 'MANIFEST_DRIFT' })).toBeUndefined();
    expect(workflowSourceEvidenceCause(new Error('unclassified'))).toBeUndefined();
  });
  it('classifies missing loader evidence without minting it from supplied bytes', () => {
    expect(() => requireWorkflowSourceSnapshot(undefined, Buffer.from('source'), meta)).toThrow(
      expect.objectContaining({
        code: 'WORKFLOW_SOURCE_EVIDENCE_INVALID',
        reasonCode: 'SOURCE_EVIDENCE_MISSING',
      }),
    );
  });

  it('rejects copied handles and distinguishes source and manifest drift', () => {
    const bytes = Buffer.from('source');
    const snapshot = createWorkflowSourceSnapshot(bytes, meta);
    expect(() => verifyWorkflowSourceManifest({ ...snapshot }, meta)).toThrow(
      expect.objectContaining({ reasonCode: 'SOURCE_EVIDENCE_UNRECOGNIZED' }),
    );
    expect(() => verifyWorkflowSourceSnapshot(snapshot, Buffer.from('changed'), meta)).toThrow(
      expect.objectContaining({ reasonCode: 'SOURCE_DRIFT' }),
    );
    expect(() =>
      verifyWorkflowSourceManifest(snapshot, { ...meta, description: 'changed' }),
    ).toThrow(expect.objectContaining({ reasonCode: 'MANIFEST_DRIFT' }));
  });

  it('keeps owned source and manifest stable when caller inputs change', () => {
    const bytes = Buffer.from('source');
    const manifest = structuredClone(meta);
    const snapshot = createWorkflowSourceSnapshot(bytes, manifest);
    bytes.fill(0);
    manifest.description = 'changed';
    expect(requireWorkflowSourceSnapshot(snapshot, Buffer.from('source'), meta)).toBe(snapshot);
    expect(verifyWorkflowSourceManifest(snapshot, meta)).toBe(snapshot);
  });

  it('rejects a genuine snapshot for different loaded source with a typed loader error', () => {
    const bytes = Buffer.from('changed');
    const snapshot = createWorkflowSourceSnapshot(bytes, meta);
    expect(() =>
      bindWorkflowSourceIdentity(
        { meta, format: 'openslack-native', hash: hashWorkflowSource('original') },
        bytes,
        snapshot,
      ),
    ).toThrow(expect.objectContaining({ reasonCode: 'LOADER_SOURCE_MISMATCH' }));
  });

  it('hashes exact file bytes without a text decoding round trip', () => {
    const bytes = Uint8Array.from([0x66, 0x6f, 0x80, 0x6f]);

    expect(hashWorkflowSource(bytes)).not.toBe(hashWorkflowSource(Buffer.from(bytes).toString()));
  });

  it('uses all exact source bytes for ambient and file-loaded workflows', () => {
    const first = 'export const value = 1;\n';
    const second = 'export const value = 1;\r\n';
    expect(resolveWorkflowIdentityHash({ meta, sourceBody: first })).toBe(
      hashWorkflowSource(first),
    );
    expect(resolveWorkflowIdentityHash({ meta, sourceBody: first })).not.toBe(
      resolveWorkflowIdentityHash({ meta, sourceBody: second }),
    );
  });

  it('binds programmatic identities to executable source even when version is unchanged', () => {
    const first = resolveWorkflowIdentityHash({
      meta,
      run: async () => ({ status: 'completed', value: 1 }),
    });
    const second = resolveWorkflowIdentityHash({
      meta,
      run: async () => ({ status: 'completed', value: 2 }),
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).not.toBe(second);
  });

  it.each(['0123456789abcdef', 'identity-test:1.0.0', 'A'.repeat(64)])(
    'rejects weak or non-canonical supplied identity %s',
    (hash) => {
      expect(() => resolveWorkflowIdentityHash({ meta, hash })).toThrow('full lowercase SHA-256');
    },
  );

  it('rejects metadata-only programmatic workflows', () => {
    expect(() => resolveWorkflowIdentityHash({ meta })).toThrow('cannot be derived');
  });
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { projectWorkflowControlReadModel } from '../workflow-control-contract.js';
import {
  WORKFLOW_CONTROL_SHADOW_IDEMPOTENCY_PREFIX,
  WORKFLOW_CONTROL_SHADOW_RECEIPT_SCHEMA,
  WORKFLOW_CONTROL_SHADOW_ROUTE,
  prepareWorkflowControlShadowRequest,
  validateWorkflowControlShadowEnvelope,
  validateWorkflowControlShadowReceipt,
} from '../workflow-control-shadow.js';
import { acceptedReceipt, shadowEnvelope } from './workflow-control-shadow-fixtures.js';

const contractRoot = new URL('../../contracts/workflow-control-shadow/v1/', import.meta.url);

describe('Workflow Control GS7-B shadow contract', () => {
  it('uses the closed exact differential envelope and a single LF request body', () => {
    const envelope = shadowEnvelope();
    expect(Object.keys(envelope)).toEqual([
      'authority',
      'observation',
      'projection',
      'schema',
      'source',
    ]);
    expect(Object.keys(envelope.source)).toEqual(['runId', 'sourceSequence', 'workspaceId']);
    expect(envelope.projection).toEqual(projectWorkflowControlReadModel(envelope.observation));
    const request = prepareWorkflowControlShadowRequest(envelope);
    expect(request.body.endsWith('\n')).toBe(true);
    expect(request.body.endsWith('\n\n')).toBe(false);
    expect(request.idempotencyKey).toBe(
      `${WORKFLOW_CONTROL_SHADOW_IDEMPOTENCY_PREFIX}${createHash('sha256').update(request.body).digest('hex')}`,
    );
    expect(request.requestFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(WORKFLOW_CONTROL_SHADOW_ROUTE).toBe('/v1/shadow/workflow-control/observations');
  });

  it('rejects source, projection, unknown-field, and receipt binding drift', () => {
    const envelope = shadowEnvelope();
    expect(() =>
      validateWorkflowControlShadowEnvelope({
        ...envelope,
        source: { ...envelope.source, runId: 'run-other' },
      }),
    ).toThrow(/binding/u);
    expect(() =>
      validateWorkflowControlShadowEnvelope({
        ...envelope,
        projection: { ...envelope.projection, terminal: true },
      }),
    ).toThrow(/projection/u);
    expect(() => validateWorkflowControlShadowEnvelope({ ...envelope, token: 'secret' })).toThrow();
    expect(() =>
      validateWorkflowControlShadowReceipt(
        { ...acceptedReceipt(), observationDigest: 'f'.repeat(64) },
        envelope,
      ),
    ).toThrow(/bind/u);
  });

  it('keeps reconciliation receipts uncommitted and excludes observationHash', () => {
    const envelope = shadowEnvelope();
    const request = prepareWorkflowControlShadowRequest(envelope);
    const receipt = {
      schema: WORKFLOW_CONTROL_SHADOW_RECEIPT_SCHEMA,
      operation: 'observation_ingest',
      status: 'reconciliation_required',
      parity: 'unknown',
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: request.requestFingerprint,
      workspaceId: envelope.source.workspaceId,
      runId: envelope.source.runId,
      sourceSequence: envelope.source.sourceSequence,
      observationDigest: createHash('sha256').update(request.body).digest('hex'),
      reconciliationToken: 'reconcile-opaque',
    };
    expect(validateWorkflowControlShadowReceipt(receipt, envelope)).toEqual(receipt);
    expect(() =>
      validateWorkflowControlShadowReceipt(
        { ...receipt, observationHash: envelope.projection.observationHash },
        envelope,
      ),
    ).toThrow(/inconsistent/u);
  });

  it('locks every generated authority artifact by exact byte length and SHA-256', () => {
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', contractRoot), 'utf8')) as {
      artifacts: Record<string, { path: string; byteLength: number; sha256: string }>;
      authorityBoundary: Record<string, unknown>;
      deferred: Record<string, unknown>;
      failureBoundary: Record<string, unknown>;
    };
    expect(manifest.authorityBoundary).toMatchObject({
      writer: '@openslack/workflows',
      typescriptRemainsSoleWriter: true,
      goRole: 'credential-free-shadow-observer-only',
      shadowDefault: 'disabled',
    });
    expect(manifest.failureBoundary).toMatchObject({
      shadowRelativeToAuthority: 'fail-open',
      legacyManifestHash: 'diagnostic-and-skip-never-pad-or-fabricate',
    });
    expect(manifest.deferred).toHaveProperty('gs8');
    expect(manifest.deferred).toHaveProperty('gs9');
    for (const artifact of Object.values(manifest.artifacts)) {
      const bytes = readFileSync(new URL(artifact.path, contractRoot));
      expect(bytes.byteLength).toBe(artifact.byteLength);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
    }
  });
});

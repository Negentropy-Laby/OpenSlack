import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  GOVERNANCE_SHADOW_CONFIRMATION_OUTCOMES,
  GOVERNANCE_SHADOW_AUDIT_EVENT_TYPES,
  GOVERNANCE_SHADOW_OBSERVATION_KINDS,
  GOVERNANCE_SHADOW_POLICY,
  prepareGovernanceShadowRequest,
  validateGovernanceShadowEnvelope,
  type GovernanceShadowEnvelope,
} from '../governed-plan-shadow.js';
import { GOVERNED_PLAN_AUDIT_EVENT_TYPES } from '../governed-plan-service.js';

const contractRoot = new URL('../../contracts/governed-plan-shadow/v1/', import.meta.url);

function bytes(relativePath: string): Buffer {
  return readFileSync(new URL(relativePath, contractRoot));
}

function json(relativePath: string): Record<string, unknown> {
  return JSON.parse(bytes(relativePath).toString('utf8')) as Record<string, unknown>;
}

describe('governance shadow GS5 contract freeze', () => {
  it('keeps the generated manifest aligned with exported policy constants', () => {
    const manifest = json('manifest.json') as {
      authority: string;
      authorityBoundary: Record<string, unknown>;
      observationKinds: unknown;
      confirmationOutcomes: unknown;
      limits: unknown;
      artifacts: Record<string, { path: string; byteLength: number; sha256: string }>;
    };

    expect(manifest.authority).toBe('typescript');
    expect(manifest.authorityBoundary).toMatchObject({
      writer: '@openslack/operator',
      goRole: 'credential-free-observer-only',
      typescriptRemainsAuthoritative: true,
      shadowDefault: 'disabled',
      journalIndependentFromGovernedPlanStore: true,
    });
    expect(manifest.observationKinds).toEqual(GOVERNANCE_SHADOW_OBSERVATION_KINDS);
    expect(manifest.confirmationOutcomes).toEqual(GOVERNANCE_SHADOW_CONFIRMATION_OUTCOMES);
    expect(GOVERNANCE_SHADOW_AUDIT_EVENT_TYPES).toEqual(GOVERNED_PLAN_AUDIT_EVENT_TYPES);
    expect(manifest.limits).toEqual(
      Object.fromEntries(
        Object.entries(GOVERNANCE_SHADOW_POLICY).filter(
          ([key]) => key !== 'maxDiagnosticMessageBytes',
        ),
      ),
    );
    for (const artifact of Object.values(manifest.artifacts)) {
      const value = bytes(artifact.path);
      expect(value.byteLength).toBe(artifact.byteLength);
      expect(createHash('sha256').update(value).digest('hex')).toBe(artifact.sha256);
    }
  });

  it('compiles the closed receipt schema and rejects unknown receipt fields', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validate = ajv.compile(json('schemas/governance-shadow-receipt.v1.schema.json'));
    const receipt = {
      schema: 'openslack.governance_shadow_receipt.v1',
      operation: 'observation_ingest',
      status: 'accepted',
      parity: 'matched',
      idempotencyKey: `openslack.governance-shadow.v1.${'a'.repeat(64)}`,
      requestFingerprint: `sha256:${'b'.repeat(64)}`,
      workspaceId: 'workspace.demo',
      planId: 'GPLAN-123e4567-e89b-42d3-a456-426614174000',
      sourceSequence: 1,
      observationKind: 'record',
      observationDigest: 'c'.repeat(64),
      committedAt: '2026-08-02T00:00:00.000000000Z',
    };
    expect(validate(receipt), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...receipt, rawConfirmationToken: 'forbidden' })).toBe(false);
  });

  it('compiles the closed observation schema against the governed-plan authority schemas', () => {
    const governedRoot = new URL('../../contracts/governed-plan/v1/', import.meta.url);
    const governedJson = (relativePath: string): object =>
      JSON.parse(readFileSync(new URL(relativePath, governedRoot), 'utf8')) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addSchema(governedJson('schemas/governed-action-plan.v1.schema.json'));
    ajv.addSchema(governedJson('schemas/governed-plan.v1.schema.json'));
    ajv.addSchema(governedJson('schemas/governed-plan-audit.v1.schema.json'));
    const validate = ajv.compile(json('schemas/governance-shadow-observation.v1.schema.json'));
    const vectors = json('golden-vectors.json') as { vectors: readonly { envelope: unknown }[] };
    expect(validate(vectors.vectors[0]?.envelope), JSON.stringify(validate.errors)).toBe(true);
    const envelope = vectors.vectors[0]?.envelope as Record<string, unknown>;
    expect(validate({ ...envelope, rawConfirmationToken: 'forbidden' })).toBe(false);
  });

  it('reproduces exact canonical bytes, idempotency, and request fingerprint vectors', () => {
    const vectors = json('golden-vectors.json') as unknown as {
      vectors: readonly {
        envelope: GovernanceShadowEnvelope;
        expected: ReturnType<typeof prepareGovernanceShadowRequest>;
      }[];
    };
    for (const vector of vectors.vectors) {
      const envelope = validateGovernanceShadowEnvelope(vector.envelope);
      expect(prepareGovernanceShadowRequest(envelope)).toEqual(vector.expected);
      expect(vector.expected.body).not.toContain('confirmationToken');
    }
  });

  it('rejects audit values outside the closed authority sets before journaling', () => {
    const event = {
      schema: 'openslack.governed_plan_audit.v1',
      eventId: 'GAUDIT-123e4567-e89b-42d3-a456-426614174002',
      type: 'plan.previewed',
      occurredAt: '2026-08-02T00:00:00.000Z',
      planId: 'GPLAN-123e4567-e89b-42d3-a456-426614174000',
      kind: 'scenario.instantiate',
      actorId: 'agent.demo',
      workspaceId: 'workspace.demo',
      correlationId: 'CORR-123e4567-e89b-42d3-a456-426614174003',
      state: 'pending',
      revision: 1,
      evidenceRefs: ['audit:event:001'],
    };
    const envelope = {
      schema: 'openslack.governance_shadow_observation.v1',
      authority: 'typescript',
      source: {
        workspaceId: event.workspaceId,
        planId: event.planId,
        sourceSequence: 1,
      },
      observation: {
        kind: 'audit',
        recordRevision: 1,
        recordHash: 'a'.repeat(64),
        event,
      },
    };
    expect(() => validateGovernanceShadowEnvelope(envelope)).not.toThrow();
    expect(() =>
      validateGovernanceShadowEnvelope({
        ...envelope,
        observation: { ...envelope.observation, event: { ...event, type: 'plan.unclosed' } },
      }),
    ).toThrow('outside the closed contract');
    expect(() =>
      validateGovernanceShadowEnvelope({
        ...envelope,
        observation: { ...envelope.observation, event: { ...event, evidenceRefs: [''] } },
      }),
    ).toThrow('outside the closed contract');
  });

  it('binds currentBindings presence to the confirmation authority outcome', () => {
    const vectors = json('golden-vectors.json') as unknown as {
      vectors: readonly { envelope: GovernanceShadowEnvelope }[];
    };
    const envelope = vectors.vectors[0]!.envelope;
    const confirmation = envelope.observation as unknown as Record<string, unknown>;
    const withoutBindings = Object.fromEntries(
      Object.entries(confirmation).filter(([key]) => key !== 'currentBindings'),
    );
    expect(() =>
      validateGovernanceShadowEnvelope({ ...envelope, observation: withoutBindings }),
    ).toThrow('currentBindings');
    expect(() =>
      validateGovernanceShadowEnvelope({
        ...envelope,
        observation: { ...confirmation, authorityOutcome: 'confirmation_rejected' },
      }),
    ).toThrow('currentBindings');
  });
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NEGENTROPY_SCHEMA_PIN,
  bundledNegentropySchemaBytes,
  diagnoseNegentropyIntegration,
  exportNegentropySlotPreview,
  loadNegentropyIntegrationConfig,
  negentropyConfigPath,
  negentropyReceiptPath,
  negentropySignaturePath,
  verifyNegentropySchemaPin,
  type NegentropySignatureEnvelope,
  type NegentropySlotContributionArtifactV1,
  type NegentropySlotPreview,
} from '../index.js';

const roots: string[] = [];
const NOW = new Date('2026-07-17T12:00:00.000Z');
const SIGNATURE_VALUE = 'A'.repeat(88);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-negentropy-'));
  roots.push(root);
  writeFileSync(join(root, 'openslack.yaml'), 'schema: openslack.workspace.v1\n', 'utf8');
  return root;
}

async function preview(root: string): Promise<NegentropySlotPreview> {
  return exportNegentropySlotPreview({
    workspaceRoot: root,
    now: () => NOW,
  });
}

function signature(value: NegentropySlotPreview): NegentropySignatureEnvelope {
  return {
    schema: 'openslack.negentropy.signature.v1',
    artifactHash: value.artifactHash,
    algorithm: 'ed25519',
    keyId: 'negentropy:test',
    value: SIGNATURE_VALUE,
  };
}

function signedContribution(
  value: NegentropySlotPreview,
  envelope: NegentropySignatureEnvelope,
): NegentropySlotContributionArtifactV1 {
  return {
    ...value.contribution,
    manifest: {
      ...value.contribution.manifest,
      signature: {
        algorithm: envelope.algorithm,
        keyId: envelope.keyId,
        value: envelope.value,
      },
    },
  };
}

function diagnostics(state = 'installed') {
  return {
    contributionId: 'external.openslack.scenario-pack',
    slotId: 'scenario-pack.extension',
    providerId: 'openslack',
    state,
    health: 'healthy',
    lastUpdatedAt: 1,
    gateMode: 'SHADOW',
    sealed: false,
    alerts: [],
    recommendedActions: [],
  };
}

function writeConfig(root: string, endpoint = 'http://127.0.0.1:4311/api/authority'): void {
  const path = negentropyConfigPath(root);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    `endpoint: ${endpoint}\nkeyId: negentropy:test\nmaxEvidenceAgeHours: 168\n`,
    'utf8',
  );
}

function writeSignature(root: string, value: NegentropySignatureEnvelope): void {
  writeFileSync(negentropySignaturePath(root), `${JSON.stringify(value)}\n`, 'utf8');
}

function writeReceipt(
  root: string,
  contribution: NegentropySlotContributionArtifactV1,
  state = 'installed',
): void {
  writeFileSync(
    negentropyReceiptPath(root),
    `${JSON.stringify({
      ok: true,
      contribution,
      diagnostics: diagnostics(state),
      slotAdmission: {
        receiptId: 'slot-admission:external.openslack.scenario-pack:1:test',
        slotId: 'scenario-pack.extension',
        contributionId: 'external.openslack.scenario-pack',
        providerKind: 'external',
        mode: 'ENFORCE',
        decision: 'allowed',
        reasons: [],
        diagnostics: [],
        lifecycleState: 'completed',
        admittedAt: 1,
        completedAt: 2,
      },
    })}\n`,
    'utf8',
  );
}

describe('Negentropy slot preview', () => {
  it('pins the exact upstream schema and emits a schema-valid projection-only artifact', async () => {
    const root = workspace();
    const value = await preview(root);
    const schema = JSON.parse(bundledNegentropySchemaBytes().toString('utf8')) as object;
    const validate = new Ajv2020({ strict: false }).compile(schema);

    expect(() => verifyNegentropySchemaPin()).not.toThrow();
    expect(NEGENTROPY_SCHEMA_PIN.commit).toMatch(/^[a-f0-9]{40}$/u);
    expect(validate(value.contribution), JSON.stringify(validate.errors)).toBe(true);
    expect(value.readiness).toBe('NOT_REGISTERABLE');
    expect(value.contribution.manifest).toMatchObject({
      providerKind: 'external',
      layer: 'L5',
      kind: 'scenario-pack',
      gate: { mode: 'SHADOW', activationMode: 'opt-in' },
      metadata: { projectionOnly: true },
    });
    expect(value.contribution).not.toHaveProperty('routes');
    expect(value.contribution).not.toHaveProperty('realtimeRooms');
    expect(value.contribution).not.toHaveProperty('lifecycle');
    expect(value.contribution.manifest.permission).not.toHaveProperty('authorityWriterHandle');
    expect(value.contribution.manifest.permission.forbiddenApiMethods).toEqual([
      'authorityWriterHandle',
      'proposeMutation',
    ]);
  });

  it('fails closed when the bundled schema bytes do not match the pin', async () => {
    await expect(
      exportNegentropySlotPreview({
        workspaceRoot: workspace(),
        schemaBytes: Buffer.from('{}'),
        write: false,
      }),
    ).rejects.toThrow(/schema hash mismatch/);
  });

  it('exports bounded counts and policy facts without collaboration prose', async () => {
    const root = workspace();
    const eventsDir = join(root, '.openslack.local', 'collaboration');
    mkdirSync(eventsDir, { recursive: true });
    writeFileSync(
      join(eventsDir, 'events.jsonl'),
      `${JSON.stringify({
        schema: 'openslack.collaboration_event.v1',
        id: 'EV-1',
        timestamp: NOW.toISOString(),
        type: 'pr.doctor.ready',
        actor: { id: 'sensitive-actor', kind: 'agent' },
        object: { kind: 'pr', id: '1' },
        source: { kind: 'prms', ref: 'sensitive-ref' },
        summary: 'sensitive prose must not be projected',
        visibility: 'local',
        redacted: false,
        containsSensitiveData: false,
      })}\n`,
      'utf8',
    );
    const value = await preview(root);
    const serialized = JSON.stringify(value.contribution.metadata.evidence);
    expect(value.contribution.metadata.evidence.prms.totalEvents).toBe(1);
    expect(serialized).not.toContain('sensitive prose');
    expect(serialized).not.toContain('sensitive-actor');
    expect(serialized).not.toContain('sensitive-ref');
  });
});

describe('Negentropy doctor state machine', () => {
  it('reports unsigned preview without claiming lifecycle', async () => {
    const root = workspace();
    await preview(root);
    const report = await diagnoseNegentropyIntegration({
      workspaceRoot: root,
      now: () => NOW,
    });
    expect(report.state).toBe('UNSIGNED_PREVIEW');
    expect(report).not.toHaveProperty('negentropyLifecycle');
  });

  it('reports attached but unverified for a structurally bound signature', async () => {
    const root = workspace();
    const value = await preview(root);
    writeSignature(root, signature(value));
    const report = await diagnoseNegentropyIntegration({
      workspaceRoot: root,
      now: () => NOW,
    });
    expect(report.state).toBe('SIGNATURE_ATTACHED_UNVERIFIED');
    expect(report).not.toHaveProperty('receiptId');
    expect(report).not.toHaveProperty('negentropyLifecycle');
  });

  it('does not trust a forged local receipt without live endpoint agreement', async () => {
    const root = workspace();
    const value = await preview(root);
    const envelope = signature(value);
    const contribution = signedContribution(value, envelope);
    writeSignature(root, envelope);
    writeReceipt(root, contribution);
    writeConfig(root);
    const report = await diagnoseNegentropyIntegration({
      workspaceRoot: root,
      now: () => NOW,
      allowLoopbackHttp: true,
      fetchFn: async () => new Response('{}', { status: 500 }),
    });
    expect(report.state).toBe('SIGNATURE_ATTACHED_UNVERIFIED');
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'NEGENTROPY_ENDPOINT_VERIFIED', status: 'FAIL' }),
    );
  });

  it('reports verified only when receipt, live contribution, and diagnostics all match', async () => {
    const root = workspace();
    const value = await preview(root);
    const envelope = signature(value);
    const contribution = signedContribution(value, envelope);
    writeSignature(root, envelope);
    writeReceipt(root, contribution);
    writeConfig(root);
    const requested: Array<{ url: string; authorization: string | null }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      const url = String(input);
      requested.push({ url, authorization: headers.get('authorization') });
      if (url.endsWith('/diagnostics')) {
        return Response.json({ ok: true, diagnostics: diagnostics('installed') });
      }
      return Response.json({
        ok: true,
        contributions: [contribution],
        diagnostics: [diagnostics('installed')],
      });
    };
    const report = await diagnoseNegentropyIntegration({
      workspaceRoot: root,
      now: () => NOW,
      allowLoopbackHttp: true,
      fetchFn,
    });
    expect(report.state).toBe('VERIFIED_BY_NEGENTROPY');
    expect(report.receiptId).toMatch(/^slot-admission:/u);
    expect(report.negentropyLifecycle).toBe('installed');
    expect(requested).toHaveLength(2);
    expect(requested.every((request) => request.authorization === null)).toBe(true);
  });

  it('rejects a live endpoint whose lifecycle disagrees with the receipt', async () => {
    const root = workspace();
    const value = await preview(root);
    const envelope = signature(value);
    const contribution = signedContribution(value, envelope);
    writeSignature(root, envelope);
    writeReceipt(root, contribution, 'installed');
    writeConfig(root);
    const fetchFn: typeof fetch = async (input) =>
      String(input).endsWith('/diagnostics')
        ? Response.json({ ok: true, diagnostics: diagnostics('activated') })
        : Response.json({ ok: true, contributions: [contribution], diagnostics: [] });
    const report = await diagnoseNegentropyIntegration({
      workspaceRoot: root,
      now: () => NOW,
      allowLoopbackHttp: true,
      fetchFn,
    });
    expect(report.state).toBe('SIGNATURE_ATTACHED_UNVERIFIED');
    expect(report).not.toHaveProperty('negentropyLifecycle');
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'NEGENTROPY_ENDPOINT_VERIFIED', status: 'FAIL' }),
    );
  });

  it('fails freshness and never verifies stale evidence', async () => {
    const root = workspace();
    const value = await preview(root);
    writeSignature(root, signature(value));
    const report = await diagnoseNegentropyIntegration({
      workspaceRoot: root,
      now: () => new Date('2026-07-25T12:00:00.000Z'),
    });
    expect(report.state).toBe('SIGNATURE_ATTACHED_UNVERIFIED');
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'NEGENTROPY_EVIDENCE_FRESH', status: 'FAIL' }),
    );
  });

  it('allows loopback HTTP only through the explicit test seam', () => {
    const root = workspace();
    writeConfig(root);
    expect(() => loadNegentropyIntegrationConfig({ workspaceRoot: root })).toThrow(/HTTPS/);
    expect(
      loadNegentropyIntegrationConfig({ workspaceRoot: root, allowLoopbackHttp: true }).endpoint,
    ).toBe('http://127.0.0.1:4311/api/authority');
  });
});

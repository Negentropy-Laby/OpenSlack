import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { contributionArtifactHash } from './canonical.js';
import { loadNegentropyIntegrationConfig } from './config.js';
import {
  negentropyPreviewPath,
  negentropyReceiptPath,
  negentropySignaturePath,
} from './preview.js';
import { NEGENTROPY_SCHEMA_PIN, verifyNegentropySchemaPin } from './schema-pin.js';
import type {
  NegentropyDoctorFinding,
  NegentropyIntegrationReport,
  NegentropySignatureEnvelope,
  NegentropySlotContributionArtifactV1,
  NegentropySlotPreview,
} from './types.js';

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export interface DiagnoseNegentropyIntegrationOptions {
  readonly workspaceRoot: string;
  readonly now?: () => Date;
  readonly schemaBytes?: Buffer;
  readonly fetchFn?: typeof fetch;
  readonly allowLoopbackHttp?: boolean;
}

export async function diagnoseNegentropyIntegration(
  options: DiagnoseNegentropyIntegrationOptions,
): Promise<NegentropyIntegrationReport> {
  const findings: NegentropyDoctorFinding[] = [];
  let schemaValid = false;
  try {
    verifyNegentropySchemaPin(options.schemaBytes);
    schemaValid = true;
    findings.push(finding('NEGENTROPY_SCHEMA_PIN_VALID', 'PASS', 'Pinned schema hash is valid.'));
  } catch {
    findings.push(
      finding('NEGENTROPY_SCHEMA_PIN_VALID', 'FAIL', 'Pinned schema hash validation failed.'),
    );
  }

  let preview: NegentropySlotPreview | undefined;
  try {
    preview = parsePreview(
      readBoundedJson(
        options.workspaceRoot,
        negentropyPreviewPath(options.workspaceRoot),
        MAX_PREVIEW_BYTES,
      ),
    );
    if (
      preview.schemaPin.commit !== NEGENTROPY_SCHEMA_PIN.commit ||
      preview.schemaPin.sha256 !== NEGENTROPY_SCHEMA_PIN.sha256 ||
      preview.artifactHash !== contributionArtifactHash(preview.contribution)
    ) {
      throw new Error('Preview identity mismatch.');
    }
    findings.push(
      finding('NEGENTROPY_PREVIEW_PRESENT', 'PASS', 'Saved unsigned preview is canonical.'),
    );
  } catch {
    findings.push(
      finding('NEGENTROPY_PREVIEW_PRESENT', 'FAIL', 'Canonical unsigned preview is unavailable.'),
    );
  }

  let config: ReturnType<typeof loadNegentropyIntegrationConfig> = {
    maxEvidenceAgeHours: 168,
  };
  let configError = false;
  try {
    config = loadNegentropyIntegrationConfig({
      workspaceRoot: options.workspaceRoot,
      allowLoopbackHttp: options.allowLoopbackHttp,
    });
  } catch {
    configError = true;
  }

  let fresh = false;
  if (preview) {
    const generatedAt = Date.parse(preview.generatedAt);
    const ageMs = (options.now ?? (() => new Date()))().getTime() - generatedAt;
    fresh =
      Number.isFinite(generatedAt) &&
      ageMs >= 0 &&
      ageMs <= config.maxEvidenceAgeHours * 60 * 60 * 1000;
    findings.push(
      finding(
        'NEGENTROPY_EVIDENCE_FRESH',
        fresh ? 'PASS' : 'FAIL',
        fresh ? 'Preview evidence is fresh.' : 'Preview evidence is stale or future-dated.',
      ),
    );
  } else {
    findings.push(
      finding('NEGENTROPY_EVIDENCE_FRESH', 'SKIP', 'No canonical preview to assess.'),
    );
  }

  const signatureAttached = existsSync(negentropySignaturePath(options.workspaceRoot));
  let signature: NegentropySignatureEnvelope | undefined;
  if (signatureAttached && preview) {
    try {
      signature = parseSignature(
        readBoundedJson(
          options.workspaceRoot,
          negentropySignaturePath(options.workspaceRoot),
          MAX_SIGNATURE_BYTES,
        ),
      );
      if (
        signature.artifactHash !== preview.artifactHash ||
        (config.keyId !== undefined && signature.keyId !== config.keyId)
      ) {
        throw new Error('Signature binding mismatch.');
      }
      findings.push(
        finding(
          'NEGENTROPY_SIGNATURE_ATTACHED',
          'PASS',
          'Signature structure and artifact binding are valid but cryptographically unverified.',
        ),
      );
    } catch {
      findings.push(
        finding(
          'NEGENTROPY_SIGNATURE_ATTACHED',
          'FAIL',
          'Attached signature structure or artifact binding is invalid.',
        ),
      );
    }
  } else {
    findings.push(
      finding(
        'NEGENTROPY_SIGNATURE_ATTACHED',
        'SKIP',
        signatureAttached
          ? 'Signature cannot be assessed without a canonical preview.'
          : 'No external signature is attached.',
      ),
    );
  }

  let receipt: TrustedReceipt | undefined;
  if (signature && preview && existsSync(negentropyReceiptPath(options.workspaceRoot))) {
    try {
      receipt = parseTrustedReceipt(
        readBoundedJson(
          options.workspaceRoot,
          negentropyReceiptPath(options.workspaceRoot),
          MAX_RECEIPT_BYTES,
        ),
        preview,
        signature,
      );
      findings.push(
        finding('NEGENTROPY_RECEIPT_TRUSTED', 'PASS', 'Saved registration receipt is coherent.'),
      );
    } catch {
      findings.push(
        finding('NEGENTROPY_RECEIPT_TRUSTED', 'FAIL', 'Saved registration receipt is not trusted.'),
      );
    }
  } else {
    findings.push(
      finding(
        'NEGENTROPY_RECEIPT_TRUSTED',
        'SKIP',
        'A valid signature and saved registration response are required.',
      ),
    );
  }

  let lifecycle: string | undefined;
  let endpointVerified = false;
  if (schemaValid && fresh && signature && preview && receipt && config.endpoint && !configError) {
    try {
      lifecycle = await verifyLiveEndpoint(
        config.endpoint,
        preview,
        signature,
        receipt,
        options.fetchFn ?? fetch,
      );
      endpointVerified = true;
      findings.push(
        finding(
          'NEGENTROPY_ENDPOINT_VERIFIED',
          'PASS',
          'Live Negentropy contribution and diagnostics match the receipt.',
        ),
      );
    } catch {
      findings.push(
        finding(
          'NEGENTROPY_ENDPOINT_VERIFIED',
          'FAIL',
          'Live Negentropy contribution or diagnostics verification failed.',
        ),
      );
    }
  } else {
    findings.push(
      finding(
        'NEGENTROPY_ENDPOINT_VERIFIED',
        configError ? 'FAIL' : 'SKIP',
        configError
          ? 'Negentropy endpoint configuration is invalid.'
          : 'Endpoint verification prerequisites are incomplete.',
      ),
    );
  }

  const state = endpointVerified
    ? 'VERIFIED_BY_NEGENTROPY'
    : signatureAttached
      ? 'SIGNATURE_ATTACHED_UNVERIFIED'
      : 'UNSIGNED_PREVIEW';
  return {
    schema: 'openslack.negentropy.integration_report.v1',
    state,
    ...(preview === undefined ? {} : { artifactHash: preview.artifactHash }),
    ...(endpointVerified && receipt ? { receiptId: receipt.receiptId } : {}),
    ...(endpointVerified && lifecycle ? { negentropyLifecycle: lifecycle } : {}),
    findings,
  };
}

interface TrustedReceipt {
  readonly receiptId: string;
  readonly contributionHash: string;
  readonly lifecycle: string;
}

function parsePreview(value: unknown): NegentropySlotPreview {
  const record = exactRecord(value, [
    'schema',
    'schemaPin',
    'generatedAt',
    'readiness',
    'artifactHash',
    'contribution',
  ]);
  if (
    record.schema !== 'openslack.negentropy.slot-preview.v1' ||
    record.readiness !== 'NOT_REGISTERABLE' ||
    typeof record.generatedAt !== 'string' ||
    typeof record.artifactHash !== 'string' ||
    !SHA256.test(record.artifactHash)
  ) {
    throw new Error('Invalid preview.');
  }
  const pin = exactRecord(record.schemaPin, ['repository', 'commit', 'path', 'sha256', 'version']);
  if (
    pin.repository !== NEGENTROPY_SCHEMA_PIN.repository ||
    pin.path !== NEGENTROPY_SCHEMA_PIN.path ||
    pin.version !== NEGENTROPY_SCHEMA_PIN.version ||
    typeof pin.commit !== 'string' ||
    typeof pin.sha256 !== 'string'
  ) {
    throw new Error('Invalid schema pin.');
  }
  return record as unknown as NegentropySlotPreview;
}

function parseSignature(value: unknown): NegentropySignatureEnvelope {
  const record = exactRecord(value, ['schema', 'artifactHash', 'algorithm', 'keyId', 'value']);
  if (
    record.schema !== 'openslack.negentropy.signature.v1' ||
    record.algorithm !== 'ed25519' ||
    typeof record.artifactHash !== 'string' ||
    !SHA256.test(record.artifactHash) ||
    typeof record.keyId !== 'string' ||
    !record.keyId.trim() ||
    record.keyId.length > 256 ||
    typeof record.value !== 'string' ||
    record.value.length < 40 ||
    record.value.length > 4096 ||
    !BASE64.test(record.value)
  ) {
    throw new Error('Invalid signature envelope.');
  }
  return record as unknown as NegentropySignatureEnvelope;
}

function parseTrustedReceipt(
  value: unknown,
  preview: NegentropySlotPreview,
  signature: NegentropySignatureEnvelope,
): TrustedReceipt {
  const response = record(value);
  if (response.ok !== true) throw new Error('Registration failed.');
  const admission = record(response.slotAdmission);
  const contribution = response.contribution as NegentropySlotContributionArtifactV1;
  const diagnostics = record(response.diagnostics);
  if (
    typeof admission.receiptId !== 'string' ||
    !admission.receiptId.trim() ||
    admission.lifecycleState !== 'completed' ||
    admission.contributionId !== preview.contribution.manifest.contributionId ||
    admission.slotId !== preview.contribution.manifest.slotId ||
    admission.providerKind !== 'external' ||
    (admission.decision !== 'allowed' && admission.decision !== 'degraded')
  ) {
    throw new Error('Admission receipt mismatch.');
  }
  assertContributionIdentity(contribution, preview, signature);
  assertDiagnosticsIdentity(diagnostics, preview);
  return {
    receiptId: admission.receiptId,
    contributionHash: contributionArtifactHash(contribution),
    lifecycle: String(diagnostics.state),
  };
}

async function verifyLiveEndpoint(
  endpoint: string,
  preview: NegentropySlotPreview,
  signature: NegentropySignatureEnvelope,
  receipt: TrustedReceipt,
  fetchFn: typeof fetch,
): Promise<string> {
  const list = record(await fetchJson(`${endpoint}/slot-contributions`, fetchFn));
  if (list.ok !== true || !Array.isArray(list.contributions)) throw new Error('Invalid list.');
  const contribution = list.contributions.find((candidate) => {
    const manifest = recordOrUndefined(recordOrUndefined(candidate)?.manifest);
    return manifest?.contributionId === preview.contribution.manifest.contributionId;
  }) as NegentropySlotContributionArtifactV1 | undefined;
  if (!contribution) throw new Error('Contribution missing.');
  assertContributionIdentity(contribution, preview, signature);
  if (
    contributionArtifactHash(contribution) !== receipt.contributionHash ||
    contributionArtifactHash(contribution) !== preview.artifactHash
  ) {
    throw new Error('Live contribution hash mismatch.');
  }
  const diagnosticsResponse = record(
    await fetchJson(
      `${endpoint}/slot-contributions/${encodeURIComponent(
        preview.contribution.manifest.contributionId,
      )}/diagnostics`,
      fetchFn,
    ),
  );
  if (diagnosticsResponse.ok !== true) throw new Error('Diagnostics failed.');
  const diagnostics = record(diagnosticsResponse.diagnostics);
  assertDiagnosticsIdentity(diagnostics, preview);
  if (diagnostics.state !== receipt.lifecycle) throw new Error('Lifecycle mismatch.');
  return String(diagnostics.state);
}

function assertContributionIdentity(
  contribution: NegentropySlotContributionArtifactV1,
  preview: NegentropySlotPreview,
  signature: NegentropySignatureEnvelope,
): void {
  const manifest = record(contribution?.manifest);
  const attached = record(manifest.signature);
  if (
    manifest.contributionId !== preview.contribution.manifest.contributionId ||
    manifest.slotId !== 'scenario-pack.extension' ||
    manifest.providerKind !== 'external' ||
    manifest.providerId !== 'openslack' ||
    manifest.layer !== 'L5' ||
    manifest.kind !== 'scenario-pack' ||
    record(manifest.gate).mode !== 'SHADOW' ||
    record(manifest.gate).activationMode !== 'opt-in' ||
    attached.algorithm !== signature.algorithm ||
    attached.keyId !== signature.keyId ||
    attached.value !== signature.value ||
    contributionArtifactHash(contribution) !== preview.artifactHash
  ) {
    throw new Error('Contribution identity mismatch.');
  }
  if (
    Object.hasOwn(contribution, 'routes') ||
    Object.hasOwn(contribution, 'realtimeRooms') ||
    Object.hasOwn(contribution, 'lifecycle')
  ) {
    throw new Error('Contribution exceeds projection-only scope.');
  }
  const permission = record(manifest.permission);
  const forbidden = new Set(Array.isArray(permission.forbiddenApiMethods) ? permission.forbiddenApiMethods : []);
  if (
    Object.hasOwn(permission, 'authorityWriterHandle') ||
    !forbidden.has('authorityWriterHandle') ||
    !forbidden.has('proposeMutation')
  ) {
    throw new Error('Contribution permission mismatch.');
  }
}

function assertDiagnosticsIdentity(
  diagnostics: Record<string, unknown>,
  preview: NegentropySlotPreview,
): void {
  if (
    diagnostics.contributionId !== preview.contribution.manifest.contributionId ||
    diagnostics.slotId !== preview.contribution.manifest.slotId ||
    diagnostics.providerId !== preview.contribution.manifest.providerId ||
    typeof diagnostics.state !== 'string' ||
    !diagnostics.state
  ) {
    throw new Error('Diagnostics identity mismatch.');
  }
}

async function fetchJson(url: string, fetchFn: typeof fetch): Promise<unknown> {
  const response = await fetchFn(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  const declared = response.headers.get('content-length');
  if (
    !response.ok ||
    (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES))
  ) {
    throw new Error('Negentropy response rejected.');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES) throw new Error('Negentropy response is too large.');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

function readBoundedJson(root: string, path: string, maximum: number): unknown {
  assertContained(root, path);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) {
    throw new Error('Negentropy artifact must be a bounded regular file.');
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path))) as unknown;
}

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const valueRecord = record(value);
  const allowed = new Set(fields);
  for (const key of Object.keys(valueRecord)) {
    if (!allowed.has(key)) throw new Error(`Unexpected field ${key}.`);
  }
  return valueRecord;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object.');
  }
  return value as Record<string, unknown>;
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assertContained(root: string, target: string): void {
  const relation = relative(resolve(root), resolve(target));
  if (relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..')) return;
  throw new Error('Negentropy integration artifact escapes the workspace.');
}

function finding(
  code: NegentropyDoctorFinding['code'],
  status: NegentropyDoctorFinding['status'],
  detail: string,
): NegentropyDoctorFinding {
  return { code, status, detail };
}

export function renderNegentropyIntegrationReport(report: NegentropyIntegrationReport): string {
  const lines = [`Negentropy integration: ${report.state}`];
  if (report.artifactHash) lines.push(`Artifact: ${report.artifactHash}`);
  if (report.receiptId) lines.push(`Receipt: ${report.receiptId}`);
  if (report.negentropyLifecycle) {
    lines.push(`Negentropy-reported lifecycle: ${report.negentropyLifecycle}`);
  }
  lines.push('');
  for (const item of report.findings) {
    lines.push(`[${item.status}] ${item.code}: ${item.detail}`);
  }
  return lines.join('\n');
}

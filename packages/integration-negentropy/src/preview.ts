import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { contributionArtifactHash } from './canonical.js';
import { collectNegentropyEvidence } from './evidence.js';
import { NEGENTROPY_SCHEMA_PIN, verifyNegentropySchemaPin } from './schema-pin.js';
import type { NegentropySlotContributionArtifactV1, NegentropySlotPreview } from './types.js';

export interface ExportNegentropySlotPreviewOptions {
  readonly workspaceRoot: string;
  readonly now?: () => Date;
  readonly schemaBytes?: Buffer;
  readonly write?: boolean;
}

export function negentropyIntegrationStateDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.openslack.local', 'integrations', 'negentropy');
}

export function negentropyPreviewPath(workspaceRoot: string): string {
  return join(negentropyIntegrationStateDir(workspaceRoot), 'slot-preview.json');
}

export function negentropySignaturePath(workspaceRoot: string): string {
  return join(negentropyIntegrationStateDir(workspaceRoot), 'signature.json');
}

export function negentropyReceiptPath(workspaceRoot: string): string {
  return join(negentropyIntegrationStateDir(workspaceRoot), 'registration-response.json');
}

export async function exportNegentropySlotPreview(
  options: ExportNegentropySlotPreviewOptions,
): Promise<NegentropySlotPreview> {
  verifyNegentropySchemaPin(options.schemaBytes);
  const evidence = await collectNegentropyEvidence(options);
  const contribution: NegentropySlotContributionArtifactV1 = {
    manifest: {
      contributionId: 'external.openslack.scenario-pack',
      slotId: 'scenario-pack.extension',
      name: 'OpenSlack collaboration evidence projection',
      version: '1.0.0',
      providerKind: 'external',
      providerId: 'openslack',
      layer: 'L5',
      kind: 'scenario-pack',
      requiredPlatformCapabilities: ['platform.projection-query'],
      permission: {
        platformCapabilities: ['platform.projection-query'],
        slotCapabilities: ['slot.catalog.read'],
        allowedApiMethods: ['getProjection'],
        forbiddenApiMethods: ['authorityWriterHandle', 'proposeMutation'],
        sealed: false,
      },
      gate: {
        mode: 'SHADOW',
        activationMode: 'opt-in',
        sealed: false,
      },
      evidenceRefs: [`openslack:evidence:${evidence.hash}`],
      metadata: {
        projectionOnly: true,
        evidenceHash: evidence.hash,
      },
    },
    metadata: {
      source: 'openslack',
      evidence,
    },
  };
  const preview: NegentropySlotPreview = {
    schema: 'openslack.negentropy.slot-preview.v1',
    schemaPin: NEGENTROPY_SCHEMA_PIN,
    generatedAt: evidence.observedAt,
    readiness: 'NOT_REGISTERABLE',
    artifactHash: contributionArtifactHash(contribution),
    contribution,
  };
  if (options.write !== false) writePreviewAtomic(options.workspaceRoot, preview);
  return preview;
}

function assertContained(root: string, target: string): void {
  const relation = relative(resolve(root), resolve(target));
  if (relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..')) return;
  throw new Error('Negentropy integration path escapes the workspace.');
}

function writePreviewAtomic(workspaceRoot: string, preview: NegentropySlotPreview): void {
  const path = negentropyPreviewPath(workspaceRoot);
  assertContained(workspaceRoot, path);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error('Negentropy preview path must not be a symlink.');
  }
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(preview, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  const handle = openSync(temporary, 'r+');
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, path);
  if (process.platform !== 'win32') {
    const dirHandle = openSync(dir, 'r');
    try {
      fsyncSync(dirHandle);
    } finally {
      closeSync(dirHandle);
    }
  }
}

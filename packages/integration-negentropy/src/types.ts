export const NEGENTROPY_INTEGRATION_STATES = Object.freeze([
  'UNSIGNED_PREVIEW',
  'SIGNATURE_ATTACHED_UNVERIFIED',
  'VERIFIED_BY_NEGENTROPY',
] as const);

export type NegentropyIntegrationState = (typeof NEGENTROPY_INTEGRATION_STATES)[number];

export interface NegentropySchemaPin {
  readonly repository: 'wsman/Negentropy-Lab';
  readonly commit: string;
  readonly path: string;
  readonly sha256: string;
  readonly version: 'negentropy.slot-contribution.v1';
}

export interface NegentropyEvidenceProjection {
  readonly schema: 'openslack.negentropy.evidence.v1';
  readonly observedAt: string;
  readonly workflow: {
    readonly totalRuns: number;
    readonly statusCounts: Readonly<Record<string, number>>;
    readonly latestUpdatedAt?: string;
  };
  readonly prms: {
    readonly totalEvents: number;
    readonly eventTypeCounts: Readonly<Record<string, number>>;
    readonly latestEventAt?: string;
    readonly policy: {
      readonly noAutoApproval: boolean;
      readonly noSelfReview: boolean;
      readonly redZoneHumanRequired: boolean;
      readonly blackZoneNeverMerge: boolean;
    };
  };
  readonly profileSync: {
    readonly state: 'synced' | 'pending' | 'failed' | 'never';
    readonly postsSynced: number;
    readonly failureCount: number;
    readonly isOutOfDate: boolean;
    readonly lastSyncDate?: string;
    readonly lastSourceSha?: string;
  };
  readonly collaboration: {
    readonly totalEvents: number;
    readonly eventTypeCounts: Readonly<Record<string, number>>;
    readonly latestEventAt?: string;
  };
  readonly hash: string;
}

export interface NegentropySlotContributionArtifactV1 {
  readonly manifest: {
    readonly contributionId: 'external.openslack.scenario-pack';
    readonly slotId: 'scenario-pack.extension';
    readonly name: string;
    readonly version: '1.0.0';
    readonly providerKind: 'external';
    readonly providerId: 'openslack';
    readonly layer: 'L5';
    readonly kind: 'scenario-pack';
    readonly requiredPlatformCapabilities: readonly ['platform.projection-query'];
    readonly permission: {
      readonly platformCapabilities: readonly ['platform.projection-query'];
      readonly slotCapabilities: readonly ['slot.catalog.read'];
      readonly allowedApiMethods: readonly ['getProjection'];
      readonly forbiddenApiMethods: readonly ['authorityWriterHandle', 'proposeMutation'];
      readonly sealed: false;
    };
    readonly gate: {
      readonly mode: 'SHADOW';
      readonly activationMode: 'opt-in';
      readonly sealed: false;
    };
    readonly evidenceRefs: readonly string[];
    readonly metadata: {
      readonly projectionOnly: true;
      readonly evidenceHash: string;
    };
    readonly signature?: {
      readonly algorithm?: string;
      readonly keyId?: string;
      readonly value: string;
    };
  };
  readonly metadata: {
    readonly source: 'openslack';
    readonly evidence: NegentropyEvidenceProjection;
  };
}

export interface NegentropySlotPreview {
  readonly schema: 'openslack.negentropy.slot-preview.v1';
  readonly schemaPin: NegentropySchemaPin;
  readonly generatedAt: string;
  readonly readiness: 'NOT_REGISTERABLE';
  readonly artifactHash: string;
  readonly contribution: NegentropySlotContributionArtifactV1;
}

export interface NegentropySignatureEnvelope {
  readonly schema: 'openslack.negentropy.signature.v1';
  readonly artifactHash: string;
  readonly algorithm: 'ed25519';
  readonly keyId: string;
  readonly value: string;
}

export type NegentropyFindingStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface NegentropyDoctorFinding {
  readonly code:
    | 'NEGENTROPY_SCHEMA_PIN_VALID'
    | 'NEGENTROPY_PREVIEW_PRESENT'
    | 'NEGENTROPY_EVIDENCE_FRESH'
    | 'NEGENTROPY_SIGNATURE_ATTACHED'
    | 'NEGENTROPY_RECEIPT_TRUSTED'
    | 'NEGENTROPY_ENDPOINT_VERIFIED';
  readonly status: NegentropyFindingStatus;
  readonly detail: string;
}

export interface NegentropyIntegrationReport {
  readonly schema: 'openslack.negentropy.integration_report.v1';
  readonly state: NegentropyIntegrationState;
  readonly artifactHash?: string;
  readonly receiptId?: string;
  readonly negentropyLifecycle?: string;
  readonly findings: readonly NegentropyDoctorFinding[];
}

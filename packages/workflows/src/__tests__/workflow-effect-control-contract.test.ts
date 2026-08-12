import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  WORKFLOW_EFFECT_CONTROL_ARTIFACT_KINDS,
  WORKFLOW_EFFECT_CONTROL_AUTHORITY_V2_GOLDEN_SHA256,
  WORKFLOW_EFFECT_CONTROL_AUTHORITY_V2_MANIFEST_SHA256,
  WORKFLOW_EFFECT_CONTROL_CHECKPOINT_GOLDEN_SHA256,
  WORKFLOW_EFFECT_CONTROL_CHECKPOINT_MANIFEST_SHA256,
  WORKFLOW_EFFECT_CONTROL_OBSERVER_OPERATIONS,
  WORKFLOW_EFFECT_CONTROL_RUNNER_V1_GOLDEN_SHA256,
  WORKFLOW_EFFECT_CONTROL_RUNNER_V1_MANIFEST_SHA256,
  deriveWorkflowEffectOccurrenceId,
  hashWorkflowEffectApprovalDecision,
  projectWorkflowEffectHumanDecision,
  validateWorkflowEffectControlArtifact,
  validateWorkflowEffectControlEnvelope,
  validateWorkflowEffectControlObservation,
} from '../workflow-effect-control-contract.js';
import {
  createPendingWorkflowEffectApproval,
  createWorkflowEffectDecisionAuthority,
  applyWorkflowEffectApprovalDecision,
  markWorkflowEffectApprovalAuditRecorded,
} from '../workflow-effect-approval.js';

const sha = (path: string) =>
  createHash('sha256')
    .update(readFileSync(resolve(path)))
    .digest('hex');

describe('Workflow effect control D1 contract', () => {
  it('freezes six TS artifacts separately from three nonauthorizing observer operations', () => {
    expect(WORKFLOW_EFFECT_CONTROL_ARTIFACT_KINDS).toEqual([
      'effect_intent',
      'effect_approval_pending',
      'effect_decision_committed',
      'effect_audit_recorded',
      'effect_execution_claim',
      'legacy_run_gate_observation',
    ]);
    expect(WORKFLOW_EFFECT_CONTROL_OBSERVER_OPERATIONS).toEqual([
      'approval_created',
      'approval_decided',
      'audit_recorded',
    ]);
  });

  it('derives occurrence identity from the run and positive ordinal', () => {
    expect(deriveWorkflowEffectOccurrenceId('run-1', 1)).toMatch(/^WFOCCURRENCE-[0-9a-f]{64}$/);
    expect(deriveWorkflowEffectOccurrenceId('run-1', 1)).not.toBe(
      deriveWorkflowEffectOccurrenceId('run-1', 2),
    );
    expect(() => deriveWorkflowEffectOccurrenceId('run-1', 0)).toThrow();
  });

  it('pins the unchanged runner v1 manifest and golden bytes', () => {
    expect(sha('packages/workflows/contracts/workflow-runner/v1/manifest.json')).toBe(
      WORKFLOW_EFFECT_CONTROL_RUNNER_V1_MANIFEST_SHA256,
    );
    expect(sha('packages/workflows/contracts/workflow-runner/v1/golden-vectors.json')).toBe(
      WORKFLOW_EFFECT_CONTROL_RUNNER_V1_GOLDEN_SHA256,
    );
    expect(sha('packages/workflows/contracts/workflow-control-authority/v2/manifest.json')).toBe(
      WORKFLOW_EFFECT_CONTROL_AUTHORITY_V2_MANIFEST_SHA256,
    );
    expect(
      sha('packages/workflows/contracts/workflow-control-authority/v2/golden-vectors.json'),
    ).toBe(WORKFLOW_EFFECT_CONTROL_AUTHORITY_V2_GOLDEN_SHA256);
    expect(sha('packages/workflows/contracts/workflow-checkpoint-shadow/v1/manifest.json')).toBe(
      WORKFLOW_EFFECT_CONTROL_CHECKPOINT_MANIFEST_SHA256,
    );
    expect(
      sha('packages/workflows/contracts/workflow-checkpoint-shadow/v1/golden-vectors.json'),
    ).toBe(WORKFLOW_EFFECT_CONTROL_CHECKPOINT_GOLDEN_SHA256);
  });

  it('keeps D1 contract code pure and separate from execution and observer implementations', () => {
    const source = readFileSync(
      resolve('packages/workflows/src/workflow-effect-control-contract.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from ['"]node:(?:fs|http|https|net|process)/u);
    expect(source).not.toMatch(
      /\b(?:decideEffect|applyEffect|claimEffect|executeEffect|effect_authorization|grantHash)\b/u,
    );
    expect(source).not.toMatch(
      /\b(?:jobId|attemptId|leaseId|fencingToken)\b.*WorkflowEffectExecutionClaimArtifact/u,
    );
    expect(WORKFLOW_EFFECT_CONTROL_ARTIFACT_KINDS).toHaveLength(6);
    expect(WORKFLOW_EFFECT_CONTROL_OBSERVER_OPERATIONS).toHaveLength(3);
  });

  it('keeps the approval decision hash stable while the exact record hash may advance', () => {
    const now = Date.now();
    const authority = createWorkflowEffectDecisionAuthority({
      workspaceId: 'workspace-1',
      humanPrincipalIds: ['human-1'],
      capabilities: ['workflow.effect.decide'],
      maxBindingTtlMs: 60_000,
    });
    const pending = createPendingWorkflowEffectApproval({
      runId: 'run-1',
      approvalId: 'approval-1',
      correlationId: 'corr-1',
      workflowId: 'workflow-1',
      workflowVersion: '1.0.0',
      workflowHash: '1'.repeat(64),
      inputHash: '2'.repeat(64),
      effectId: `workflow-effect:sha256:${'3'.repeat(64)}`,
      effectHash: '3'.repeat(64),
      requiredCapability: 'workflow.effect.decide',
      createdAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    const reasonHash = '4'.repeat(64);
    const binding = authority.issueHumanDecisionBinding({
      principalId: 'human-1',
      capability: 'workflow.effect.decide',
      runId: 'run-1',
      approvalId: 'approval-1',
      correlationId: 'corr-1',
      approvalExpiresAt: pending.expiresAt,
      decision: 'approved',
      reasonHash,
      expiresAt: new Date(now + 30_000).toISOString(),
    });
    const decided = applyWorkflowEffectApprovalDecision(
      pending,
      'approved',
      binding,
      authority,
      reasonHash,
      new Date().toISOString(),
    );
    const recorded = markWorkflowEffectApprovalAuditRecorded(
      decided,
      decided.auditProjection!.eventId,
      new Date(now + 1000).toISOString(),
    );
    const projection = projectWorkflowEffectHumanDecision({
      approval: decided,
      issuedAt: binding.issuedAt,
      expiresAt: binding.expiresAt,
    });
    expect(hashWorkflowEffectApprovalDecision(decided, projection)).toBe(
      hashWorkflowEffectApprovalDecision(recorded, projection),
    );
  });

  it('rejects any observer authority or implicit grant claim', () => {
    const invalid = {
      schema: 'openslack.workflow_effect_control_observation.v1',
      contractVersion: 'v1',
      authority: 'typescript',
      goRole: 'observer_only',
      authorityClaim: 'NO_AUTHORITY',
      nonAuthorizingObservation: false,
      goEffectDecisionAuthority: true,
      goEffectExecutionAuthority: true,
      operation: 'approval_created',
      workspaceId: 'workspace-1',
      runId: 'run-1',
      occurrenceId: deriveWorkflowEffectOccurrenceId('run-1', 1),
      approvalId: 'approval-1',
      approvalRevision: 0,
      approvalStatus: 'pending',
      approvalHash: 'a'.repeat(64),
      approvalDecisionHash: null,
      effectId: `workflow-effect:sha256:${'b'.repeat(64)}`,
      effectHash: 'b'.repeat(64),
      correlationId: 'corr-1',
      requiredCapabilityHash: 'c'.repeat(64),
      humanDecision: null,
      bindingHash: null,
      decision: null,
      auditEventId: null,
      auditStatus: null,
      observedAt: '2026-08-12T00:00:00.000Z',
    };
    expect(() => validateWorkflowEffectControlObservation(invalid)).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_EFFECT_CONTROL_APPROVAL_PLANE_MISMATCH' }),
    );
  });

  it('validates every checked-in semantic artifact and observer envelope golden', () => {
    const golden = JSON.parse(
      readFileSync(
        resolve('packages/workflows/contracts/workflow-effect-control/v1/golden-vectors.json'),
        'utf8',
      ),
    ) as {
      vectors: {
        artifacts: Record<string, { value: unknown }>;
        observer: Record<string, { value?: unknown }>;
      };
    };
    expect(Object.keys(golden.vectors.artifacts)).toEqual([
      'intentAccepted',
      'intentDuplicate',
      'pending',
      'decisionApproved',
      'decisionRejected',
      'auditApproved',
      'auditRejected',
      'claimClaimed',
      'claimExecuted',
      'claimReconciliation',
      'legacyPending',
      'legacyApproved',
      'legacyExpired',
    ]);
    for (const vector of Object.values(golden.vectors.artifacts)) {
      expect(validateWorkflowEffectControlArtifact(vector.value)).toBeDefined();
    }
    for (const [name, vector] of Object.entries(golden.vectors.observer)) {
      if (name !== 'preparedApprovalDecided') {
        expect(validateWorkflowEffectControlEnvelope(vector.value)).toBeDefined();
      }
    }
  });

  it('keeps every generated JSON Schema closed over every checked-in golden', () => {
    const contractRoot = resolve('packages/workflows/contracts/workflow-effect-control/v1');
    const load = (path: string) =>
      JSON.parse(readFileSync(resolve(contractRoot, path), 'utf8')) as Record<string, unknown>;
    const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
    ajv.addSchema(
      JSON.parse(
        readFileSync(
          resolve(
            'packages/workflows/contracts/workflow-runner/v1/schemas/workflow-runner-message.v1.schema.json',
          ),
          'utf8',
        ),
      ),
    );
    ajv.addSchema(
      JSON.parse(
        readFileSync(
          resolve(
            'packages/workflows/contracts/workflow-runner/v1/schemas/workflow-runner-prepared-message.v1.schema.json',
          ),
          'utf8',
        ),
      ),
    );
    for (const path of [
      'schemas/workflow-effect-approval-record.v2.schema.json',
      'schemas/workflow-effect-control-human-decision.v1.schema.json',
      'schemas/workflow-effect-control-observation.v1.schema.json',
    ])
      ajv.addSchema(load(path));
    const validateArtifact = ajv.compile(
      load('schemas/workflow-effect-control-artifact.v1.schema.json'),
    );
    const validateEnvelope = ajv.compile(
      load('schemas/workflow-effect-control-envelope.v1.schema.json'),
    );
    const golden = load('golden-vectors.json') as {
      vectors: {
        artifacts: Record<string, { value: unknown }>;
        observer: Record<string, { value?: unknown }>;
      };
    };
    for (const vector of Object.values(golden.vectors.artifacts)) {
      expect(validateArtifact(vector.value), JSON.stringify(validateArtifact.errors)).toBe(true);
    }
    for (const [name, vector] of Object.entries(golden.vectors.observer)) {
      if (name !== 'preparedApprovalDecided') {
        expect(validateEnvelope(vector.value), JSON.stringify(validateEnvelope.errors)).toBe(true);
      }
    }
    const openNested = structuredClone(golden.vectors.artifacts.decisionApproved.value) as {
      approval: { decision: Record<string, unknown> };
    };
    openNested.approval.decision.rawReason = 'forbidden';
    expect(validateArtifact(openNested)).toBe(false);
    const rejectedClaim = structuredClone(golden.vectors.artifacts.claimClaimed.value) as Record<
      string,
      unknown
    >;
    const rejected = golden.vectors.artifacts.decisionRejected.value as Record<string, unknown>;
    rejectedClaim.approval = rejected.approval;
    rejectedClaim.approvalRecordHash = rejected.approvalRecordHash;
    rejectedClaim.approvalDecisionHash = rejected.approvalDecisionHash;
    rejectedClaim.humanDecision = rejected.humanDecision;
    rejectedClaim.consumedApprovalRecordHash = rejected.approvalRecordHash;
    expect(validateArtifact(rejectedClaim)).toBe(false);
    expect(() => validateWorkflowEffectControlArtifact(rejectedClaim)).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_EFFECT_CONTROL_APPROVAL_PLANE_MISMATCH' }),
    );

    const invalidVersion = structuredClone(golden.vectors.artifacts.pending.value) as {
      approval: { workflowVersion: string };
    };
    invalidVersion.approval.workflowVersion = 'not-semver';
    expect(validateArtifact(invalidVersion)).toBe(false);
    expect(() => validateWorkflowEffectControlArtifact(invalidVersion)).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_EFFECT_APPROVAL_INVALID' }),
    );

    for (const [targetName, sourceName] of [
      ['decisionApproved', 'auditApproved'],
      ['auditApproved', 'decisionApproved'],
    ] as const) {
      const revisionDrift = structuredClone(golden.vectors.artifacts[targetName].value) as Record<
        string,
        unknown
      >;
      const source = golden.vectors.artifacts[sourceName].value as Record<string, unknown>;
      revisionDrift.approval = source.approval;
      revisionDrift.approvalRecordHash = source.approvalRecordHash;
      revisionDrift.approvalDecisionHash = source.approvalDecisionHash;
      revisionDrift.humanDecision = source.humanDecision;
      expect(validateArtifact(revisionDrift)).toBe(false);
      expect(() => validateWorkflowEffectControlArtifact(revisionDrift)).toThrowError(
        expect.objectContaining({ code: 'WORKFLOW_EFFECT_CONTROL_STALE_REVISION' }),
      );
    }
  });

  it('rejects cross-occurrence replay, expired execution claims, and observer sequence drift', () => {
    const golden = JSON.parse(
      readFileSync(
        resolve('packages/workflows/contracts/workflow-effect-control/v1/golden-vectors.json'),
        'utf8',
      ),
    ) as {
      vectors: {
        artifacts: {
          intentAccepted: { value: Record<string, unknown> };
          claimClaimed: { value: Record<string, unknown> };
        };
        observer: {
          approvalCreated: { value: Record<string, unknown> };
          approvalDecided: { value: { observation: Record<string, unknown> } };
        };
      };
    };
    const intent = structuredClone(golden.vectors.artifacts.intentAccepted.value);
    intent.occurrenceIndex = 2;
    intent.occurrenceId = deriveWorkflowEffectOccurrenceId(intent.runId as string, 2);
    expect(() => validateWorkflowEffectControlArtifact(intent)).toThrow();

    const claim = structuredClone(golden.vectors.artifacts.claimClaimed.value);
    claim.claimedAt = (claim.approval as Record<string, unknown>).expiresAt;
    expect(() => validateWorkflowEffectControlArtifact(claim)).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_EFFECT_CONTROL_STALE_REVISION' }),
    );

    const envelope = structuredClone(golden.vectors.observer.approvalCreated.value);
    envelope.sourceSequence = 2;
    expect(() => validateWorkflowEffectControlEnvelope(envelope)).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_EFFECT_CONTROL_STALE_REVISION' }),
    );

    const observedAtDrift = structuredClone(
      golden.vectors.observer.approvalDecided.value.observation,
    );
    observedAtDrift.observedAt = '2026-08-12T00:59:59.000Z';
    expect(() => validateWorkflowEffectControlObservation(observedAtDrift)).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_EFFECT_CONTROL_IDENTITY_MISMATCH' }),
    );
  });
});

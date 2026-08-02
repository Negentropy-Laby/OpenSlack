import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_CONTROL_AUTHORITY,
  WORKFLOW_CONTROL_CONTRACT_ERROR_CODES,
  WORKFLOW_CONTROL_CONTRACT_LIMITS,
  WORKFLOW_CONTROL_DORMANT_STATES,
  WORKFLOW_CONTROL_EFFECT_APPROVAL_SCHEMA,
  WORKFLOW_CONTROL_GO_ROLE,
  WORKFLOW_CONTROL_PRODUCTION_INITIAL_STATE,
  WORKFLOW_CONTROL_QUALIFICATION_GAPS,
  WORKFLOW_CONTROL_RUN_STATES,
  WORKFLOW_CONTROL_STATE_TRANSITIONS,
  WorkflowControlContractError,
  hashWorkflowControlValue,
  projectWorkflowControlReadModel,
  validateWorkflowControlObservation,
  validateWorkflowControlTransition,
  type WorkflowControlObservation,
} from '../workflow-control-contract.js';

const contractRoot = new URL('../../contracts/workflow-control/v1/', import.meta.url);

function bytes(relativePath: string): Buffer {
  return readFileSync(new URL(relativePath, contractRoot));
}

function json(relativePath: string): Record<string, unknown> {
  return JSON.parse(bytes(relativePath).toString('utf8')) as Record<string, unknown>;
}

interface GoldenError {
  readonly name: string;
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

interface GoldenCase {
  readonly id: string;
  readonly operation: 'project' | 'validate' | 'transition' | 'hash';
  readonly input: unknown;
  readonly expected?: unknown;
  readonly expectedError?: GoldenError;
}

function capturedError(operation: () => unknown): GoldenError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowControlContractError);
    const contractError = error as WorkflowControlContractError;
    return {
      name: contractError.name,
      code: contractError.code,
      path: contractError.path,
      message: contractError.message,
    };
  }
  throw new Error('Expected WorkflowControlContractError.');
}

describe('Workflow Control GS7-A contract freeze', () => {
  it('freezes the current observed transition table without claiming dormant writers', () => {
    expect(WORKFLOW_CONTROL_RUN_STATES).toEqual([
      'created',
      'previewed',
      'confirmed',
      'running',
      'paused',
      'paused_waiting_approval',
      'resuming',
      'completed',
      'failed',
      'cancelled',
    ]);
    expect(WORKFLOW_CONTROL_STATE_TRANSITIONS).toEqual({
      created: ['previewed', 'confirmed', 'running'],
      previewed: ['confirmed', 'running'],
      confirmed: ['running'],
      running: [
        'paused',
        'paused_waiting_approval',
        'resuming',
        'completed',
        'failed',
        'cancelled',
      ],
      paused: ['running'],
      paused_waiting_approval: ['resuming', 'cancelled'],
      resuming: ['running', 'failed', 'cancelled'],
      completed: [],
      failed: [],
      cancelled: [],
    });
    expect(WORKFLOW_CONTROL_PRODUCTION_INITIAL_STATE).toBe('running');
    expect(WORKFLOW_CONTROL_DORMANT_STATES).toEqual(['created', 'previewed', 'confirmed']);
    expect(() => validateWorkflowControlTransition('running', 'paused')).not.toThrow();
    expect(() => validateWorkflowControlTransition('completed', 'running')).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_CONTROL_INVALID_TRANSITION' }),
    );
  });

  it('keeps TypeScript authoritative and Go in a credential-free, non-authority role', () => {
    const manifest = json('manifest.json') as {
      authority: string;
      authorityBoundary: Record<string, unknown>;
      observedBehavior: Record<string, unknown>;
      approvalPlanes: Record<string, unknown>;
      qualificationGaps: unknown;
      limits: unknown;
      errorCodes: unknown;
    };
    expect(manifest.authority).toBe(WORKFLOW_CONTROL_AUTHORITY);
    expect(manifest.authorityBoundary).toEqual({
      writer: '@openslack/workflows',
      localStore: '.openslack.local/workflows/runs',
      typescriptRemainsSoleWriter: true,
      goRole: WORKFLOW_CONTROL_GO_ROLE,
      authorityEligible: false,
    });
    expect(manifest.observedBehavior).toMatchObject({
      productionInitialState: 'running',
      dormantStatesWithoutProductionWriter: ['created', 'previewed', 'confirmed'],
      checkpointPersistenceAtomic: false,
      controlPathsCanBypassTransitionTable: true,
    });
    expect(manifest.approvalPlanes).toMatchObject({
      legacyRunGate: { semantics: 'run-gate-only', effectDecisionAuthority: false },
      effectV2: {
        schema: WORKFLOW_CONTROL_EFFECT_APPROVAL_SCHEMA,
        semantics: 'effect-decision-only',
        normative: true,
      },
      interchangeable: false,
    });
    expect(manifest.qualificationGaps).toEqual(WORKFLOW_CONTROL_QUALIFICATION_GAPS);
    expect(manifest.limits).toEqual(WORKFLOW_CONTROL_CONTRACT_LIMITS);
    expect(manifest.errorCodes).toEqual(WORKFLOW_CONTROL_CONTRACT_ERROR_CODES);
  });

  it('locks every generated artifact by exact byte length and full SHA-256', () => {
    const manifest = json('manifest.json') as {
      canonicalization: { hashHexLength: number };
      artifacts: Record<string, { path: string; byteLength: number; sha256: string }>;
    };
    expect(manifest.canonicalization.hashHexLength).toBe(64);
    for (const artifact of Object.values(manifest.artifacts)) {
      const value = bytes(artifact.path);
      expect(value.byteLength).toBe(artifact.byteLength);
      expect(createHash('sha256').update(value).digest('hex')).toBe(artifact.sha256);
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it('compiles both closed JSON Schemas and rejects credential-bearing fields', () => {
    const vectors = json('golden-vectors.json') as unknown as { cases: GoldenCase[] };
    const valid = vectors.cases.find((item) => item.id === 'valid-projection')!;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validateObservation = ajv.compile(
      json('schemas/workflow-control-observation.v1.schema.json'),
    );
    const validateReadModel = ajv.compile(
      json('schemas/workflow-control-read-model.v1.schema.json'),
    );
    expect(validateObservation(valid.input), JSON.stringify(validateObservation.errors)).toBe(true);
    expect(validateReadModel(valid.expected), JSON.stringify(validateReadModel.errors)).toBe(true);
    expect(validateObservation({ ...(valid.input as object), args: { token: 'secret' } })).toBe(
      false,
    );
    expect(validateReadModel({ ...(valid.expected as object), decision: 'approved' })).toBe(false);
  });

  it('replays valid, terminal, invalid, approval-plane, sensitive-field, and bound vectors', () => {
    const vectors = json('golden-vectors.json') as unknown as { cases: GoldenCase[] };
    expect(vectors.cases.map((item) => item.id)).toEqual([
      'valid-projection',
      'terminal-run-projection',
      'invalid-schema',
      'invalid-status',
      'invalid-terminal-transition',
      'legacy-run-gate-is-not-effect-approval',
      'secret-like-raw-field-rejected',
      'phase-bound-enforced',
      'valid-observation-full-sha256',
    ]);

    for (const testCase of vectors.cases) {
      if (testCase.operation === 'project') {
        expect(projectWorkflowControlReadModel(testCase.input)).toEqual(testCase.expected);
      } else if (testCase.operation === 'hash') {
        expect(hashWorkflowControlValue(testCase.input)).toBe(testCase.expected);
        expect(testCase.expected).toMatch(/^[0-9a-f]{64}$/u);
      } else if (testCase.operation === 'transition') {
        const input = testCase.input as { from: 'completed'; to: 'running' };
        expect(
          capturedError(() => validateWorkflowControlTransition(input.from, input.to)),
        ).toEqual(testCase.expectedError);
      } else {
        expect(capturedError(() => validateWorkflowControlObservation(testCase.input))).toEqual(
          testCase.expectedError,
        );
      }
    }
  });

  it('projects only hashes, counts, and non-secret control metadata', () => {
    const vectors = json('golden-vectors.json') as unknown as { cases: GoldenCase[] };
    const valid = vectors.cases.find((item) => item.id === 'valid-projection')!;
    const observation = validateWorkflowControlObservation(
      valid.input,
    ) as WorkflowControlObservation;
    const projection = projectWorkflowControlReadModel(observation);
    expect(projection.authorityEligible).toBe(false);
    expect(projection.goRole).toBe('credential-free-read-model-only');
    expect(projection.phaseCounts).toEqual({
      total: 2,
      completed: 1,
      failed: 0,
      skipped: 1,
      resultHashBound: 1,
      cacheKeyHashBound: 1,
    });
    expect(projection.approvals.legacyRunGate.semantics).toBe('run-gate-only');
    expect(projection.approvals.effectV2.semantics).toBe('effect-decision-only');
    expect(projection.observationHash).toHaveLength(64);

    const marker = 'DO-NOT-EXPORT-THIS-VALUE';
    expect(() =>
      validateWorkflowControlObservation({ ...observation, detail: marker }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_CONTROL_SENSITIVE_FIELD_FORBIDDEN' }));
    expect(JSON.stringify(projection)).not.toContain(marker);
  });
});

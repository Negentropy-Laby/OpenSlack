import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export type OnboardingStepId =
  | 'workspace'
  | 'provider'
  | 'github_app'
  | 'installation'
  | 'identity'
  | 'runtime_smoke'
  | 'delivery_probe';

export type OnboardingStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'needs_reconcile'
  | 'failed';

export interface OnboardingReceipt {
  summary: string;
  evidenceRefs: string[];
}

export interface OnboardingStepState {
  id: OnboardingStepId;
  status: OnboardingStepStatus;
  updatedAt: string;
  attempt: number;
  receipt?: OnboardingReceipt;
  errorCode?: string;
}

export interface OnboardingState {
  schema: 'openslack.onboarding.v1';
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  steps: OnboardingStepState[];
}

export class OnboardingStateError extends Error {
  constructor(
    readonly code: 'ONBOARDING_STATE_INVALID' | 'ONBOARDING_STEP_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'OnboardingStateError';
  }
}

export class OnboardingStore {
  readonly path: string;

  constructor(
    localStateRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.path = join(localStateRoot, 'onboarding.json');
  }

  create(sessionId: string = randomUUID()): OnboardingState {
    const timestamp = this.now().toISOString();
    const state: OnboardingState = {
      schema: 'openslack.onboarding.v1',
      sessionId,
      createdAt: timestamp,
      updatedAt: timestamp,
      steps: STEP_IDS.map((id) => ({ id, status: 'pending', updatedAt: timestamp, attempt: 0 })),
    };
    this.save(state);
    return state;
  }

  load(): OnboardingState {
    let state: OnboardingState;
    try {
      state = JSON.parse(readFileSync(this.path, 'utf-8')) as OnboardingState;
    } catch {
      throw new OnboardingStateError(
        'ONBOARDING_STATE_INVALID',
        'Onboarding state is unavailable or invalid.',
      );
    }
    validateState(state);
    let changed = false;
    const timestamp = this.now().toISOString();
    for (const step of state.steps) {
      if (step.status === 'running') {
        step.status = 'needs_reconcile';
        step.updatedAt = timestamp;
        changed = true;
      }
    }
    if (changed) this.save({ ...state, updatedAt: timestamp });
    return state;
  }

  begin(state: OnboardingState, stepId: OnboardingStepId): OnboardingState {
    return this.updateStep(state, stepId, (step, timestamp) => ({
      ...step,
      status: 'running',
      updatedAt: timestamp,
      attempt: step.attempt + 1,
      receipt: undefined,
      errorCode: undefined,
    }));
  }

  complete(
    state: OnboardingState,
    stepId: OnboardingStepId,
    receipt: OnboardingReceipt,
  ): OnboardingState {
    assertSafeReceipt(receipt);
    return this.updateStep(state, stepId, (step, timestamp) => {
      if (step.status !== 'running') {
        throw new OnboardingStateError(
          'ONBOARDING_STEP_INVALID',
          'Only a running onboarding step can complete.',
        );
      }
      return { ...step, status: 'completed', updatedAt: timestamp, receipt };
    });
  }

  fail(state: OnboardingState, stepId: OnboardingStepId, errorCode: string): OnboardingState {
    if (!/^[A-Z][A-Z0-9_]{2,80}$/.test(errorCode)) {
      throw new OnboardingStateError(
        'ONBOARDING_STEP_INVALID',
        'Onboarding error code is invalid.',
      );
    }
    return this.updateStep(state, stepId, (step, timestamp) => ({
      ...step,
      status: 'failed',
      updatedAt: timestamp,
      errorCode,
      receipt: undefined,
    }));
  }

  nextActionable(state: OnboardingState): OnboardingStepState | null {
    return (
      state.steps.find((step) => step.status === 'needs_reconcile') ??
      state.steps.find((step) => step.status === 'failed') ??
      state.steps.find((step) => step.status === 'pending') ??
      null
    );
  }

  private updateStep(
    state: OnboardingState,
    stepId: OnboardingStepId,
    update: (step: OnboardingStepState, timestamp: string) => OnboardingStepState,
  ): OnboardingState {
    validateState(state);
    const timestamp = this.now().toISOString();
    let found = false;
    const steps = state.steps.map((step) => {
      if (step.id !== stepId) return step;
      found = true;
      return update(step, timestamp);
    });
    if (!found)
      throw new OnboardingStateError('ONBOARDING_STEP_INVALID', 'Unknown onboarding step.');
    const next = { ...state, updatedAt: timestamp, steps };
    this.save(next);
    return next;
  }

  private save(state: OnboardingState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: 'utf-8',
        flag: 'wx',
        mode: 0o600,
      });
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

function validateState(state: OnboardingState): void {
  if (
    state?.schema !== 'openslack.onboarding.v1' ||
    typeof state.sessionId !== 'string' ||
    !Array.isArray(state.steps) ||
    state.steps.length !== STEP_IDS.length ||
    !STEP_IDS.every((id) => state.steps.some((step) => step.id === id))
  ) {
    throw new OnboardingStateError(
      'ONBOARDING_STATE_INVALID',
      'Onboarding state schema is invalid.',
    );
  }
}

function assertSafeReceipt(receipt: OnboardingReceipt): void {
  if (
    !receipt.summary ||
    receipt.summary.length > 500 ||
    !Array.isArray(receipt.evidenceRefs) ||
    receipt.evidenceRefs.some((ref) => typeof ref !== 'string' || ref.length > 500) ||
    /private.?key|secret|token/i.test(JSON.stringify(receipt))
  ) {
    throw new OnboardingStateError(
      'ONBOARDING_STEP_INVALID',
      'Onboarding receipt is not safely redacted.',
    );
  }
}

const STEP_IDS: OnboardingStepId[] = [
  'workspace',
  'provider',
  'github_app',
  'installation',
  'identity',
  'runtime_smoke',
  'delivery_probe',
];

import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

export interface OnboardingStepGuide {
  id: OnboardingStepId;
  title: string;
  objective: string;
  commands: string[];
  verification: string;
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
    if (existsSync(this.path)) {
      throw new OnboardingStateError(
        'ONBOARDING_STATE_INVALID',
        'An onboarding session already exists. Resume it instead of replacing its receipts.',
      );
    }
    const timestamp = this.now().toISOString();
    const state: OnboardingState = {
      schema: 'openslack.onboarding.v1',
      sessionId,
      createdAt: timestamp,
      updatedAt: timestamp,
      steps: STEP_IDS.map((id) => ({ id, status: 'pending', updatedAt: timestamp, attempt: 0 })),
    };
    this.save(state, true);
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
    return this.updateStep(state, stepId, (step, timestamp) => {
      if (step.status !== 'pending' && step.status !== 'failed') {
        throw new OnboardingStateError(
          'ONBOARDING_STEP_INVALID',
          step.status === 'needs_reconcile'
            ? 'Interrupted onboarding work must be reconciled before it can be retried.'
            : 'Only a pending or failed onboarding step can begin.',
        );
      }
      return {
        ...step,
        status: 'running',
        updatedAt: timestamp,
        attempt: step.attempt + 1,
        receipt: undefined,
        errorCode: undefined,
      };
    });
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

  reconcile(
    state: OnboardingState,
    stepId: OnboardingStepId,
    outcome: 'completed' | 'retry',
    receipt?: OnboardingReceipt,
  ): OnboardingState {
    if (outcome === 'completed') {
      if (!receipt) {
        throw new OnboardingStateError(
          'ONBOARDING_STEP_INVALID',
          'A safely redacted receipt is required to reconcile a completed step.',
        );
      }
      assertSafeReceipt(receipt);
    } else if (receipt) {
      throw new OnboardingStateError(
        'ONBOARDING_STEP_INVALID',
        'Retry reconciliation must not attach a completion receipt.',
      );
    }

    return this.updateStep(state, stepId, (step, timestamp) => {
      if (step.status !== 'needs_reconcile') {
        throw new OnboardingStateError(
          'ONBOARDING_STEP_INVALID',
          'Only an interrupted onboarding step can be reconciled.',
        );
      }
      return outcome === 'completed'
        ? { ...step, status: 'completed', updatedAt: timestamp, receipt, errorCode: undefined }
        : {
            ...step,
            status: 'pending',
            updatedAt: timestamp,
            receipt: undefined,
            errorCode: undefined,
          };
    });
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

  private save(state: OnboardingState, createOnly: boolean = false): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: 'utf-8',
        flag: 'wx',
        mode: 0o600,
      });
      if (createOnly) {
        try {
          linkSync(temporary, this.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new OnboardingStateError(
              'ONBOARDING_STATE_INVALID',
              'An onboarding session already exists. Resume it instead of replacing its receipts.',
            );
          }
          throw error;
        }
      } else {
        renameSync(temporary, this.path);
      }
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

function validateState(state: OnboardingState): void {
  const stepIds = Array.isArray(state?.steps) ? state.steps.map((step) => step?.id) : [];
  if (
    state?.schema !== 'openslack.onboarding.v1' ||
    typeof state.sessionId !== 'string' ||
    state.sessionId.length < 1 ||
    state.sessionId.length > 200 ||
    !isIsoTimestamp(state.createdAt) ||
    !isIsoTimestamp(state.updatedAt) ||
    !Array.isArray(state.steps) ||
    state.steps.length !== STEP_IDS.length ||
    new Set(stepIds).size !== STEP_IDS.length ||
    !STEP_IDS.every((id) => stepIds.includes(id)) ||
    state.steps.some((step) => !isValidStepState(step))
  ) {
    throw new OnboardingStateError(
      'ONBOARDING_STATE_INVALID',
      'Onboarding state schema is invalid.',
    );
  }
}

function isValidStepState(step: OnboardingStepState): boolean {
  const statuses: OnboardingStepStatus[] = [
    'pending',
    'running',
    'completed',
    'needs_reconcile',
    'failed',
  ];
  if (
    !STEP_IDS.includes(step?.id) ||
    !statuses.includes(step?.status) ||
    !isIsoTimestamp(step.updatedAt) ||
    !Number.isSafeInteger(step.attempt) ||
    step.attempt < 0 ||
    (step.errorCode !== undefined && !/^[A-Z][A-Z0-9_]{2,80}$/.test(step.errorCode)) ||
    (step.status === 'failed' && step.errorCode === undefined) ||
    (step.status !== 'failed' && step.errorCode !== undefined) ||
    (step.status === 'completed' && step.receipt === undefined) ||
    (step.status !== 'completed' && step.receipt !== undefined)
  ) {
    return false;
  }
  if (!step.receipt) return true;
  try {
    assertSafeReceipt(step.receipt);
    return true;
  } catch {
    return false;
  }
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function assertSafeReceipt(receipt: OnboardingReceipt): void {
  if (
    !receipt.summary ||
    receipt.summary.length > 500 ||
    !Array.isArray(receipt.evidenceRefs) ||
    receipt.evidenceRefs.some(
      (ref) => typeof ref !== 'string' || ref.length > 500 || containsReceiptSecret(ref),
    ) ||
    containsReceiptSecret(receipt.summary)
  ) {
    throw new OnboardingStateError(
      'ONBOARDING_STEP_INVALID',
      'Onboarding receipt is not safely redacted.',
    );
  }
}

function containsReceiptSecret(value: string): boolean {
  return RECEIPT_SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

// Receipt prose may safely name credential concepts and references, for example
// "token reference configured" or keychain:openslack/app-webhook-secret. Reject
// secret material and assignments instead of forcing audit summaries to be vague.
const RECEIPT_SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[a-z]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16})\b/i,
  /\b(?:private.?key|secret|token|password|credential)\b\s*[:=]\s*(?!(?:env|keychain):|\[redacted\])\S+/i,
  /(?:access_token|client_secret|private_key)\s*=\s*[^&\s]+/i,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/i,
];

const STEP_IDS: OnboardingStepId[] = [
  'workspace',
  'provider',
  'github_app',
  'installation',
  'identity',
  'runtime_smoke',
  'delivery_probe',
];

export const ONBOARDING_STEP_GUIDES: Readonly<Record<OnboardingStepId, OnboardingStepGuide>> = {
  workspace: {
    id: 'workspace',
    title: 'Initialize the workspace',
    objective: 'Create the minimal OpenSlack workspace without a source checkout.',
    commands: ['openslack init', 'openslack init --apply'],
    verification: 'Run openslack workspace validate.',
  },
  provider: {
    id: 'provider',
    title: 'Configure a model provider',
    objective: 'Select a real provider and store only an env: or keychain: credential reference.',
    commands: ['openslack setup interactive', 'openslack setup smoke'],
    verification: 'Confirm the runtime smoke reports a configured non-fixture provider.',
  },
  github_app: {
    id: 'github_app',
    title: 'Create or import the organization GitHub App',
    objective: 'Store App credentials in the configured keychain without project-state secrets.',
    commands: [
      'openslack github app create --org <organization>',
      'openslack github app create --org <organization> --apply',
    ],
    verification: 'Confirm local config contains keychain references only.',
  },
  installation: {
    id: 'installation',
    title: 'Verify installation scope and permissions',
    objective: 'Distinguish public read access from selected-repository installation access.',
    commands: ['openslack delivery doctor --repo <owner/repo> --require-issues-write'],
    verification: 'Confirm contents, pull requests, issues, and repository selection pass.',
  },
  identity: {
    id: 'identity',
    title: 'Verify author and approval identities',
    objective: 'Keep bot PR authorship separate from the human reviewer/CODEOWNER.',
    commands: ['openslack setup run', 'openslack doctor'],
    verification:
      'Review CODEOWNERS guidance; apply any Red-zone change through a human-approved PR.',
  },
  runtime_smoke: {
    id: 'runtime_smoke',
    title: 'Run the standalone runtime smoke',
    objective: 'Prove the configured provider fails closed and can execute governed runtime work.',
    commands: ['openslack setup smoke'],
    verification: 'Retain only redacted smoke evidence and typed failure/success codes.',
  },
  delivery_probe: {
    id: 'delivery_probe',
    title: 'Probe bot-authenticated Git delivery',
    objective: 'Push, verify, and delete a unique temporary installation-authenticated ref.',
    commands: [
      'openslack delivery probe --repo <owner/repo>',
      'openslack delivery probe --repo <owner/repo> --apply',
    ],
    verification: 'Confirm the remote probe ref was deleted or run the exact cleanup remediation.',
  },
};

export function getOnboardingStepGuide(stepId: OnboardingStepId): OnboardingStepGuide {
  return ONBOARDING_STEP_GUIDES[stepId];
}

export interface OperatorRequest {
  text: string;
  source: 'cli' | 'webhook' | 'slack';
  actor?: {
    id: string;
    displayName?: string;
    provider?: 'local' | 'github' | 'slack';
  };
  channel?: {
    id: string;
    type: 'terminal' | 'dm' | 'channel' | 'webhook';
  };
}

export type IntentKind =
  | 'status'
  | 'doctor'
  | 'create_task'
  | 'claim_task'
  | 'checkout_task'
  | 'sync_task'
  | 'issue_done'
  | 'pr_status'
  | 'pr_doctor'
  | 'pr_review'
  | 'pr_watch'
  | 'pr_merge'
  | 'governance_audit'
  | 'unknown';

export interface Intent {
  kind: IntentKind;
  slots: Record<string, string | number | string[] | undefined>;
  confidence: number;
}

export interface MissingParam {
  name: string;
  type: 'string' | 'number' | 'string[]';
  description: string;
  required: boolean;
}

export interface PlanStep {
  id: string;
  tool: 'openslack-cli' | 'package-api';
  command: string;
  args: string[];
  description: string;
  confirmationRequired: boolean;
  produces?: string[];
}

export type RiskLevel = 'none' | 'low' | 'medium' | 'high';

export interface ActionPlan {
  goal: string;
  intent: Intent;
  steps: PlanStep[];
  riskLevel: RiskLevel;
  riskExplanation?: string;
  missingParams: MissingParam[];
  requiresConfirmation: boolean;
  sideEffects: boolean;
}

export interface StepResult {
  stepId: string;
  status: 'success' | 'failed' | 'skipped';
  output: string;
  exitCode?: number;
}

export interface ExecutionResult {
  planId: string;
  status: 'success' | 'blocked' | 'failed' | 'cancelled';
  steps: StepResult[];
  summary: string;
  nextActions: string[];
}

export interface ExecutionOptions {
  dryRun?: boolean;
  onStepStart?: (step: PlanStep) => void;
  onStepComplete?: (step: PlanStep, result: StepResult) => void;
  confirmStep?: (step: PlanStep) => Promise<boolean>;
}

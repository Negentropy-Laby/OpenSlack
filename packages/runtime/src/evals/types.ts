export interface EvalCase {
  id: string;
  title: string;
  goal: string;
  onFailure:
    | 'auto_create_evol'
    | 'block_pr_notify_human'
    | 'block_pr_critical_alert'
    | 'immediate_reject'
    | 'auto_create_rollback';
  assertions: EvalAssertion[];
  setup?: EvalSetup;
  scenario?: EvalScenario;
}

export interface EvalAssertion {
  description: string;
  check: string;
}

export interface EvalSetup {
  changed_paths: string[];
}

export interface EvalScenario {
  description: string;
  parameters: Record<string, unknown>;
}

export interface EvalSuite {
  name: string;
  cases: EvalCase[];
}

export interface EvalResult {
  caseId: string;
  title: string;
  passed: boolean;
  details: string[];
  onFailure: string;
}

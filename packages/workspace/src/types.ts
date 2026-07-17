export interface WorkspaceConfig {
  schema: string;
  workspace_id: string;
  name: string;
  description?: string;
  mode: 'self_project' | 'normal';
  canonical_remote: {
    provider: 'github';
    owner: string;
    repo: string;
    default_branch: string;
  };
  workspace: {
    root: string;
    state_root: string;
  };
  product: {
    repo_role: 'self' | 'managed';
    source_roots: string[];
    protected_roots: string[];
  };
  sidecar?: {
    attach_mode: 'read-only-monitor' | 'full-agent';
    auto_claim: false;
  };
  self_evolution?: {
    enabled: boolean;
    module: string;
    evolution_board: {
      github_owner: string;
      project_number: number;
    };
    default_risk_level: 'low' | 'medium' | 'high' | 'critical';
    human_required_for_constitutional_changes: boolean;
    max_evolutions_per_day: number;
  };
}

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationError {
  severity: ValidationSeverity;
  message: string;
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  config?: WorkspaceConfig;
}

export interface WorkspaceCheck {
  name: string;
  check: (rootPath: string) => Promise<ValidationError[]> | ValidationError[];
}

export type RiskZone = 'green' | 'yellow' | 'red' | 'black';

export interface ZoneDefinition {
  zone: RiskZone;
  paths: string[];
  auto_merge_allowed: boolean;
  requires_independent_agent_review?: boolean;
  requires_human_approval?: boolean;
  requires_security_review?: boolean;
  requires_all_checks?: boolean;
}

export interface PolicyDefinition {
  zones: Record<RiskZone, ZoneDefinition>;
  agent_rules: Record<string, boolean>;
  merge_rules: Record<RiskZone, MergeRule>;
}

export interface MergeRule {
  required_checks: string[];
  required_agent_reviews: number;
  human_required: boolean;
}

export interface PolicyResult {
  passed: boolean;
  zone: RiskZone;
  violations: string[];
  requiredActions: string[];
}

// Self-evolution types needed by kernel
export interface MergeDecision {
  decision: 'merge_queue' | 'deny' | 'require_human' | 'wait';
  reason: string;
  riskZone: RiskZone;
}

export interface SelfValidationResult {
  experimentId: string;
  prNumber: number;
  headSha: string;
  checks: Record<string, { result: 'pass' | 'fail' | 'skip'; command: string }>;
  protectedPathCheck: {
    result: 'pass' | 'fail';
    red_zone_touched: boolean;
    black_zone_touched: boolean;
  };
  score: {
    overall: number;
    decision: 'pass' | 'review' | 'block';
    dimensions: Record<string, unknown>;
  };
  decision: 'pass' | 'fail' | 'requires_human';
}

// --- Agent Identity and Permission Control Plane ---

export type ActionVerdict = 'allow' | 'ask' | 'deny';

export interface AgentRegistryIdentity {
  uid: string;
  principal_id: string;
  public_key_jwk: unknown | null;
  key_id: string | null;
  key_rotation: {
    last_rotated_at: string | null;
    rotation_interval_days: number;
  };
  status: 'active' | 'suspended' | 'retired';
}

export interface AgentPermissions {
  paths: {
    allow: string[];
    deny: string[];
  };
  actions: Record<string, ActionVerdict>;
  github: {
    can_create_pr: boolean;
    can_comment: boolean;
    can_approve: boolean;
    can_merge: boolean;
  };
  max_risk_zone: RiskZone;
}

export interface AgentRegistryEntry {
  schema: 'openslack.agent_registry.v2';
  agent_id: string;
  display_name: string;
  employee_type: 'ai_agent';
  identity: AgentRegistryIdentity;
  vendor: { provider: string; runtime: string; model?: string };
  employment: {
    status: 'active' | 'paused' | 'onboarding' | 'retired';
    hired_at: string;
    hired_by?: string;
    department?: string;
    role?: string;
    manager?: string;
  };
  capabilities: { primary: string[]; secondary: string[] };
  repositories: {
    workspace_repo: { owner: string; repo: string; default_branch: string };
    allowed_product_repos?: string[];
  };
  permissions: AgentPermissions;
  execution: {
    max_parallel_tasks?: number;
    lease_ttl_minutes?: number;
    heartbeat_interval_minutes?: number;
    max_task_runtime_minutes?: number;
    max_daily_tasks?: number;
  };
  output_contract: {
    must_create: string[];
    may_create: string[];
    must_not_create: string[];
  };
  approval_rules: {
    require_human_approval_for: string[];
  };
  task_matching?: {
    github_owner?: string;
    github_project_number?: number;
    max_risk_level?: string;
  };
  scheduler?: {
    preferred_mode?: string;
    cadence_minutes?: number;
  };
}

export interface AgentRuntimeIdentity {
  schema: 'openslack.agent_runtime_identity.v1';
  agent_id: string;
  agent_uid: string;
  run_id: string;
  public_key_jwk: unknown | null;
  key_id: string | null;
  key_generated_at: string | null;
  provider: 'cli' | 'slack' | 'github' | 'webhook';
  authenticated_github_identity?: {
    login: string;
    is_bot: boolean;
  };
  started_at: string;
}

export interface AgentPrincipal {
  registry_id: string;
  runtime_uid: string;
  run_id: string;
  provider: 'cli' | 'slack' | 'github' | 'webhook';
  authenticated_github_identity?: {
    login: string;
    is_bot: boolean;
  };
}

export interface AgentPermissionSnapshot {
  principal: AgentPrincipal;
  registry_entry_agent_id: string;
  permissions: AgentPermissions;
  resolved_at: string;
  source: 'registry_v1' | 'registry_v2';
}

export type AuthorizationDecision = 'allow' | 'ask' | 'deny';

export interface AuthorizationEvidence {
  rule: string;
  reason: string;
  agent_id: string;
  action: string;
  risk_zone?: RiskZone;
  identity_verified: boolean;
  registry_active: boolean;
}

export interface AuthorizationResult {
  decision: AuthorizationDecision;
  evidence: AuthorizationEvidence;
  prompt_message?: string;
  diagnostics: string[];
}

// --- Subagent Definition ---

export type PermissionMode = 'plan' | 'acceptEdits' | 'default' | 'strict';

export interface SubagentDefinition {
  id: string;
  source: 'openslack' | 'claude-project' | 'claude-user' | 'codex' | 'runtime';
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  skills?: string[];
  mcpServers?: unknown[];
  memory?: 'user' | 'project' | 'local' | 'none';
  isolation?: 'none' | 'worktree';
  color?: string;
  rawPath?: string;
  // Phase AR — Agent Runtime Hardening extensions
  effort?: 'low' | 'medium' | 'high';
  hooks?: { before?: string; after?: string };
  initialPrompt?: string;
  background?: boolean;
  requiredMcpServers?: string[];
  criticalSystemReminder?: string;
  remote?: boolean;
}

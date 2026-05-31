// @openslack/tui — Action dispatch types

export enum TuiActionCategory {
  PlanApproval = 'plan-approval',
  WorkflowConfirmation = 'workflow-confirmation',
  MergeConfirmation = 'merge-confirmation',
  GithubApproval = 'github-approval',
  ProfileSyncConfirmation = 'profile-sync-confirmation',
  WorkflowExecute = 'workflow-execute',
  WorkflowPreview = 'workflow-preview',
  WorkflowDryRun = 'workflow-dry-run',
  TrustChange = 'trust-change',
}

export enum TuiRiskLevel {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Critical = 'critical',
}

export enum TuiActionStatus {
  Idle = 'idle',
  Confirming = 'confirming',
  Executing = 'executing',
  Success = 'success',
  Error = 'error',
}

export interface TuiActionResult {
  readonly success: boolean
  readonly message: string
  readonly data?: Record<string, unknown>
}

export interface TuiAction {
  readonly id: string
  readonly category: TuiActionCategory
  readonly risk: TuiRiskLevel
  readonly label: string
  readonly description: string
  readonly requiresConfirmation: boolean
  readonly handler: () => Promise<TuiActionResult>
}

export interface TuiActionState {
  readonly status: TuiActionStatus
  readonly result?: TuiActionResult
  readonly error?: string
}

/** Categories that always require user confirmation, regardless of requiresConfirmation flag. */
export const REQUIRES_CONFIRMATION: ReadonlySet<TuiActionCategory> = new Set<TuiActionCategory>([
  TuiActionCategory.MergeConfirmation,
  TuiActionCategory.WorkflowConfirmation,
  TuiActionCategory.GithubApproval,
  TuiActionCategory.ProfileSyncConfirmation,
  TuiActionCategory.TrustChange,
])

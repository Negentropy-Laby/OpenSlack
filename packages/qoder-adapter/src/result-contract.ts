export const OPENSLACK_MCP_RESULT_SCHEMA = 'openslack.mcp_result.v1' as const;

export type OpenSlackMcpStatus =
  | 'completed'
  | 'preview'
  | 'needs_confirmation'
  | 'blocked'
  | 'failed';

export type OpenSlackMcpRisk = 'none' | 'low' | 'medium' | 'high';

export interface OpenSlackMcpGovernance {
  readonly risk: OpenSlackMcpRisk;
  readonly approvalRequired: boolean;
  readonly approvalKind?: 'openslack_confirm' | 'github_human_review' | 'workflow_trust';
  readonly owner?: string;
  readonly blocker?: string;
}

export interface OpenSlackMcpNextAction {
  readonly id: string;
  readonly label: string;
  readonly tool?: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

export interface OpenSlackMcpResult<T = unknown> {
  readonly schema: typeof OPENSLACK_MCP_RESULT_SCHEMA;
  readonly status: OpenSlackMcpStatus;
  readonly summary: string;
  readonly data?: T;
  readonly governance: OpenSlackMcpGovernance;
  readonly nextActions: readonly OpenSlackMcpNextAction[];
  readonly evidenceRefs: readonly string[];
  readonly planId?: string;
  readonly executionId?: string;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface CreateOpenSlackMcpResultOptions<T> {
  readonly status?: OpenSlackMcpStatus;
  readonly summary: string;
  readonly data?: T;
  readonly governance?: Partial<OpenSlackMcpGovernance>;
  readonly nextActions?: readonly OpenSlackMcpNextAction[];
  readonly evidenceRefs?: readonly string[];
  readonly planId?: string;
  readonly executionId?: string;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

const MAX_SUMMARY_LENGTH = 2_000;
const MAX_EVIDENCE_REFS = 50;
const MAX_EVIDENCE_REF_LENGTH = 512;
const MAX_NEXT_ACTIONS = 12;
const MAX_ID_LENGTH = 160;
const MAX_ERROR_CODE_LENGTH = 100;
const MAX_ERROR_MESSAGE_LENGTH = 1_000;

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizeEvidenceRefs(refs: readonly string[]): readonly string[] {
  return Object.freeze(
    [...new Set(refs)]
      .slice(0, MAX_EVIDENCE_REFS)
      .map((reference) => truncate(reference.trim(), MAX_EVIDENCE_REF_LENGTH))
      .filter(Boolean),
  );
}

export function createOpenSlackMcpResult<T>(
  options: CreateOpenSlackMcpResultOptions<T>,
): OpenSlackMcpResult<T> {
  const governance: OpenSlackMcpGovernance = Object.freeze({
    risk: options.governance?.risk ?? 'none',
    approvalRequired: options.governance?.approvalRequired ?? false,
    ...(options.governance?.approvalKind ? { approvalKind: options.governance.approvalKind } : {}),
    ...(options.governance?.owner ? { owner: options.governance.owner } : {}),
    ...(options.governance?.blocker ? { blocker: options.governance.blocker } : {}),
  });

  return Object.freeze({
    schema: OPENSLACK_MCP_RESULT_SCHEMA,
    status: options.status ?? 'completed',
    summary: truncate(options.summary.trim(), MAX_SUMMARY_LENGTH),
    ...(options.data === undefined ? {} : { data: options.data }),
    governance,
    nextActions: Object.freeze([...(options.nextActions ?? [])].slice(0, MAX_NEXT_ACTIONS)),
    evidenceRefs: normalizeEvidenceRefs(options.evidenceRefs ?? []),
    ...(options.planId ? { planId: truncate(options.planId.trim(), MAX_ID_LENGTH) } : {}),
    ...(options.executionId
      ? { executionId: truncate(options.executionId.trim(), MAX_ID_LENGTH) }
      : {}),
    ...(options.error
      ? {
          error: Object.freeze({
            code: truncate(options.error.code.trim(), MAX_ERROR_CODE_LENGTH),
            message: truncate(options.error.message.trim(), MAX_ERROR_MESSAGE_LENGTH),
          }),
        }
      : {}),
  });
}

export function createBlockedMcpResult(
  summary: string,
  blocker: string,
  evidenceRefs: readonly string[] = [],
): OpenSlackMcpResult {
  return createOpenSlackMcpResult({
    status: 'blocked',
    summary,
    governance: { blocker },
    evidenceRefs,
  });
}

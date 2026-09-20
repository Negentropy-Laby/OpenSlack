export interface CleanupTaskLink {
  schema: 'openslack.task_link.v1';
  issue_number: number;
  agent_id: string;
  task_id: string;
  run_id: string;
  claim_ref: string;
}

export type CleanupTaskLinkResult =
  | { state: 'ABSENT' }
  | { state: 'INVALID' }
  | { state: 'VALID'; metadata: CleanupTaskLink };

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** The marker is untrusted association evidence, not an authorization token. */
export function parseTaskLinkMarker(body: string | undefined): CleanupTaskLinkResult {
  if (!body?.includes('openslack-task-link')) return { state: 'ABSENT' };
  if (body.length > 1024 * 1024) return { state: 'INVALID' };
  if (body.split('openslack-task-link').length !== 2) return { state: 'INVALID' };
  const match = body.match(/<!--\s*openslack-task-link\s*([\s\S]*?)-->/);
  if (!match) return { state: 'INVALID' };
  try {
    const value: unknown = JSON.parse(match[1]);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'INVALID' };
    const m = value as Partial<CleanupTaskLink>;
    if (
      m.schema !== 'openslack.task_link.v1' ||
      !Number.isSafeInteger(m.issue_number) ||
      (m.issue_number ?? 0) <= 0 ||
      ![m.agent_id, m.task_id, m.run_id].every(
        (s) => typeof s === 'string' && identifier.test(s),
      ) ||
      m.claim_ref !== `refs/heads/openslack/claims/issue-${m.issue_number}`
    )
      return { state: 'INVALID' };
    return { state: 'VALID', metadata: m as CleanupTaskLink };
  } catch {
    return { state: 'INVALID' };
  }
}

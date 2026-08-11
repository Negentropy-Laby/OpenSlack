import { createHash } from 'node:crypto';

export type CanonicalIssueState = 'open' | 'closed' | 'unknown';

export interface IssueTaskSnapshotInput {
  issueNumber: number;
  issueNodeId: string;
  state: CanonicalIssueState;
  labels: readonly string[];
  body: string;
  updatedAt: string;
}

export interface IssueTaskSnapshot {
  schema: 'openslack.issue_task_snapshot.v1';
  issueNumber: number;
  issueNodeId: string;
  updatedAt: string;
  sha256: string;
}

function canonicalSnapshotPayload(input: IssueTaskSnapshotInput): string {
  return JSON.stringify({
    schema: 'openslack.issue_task_snapshot.v1',
    issue_number: input.issueNumber,
    issue_node_id: input.issueNodeId,
    state: input.state,
    labels: [...input.labels].sort(),
    body: input.body,
    updated_at: input.updatedAt,
  });
}

export function createIssueTaskSnapshot(input: IssueTaskSnapshotInput): IssueTaskSnapshot {
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0) {
    throw new Error('Issue number must be a positive integer.');
  }
  if (!input.issueNodeId || !Number.isFinite(Date.parse(input.updatedAt))) {
    throw new Error('Issue task snapshot requires a node identity and valid updatedAt timestamp.');
  }
  return {
    schema: 'openslack.issue_task_snapshot.v1',
    issueNumber: input.issueNumber,
    issueNodeId: input.issueNodeId,
    updatedAt: input.updatedAt,
    sha256: createHash('sha256').update(canonicalSnapshotPayload(input)).digest('hex'),
  };
}

export function issueTaskSnapshotMatches(
  expected: IssueTaskSnapshot,
  current: IssueTaskSnapshotInput,
): boolean {
  const observed = createIssueTaskSnapshot(current);
  return (
    expected.schema === observed.schema &&
    expected.issueNumber === observed.issueNumber &&
    expected.issueNodeId === observed.issueNodeId &&
    expected.updatedAt === observed.updatedAt &&
    expected.sha256 === observed.sha256
  );
}

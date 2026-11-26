import { decodeStrictJSON } from './strict-json.js';

export interface TaskLinkMetadata {
  schema: 'openslack.task_link.v1';
  issue_number: number;
  agent_id: string;
  task_id: string;
  run_id: string;
  claim_ref: string;
}

export type TaskLinkResult =
  | { state: 'ABSENT' }
  | { state: 'INVALID' }
  | { state: 'VALID'; metadata: TaskLinkMetadata };

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** The producer writes a standalone HTML comment. Markdown examples have no task authority. */
function taskLinkComments(body: string): string[] {
  let fence: string | undefined;
  let comment: string[] | undefined;
  let inOtherComment = false;
  const markers: string[] = [];
  for (const line of body.split(/\r?\n/u)) {
    if (inOtherComment) {
      if (line.includes('-->')) inOtherComment = false;
      continue;
    }
    if (comment) {
      comment.push(line);
      if (line.includes('-->')) {
        markers.push(comment.join('\n'));
        comment = undefined;
      }
      continue;
    }
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (
        delimiter &&
        delimiter[1][0] === fence[0] &&
        delimiter[1].length >= fence.length &&
        delimiter[2].trim() === ''
      )
        fence = undefined;
      continue;
    }
    if (delimiter) {
      fence = delimiter[1];
      continue;
    }
    if (!/^ {0,3}<!--\s*openslack-task-link(?=\s|\{|-->|$)/u.test(line)) {
      inOtherComment = /^ {0,3}<!--/u.test(line) && !line.includes('-->');
      continue;
    }
    if (line.includes('-->')) markers.push(line);
    else comment = [line];
  }
  if (comment) markers.push(comment.join('\n'));
  return markers;
}

/** The marker is untrusted association evidence, not an authorization token. */
export function parseTaskLinkMarker(body: string | null | undefined): TaskLinkResult {
  if (!body?.includes('openslack-task-link')) return { state: 'ABSENT' };
  if (body.length > 1024 * 1024) return { state: 'INVALID' };
  const comments = taskLinkComments(body);
  if (comments.length === 0) return { state: 'ABSENT' };
  if (comments.length !== 1) return { state: 'INVALID' };
  const match = comments[0].match(/^ {0,3}<!--\s*openslack-task-link\s*([\s\S]*?)-->\s*$/u);
  if (!match) return { state: 'INVALID' };
  try {
    const value = decodeStrictJSON(match[1], 16 * 1024);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'INVALID' };
    const m = value as Partial<TaskLinkMetadata>;
    if (
      m.schema !== 'openslack.task_link.v1' ||
      !Number.isSafeInteger(m.issue_number) ||
      (m.issue_number ?? 0) <= 0 ||
      ![m.agent_id, m.task_id, m.run_id].every(
        (s) => typeof s === 'string' && identifier.test(s),
      ) ||
      m.claim_ref !== issueClaimRef(m.issue_number!, 'canonical')
    )
      return { state: 'INVALID' };
    return { state: 'VALID', metadata: m as TaskLinkMetadata };
  } catch {
    return { state: 'INVALID' };
  }
}

/** API refs omit refs/, while association evidence uses the canonical form. */
export function issueClaimRef(issueNumber: number, format: 'api' | 'canonical' = 'api'): string {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1)
    throw new TypeError('ISSUE_CLAIM_REF_INVALID');
  return `${format === 'canonical' ? 'refs/' : ''}heads/openslack/claims/issue-${issueNumber}`;
}

export function isReservedCleanupBranch(branch: string, defaultBranch?: string): boolean {
  return (
    branch === 'main' ||
    branch === defaultBranch ||
    /^openslack\/(?:claims|probes)(?:\/|$)/.test(branch)
  );
}

/** Git ref syntax shared by evidence and transport; supports plus and Unicode. */
export function isValidCleanupBranch(branch: string): boolean {
  return (
    typeof branch === 'string' &&
    Buffer.byteLength(branch, 'utf8') > 0 &&
    Buffer.byteLength(branch, 'utf8') <= 1024 &&
    Buffer.from(branch).toString('utf8') === branch &&
    !/[\x00-\x20\x7f~^:?*\[\\]/.test(branch) &&
    !branch.includes('..') &&
    !branch.includes('@{') &&
    !branch.endsWith('.') &&
    !branch.startsWith('-') &&
    branch
      .split('/')
      .every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'))
  );
}

export function isFullGitObjectId(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

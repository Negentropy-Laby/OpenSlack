import { parse as parseYaml } from 'yaml';

export interface IssueTaskManifest {
  schema: string;
  task_id: string;
  title: string;
  status: 'ready' | 'claimed' | 'running' | 'review' | 'done' | 'blocked';
  task_type?: string;
  agent_type: string;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  priority?: 'p0' | 'p1' | 'p2' | 'p3';
  required_capabilities?: string[];
  allowed_paths?: string[];
  forbidden_paths?: string[];
  output_contract?: Array<
    'draft_pr' | 'issue_comment_summary' | 'workspace_run_record' | 'no_change'
  >;
  success_criteria?: string[];
  human_approval_required_for?: Array<
    'red_zone_change' | 'merge_main' | 'external_message' | 'policy_change'
  >;
  lease?: { ttl_minutes: number; heartbeat_minutes: number };
  idempotency_key?: string;
  linked_pr?: number;
}

export interface ManifestParseResult {
  valid: boolean;
  manifest?: IssueTaskManifest;
  errors: string[];
}

const VALID_STATUSES = ['ready', 'claimed', 'running', 'review', 'done', 'blocked'] as const;
const VALID_RISKS = ['low', 'medium', 'high', 'critical'] as const;
const VALID_PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;
const VALID_OUTPUTS = [
  'draft_pr',
  'issue_comment_summary',
  'workspace_run_record',
  'no_change',
] as const;
const VALID_APPROVALS = [
  'red_zone_change',
  'merge_main',
  'external_message',
  'policy_change',
] as const;

function readStringArray(
  record: Record<string, unknown>,
  field: string,
  errors: string[],
  options: { readonly allowed?: readonly string[]; readonly unique?: boolean } = {},
): string[] {
  const value = record[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of strings`);
    return [];
  }

  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      errors.push(`${field} must contain only strings`);
      continue;
    }
    if (options.allowed && !options.allowed.includes(entry)) {
      errors.push(`${field} contains unsupported value: "${entry}"`);
      continue;
    }
    result.push(entry);
  }
  if (options.unique && new Set(result).size !== result.length) {
    errors.push(`${field} must not contain duplicate values`);
  }
  return result;
}

function readLease(
  record: Record<string, unknown>,
  errors: string[],
): IssueTaskManifest['lease'] | undefined {
  if (record.lease === undefined) return undefined;
  if (!record.lease || typeof record.lease !== 'object' || Array.isArray(record.lease)) {
    errors.push('lease must be an object');
    return undefined;
  }

  const lease = record.lease as Record<string, unknown>;
  const unexpectedKeys = Object.keys(lease).filter(
    (key) => key !== 'ttl_minutes' && key !== 'heartbeat_minutes',
  );
  if (unexpectedKeys.length > 0) {
    errors.push(`lease contains unsupported properties: ${unexpectedKeys.join(', ')}`);
  }
  const ttlMinutes = lease.ttl_minutes;
  const heartbeatMinutes = lease.heartbeat_minutes;
  if (!Number.isInteger(ttlMinutes) || (ttlMinutes as number) < 1 || (ttlMinutes as number) > 480) {
    errors.push('lease.ttl_minutes must be an integer between 1 and 480');
  }
  if (
    !Number.isInteger(heartbeatMinutes) ||
    (heartbeatMinutes as number) < 1 ||
    (heartbeatMinutes as number) > 120
  ) {
    errors.push('lease.heartbeat_minutes must be an integer between 1 and 120');
  }
  if (
    !Number.isInteger(ttlMinutes) ||
    !Number.isInteger(heartbeatMinutes) ||
    (ttlMinutes as number) < 1 ||
    (ttlMinutes as number) > 480 ||
    (heartbeatMinutes as number) < 1 ||
    (heartbeatMinutes as number) > 120
  ) {
    return undefined;
  }
  return { ttl_minutes: ttlMinutes as number, heartbeat_minutes: heartbeatMinutes as number };
}

export function extractTaskBlock(body: string): string | null {
  // Match ```openslack-task ... ``` blocks
  const match = body.match(/```openslack-task\s*\n([\s\S]*?)\n```/);
  if (match) return match[1];

  // Fallback: try ```yaml ... ``` with schema frontmatter check
  const yamlMatch = body.match(/```yaml\s*\n([\s\S]*?)\n```/);
  if (yamlMatch && yamlMatch[1].includes('schema: openslack.github_issue_task.v1')) {
    return yamlMatch[1];
  }

  return null;
}

export function parseIssueTaskManifest(body: string): ManifestParseResult {
  const errors: string[] = [];
  const yamlBlock = extractTaskBlock(body);

  if (!yamlBlock) {
    return { valid: false, errors: ['No openslack-task block found in issue body'] };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBlock);
  } catch (e) {
    return { valid: false, errors: [`YAML parse error: ${(e as Error).message}`] };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, errors: ['Parsed YAML is not an object'] };
  }

  const m = parsed as Record<string, unknown>;

  // Required fields
  if (m.schema !== 'openslack.github_issue_task.v1') {
    errors.push(`Invalid schema: "${String(m.schema)}". Expected "openslack.github_issue_task.v1"`);
  }
  if (typeof m.task_id !== 'string' || !m.task_id.match(/^TASK-\d{4}-\d{6}$/)) {
    errors.push(`Invalid task_id: "${String(m.task_id)}". Must match TASK-YYYY-NNNNNN`);
  }
  if (typeof m.title !== 'string' || m.title.length === 0) {
    errors.push('title is required and must be a non-empty string');
  }
  if (typeof m.agent_type !== 'string' || m.agent_type.length === 0) {
    errors.push('agent_type is required and must be a non-empty string');
  }
  if (typeof m.status !== 'string' || !VALID_STATUSES.includes(m.status as never)) {
    errors.push(`status must be one of: ${VALID_STATUSES.join(', ')}. Got: "${String(m.status)}"`);
  }
  if (m.task_type !== undefined && typeof m.task_type !== 'string') {
    errors.push('task_type must be a string');
  }
  if (typeof m.risk_level !== 'string' || !VALID_RISKS.includes(m.risk_level as never)) {
    errors.push(
      `risk_level must be one of: ${VALID_RISKS.join(', ')}. Got: "${String(m.risk_level)}"`,
    );
  }
  if (m.priority !== undefined && !VALID_PRIORITIES.includes(m.priority as never)) {
    errors.push(`priority must be one of: ${VALID_PRIORITIES.join(', ')}`);
  }

  const requiredCapabilities = readStringArray(m, 'required_capabilities', errors, {
    unique: true,
  });
  const allowed = readStringArray(m, 'allowed_paths', errors, { unique: true });
  const forbidden = readStringArray(m, 'forbidden_paths', errors, { unique: true });
  const outputContract = readStringArray(m, 'output_contract', errors, {
    allowed: VALID_OUTPUTS,
    unique: true,
  }) as IssueTaskManifest['output_contract'];
  const successCriteria = readStringArray(m, 'success_criteria', errors);
  const humanApprovalRequiredFor = readStringArray(m, 'human_approval_required_for', errors, {
    allowed: VALID_APPROVALS,
  }) as IssueTaskManifest['human_approval_required_for'];
  const lease = readLease(m, errors);
  if (m.idempotency_key !== undefined && typeof m.idempotency_key !== 'string') {
    errors.push('idempotency_key must be a string');
  }
  if (m.linked_pr !== undefined && !Number.isInteger(m.linked_pr)) {
    errors.push('linked_pr must be an integer');
  }

  // Path conflict check
  for (const ap of allowed) {
    for (const fp of forbidden) {
      if (
        ap === fp ||
        ap.startsWith(fp.replace(/\*\*$/, '')) ||
        fp.startsWith(ap.replace(/\*\*$/, ''))
      ) {
        errors.push(`Path conflict: allowed_path "${ap}" conflicts with forbidden_path "${fp}"`);
      }
    }
  }

  // Red Zone check on allowed_paths
  const redZonePrefixes = [
    '.github/',
    '.openslack/policies/',
    '.openslack/agents/',
    '.openslack/self/constitution',
    '.openslack/self/invariants',
    'packages/kernel/src/',
    'packages/self-evolution/src/core/',
  ];
  for (const ap of allowed) {
    for (const rz of redZonePrefixes) {
      if (ap.startsWith(rz.replace(/\/\*\*$/, '')) || ap === rz) {
        const hasRedZoneApproval = humanApprovalRequiredFor?.includes('red_zone_change') === true;
        if (!hasRedZoneApproval) {
          errors.push(
            `Red Zone path "${ap}" requires human_approval_required_for: [red_zone_change]`,
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    manifest: {
      schema: m.schema as string,
      task_id: m.task_id as string,
      title: m.title as string,
      status: m.status as IssueTaskManifest['status'],
      task_type: m.task_type as string | undefined,
      agent_type: m.agent_type as string,
      risk_level: m.risk_level as IssueTaskManifest['risk_level'],
      priority: m.priority as IssueTaskManifest['priority'],
      required_capabilities: requiredCapabilities.length > 0 ? requiredCapabilities : undefined,
      allowed_paths: allowed.length > 0 ? allowed : undefined,
      forbidden_paths: forbidden.length > 0 ? forbidden : undefined,
      output_contract: outputContract && outputContract.length > 0 ? outputContract : undefined,
      success_criteria: successCriteria.length > 0 ? successCriteria : undefined,
      human_approval_required_for:
        humanApprovalRequiredFor && humanApprovalRequiredFor.length > 0
          ? humanApprovalRequiredFor
          : undefined,
      lease,
      idempotency_key: m.idempotency_key as string | undefined,
      linked_pr: m.linked_pr as number | undefined,
    },
    errors: [],
  };
}

export function renderIssueTaskManifest(manifest: IssueTaskManifest): string {
  const lines: string[] = ['```openslack-task'];
  const scalar = (value: string): string =>
    /^[*[\]{}&!#|>%@`"'?:-]/.test(value) || value.includes(': ') ? JSON.stringify(value) : value;
  lines.push(`schema: ${scalar(manifest.schema)}`);
  lines.push(`task_id: ${scalar(manifest.task_id)}`);
  lines.push(`title: ${scalar(manifest.title)}`);
  lines.push(`status: ${manifest.status}`);
  if (manifest.task_type) lines.push(`task_type: ${scalar(manifest.task_type)}`);
  lines.push(`agent_type: ${scalar(manifest.agent_type)}`);
  lines.push(`risk_level: ${manifest.risk_level}`);
  if (manifest.priority) lines.push(`priority: ${manifest.priority}`);

  if (manifest.required_capabilities?.length) {
    lines.push('required_capabilities:');
    for (const c of manifest.required_capabilities) lines.push(`  - ${scalar(c)}`);
  }
  if (manifest.allowed_paths?.length) {
    lines.push('allowed_paths:');
    for (const p of manifest.allowed_paths) lines.push(`  - ${scalar(p)}`);
  }
  if (manifest.forbidden_paths?.length) {
    lines.push('forbidden_paths:');
    for (const p of manifest.forbidden_paths) lines.push(`  - ${scalar(p)}`);
  }
  if (manifest.output_contract?.length) {
    lines.push('output_contract:');
    for (const o of manifest.output_contract) lines.push(`  - ${o}`);
  }
  if (manifest.success_criteria?.length) {
    lines.push('success_criteria:');
    for (const s of manifest.success_criteria) lines.push(`  - ${scalar(s)}`);
  }
  if (manifest.human_approval_required_for?.length) {
    lines.push('human_approval_required_for:');
    for (const h of manifest.human_approval_required_for) lines.push(`  - ${h}`);
  }
  if (manifest.lease) {
    lines.push('lease:');
    lines.push(`  ttl_minutes: ${manifest.lease.ttl_minutes}`);
    lines.push(`  heartbeat_minutes: ${manifest.lease.heartbeat_minutes}`);
  }
  if (manifest.idempotency_key) lines.push(`idempotency_key: ${scalar(manifest.idempotency_key)}`);
  if (manifest.linked_pr) lines.push(`linked_pr: ${manifest.linked_pr}`);
  lines.push('```');
  return lines.join('\n');
}

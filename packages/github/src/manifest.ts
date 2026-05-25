import { parse as parseYaml } from 'yaml';
import taskManifestSchema from './task-manifest.schema.json' with { type: 'json' };

export interface IssueTaskManifest {
  schema: string;
  task_id: string;
  title: string;
  status?: 'ready' | 'claimed' | 'running' | 'review' | 'done' | 'blocked';
  task_type?: string;
  agent_type: string;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  priority?: 'p0' | 'p1' | 'p2' | 'p3';
  required_capabilities?: string[];
  allowed_paths?: string[];
  forbidden_paths?: string[];
  output_contract?: Array<'draft_pr' | 'issue_comment_summary' | 'workspace_run_record' | 'no_change'>;
  success_criteria?: string[];
  human_approval_required_for?: Array<'red_zone_change' | 'merge_main' | 'external_message' | 'policy_change'>;
  lease?: { ttl_minutes: number; heartbeat_minutes: number };
  idempotency_key?: string;
  linked_pr?: number;
}

export interface ManifestParseResult {
  valid: boolean;
  manifest?: IssueTaskManifest;
  errors: string[];
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
  const validRisks = ['low', 'medium', 'high', 'critical'];
  if (typeof m.risk_level !== 'string' || !validRisks.includes(m.risk_level)) {
    errors.push(`risk_level must be one of: ${validRisks.join(', ')}. Got: "${String(m.risk_level)}"`);
  }

  // Path conflict check
  const allowed = (Array.isArray(m.allowed_paths) ? m.allowed_paths : []) as string[];
  const forbidden = (Array.isArray(m.forbidden_paths) ? m.forbidden_paths : []) as string[];
  for (const ap of allowed) {
    for (const fp of forbidden) {
      if (ap === fp || ap.startsWith(fp.replace(/\*\*$/, '')) || fp.startsWith(ap.replace(/\*\*$/, ''))) {
        errors.push(`Path conflict: allowed_path "${ap}" conflicts with forbidden_path "${fp}"`);
      }
    }
  }

  // Red Zone check on allowed_paths
  const redZonePrefixes = ['.github/', '.openslack/policies/', '.openslack/agents/', '.openslack/self/constitution', '.openslack/self/invariants', 'packages/kernel/src/', 'packages/self-evolution/src/core/'];
  for (const ap of allowed) {
    for (const rz of redZonePrefixes) {
      if (ap.startsWith(rz.replace(/\/\*\*$/, '')) || ap === rz) {
        const hasRedZoneApproval = Array.isArray(m.human_approval_required_for) && m.human_approval_required_for.includes('red_zone_change');
        if (!hasRedZoneApproval) {
          errors.push(`Red Zone path "${ap}" requires human_approval_required_for: [red_zone_change]`);
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
      required_capabilities: Array.isArray(m.required_capabilities) ? m.required_capabilities : undefined,
      allowed_paths: allowed.length > 0 ? allowed : undefined,
      forbidden_paths: forbidden.length > 0 ? forbidden : undefined,
      output_contract: Array.isArray(m.output_contract) ? m.output_contract as IssueTaskManifest['output_contract'] : undefined,
      success_criteria: Array.isArray(m.success_criteria) ? m.success_criteria : undefined,
      human_approval_required_for: Array.isArray(m.human_approval_required_for) ? m.human_approval_required_for as IssueTaskManifest['human_approval_required_for'] : undefined,
      lease: m.lease as IssueTaskManifest['lease'],
      idempotency_key: m.idempotency_key as string | undefined,
      linked_pr: m.linked_pr as number | undefined,
    },
    errors: [],
  };
}

export function renderIssueTaskManifest(manifest: IssueTaskManifest): string {
  const lines: string[] = ['```openslack-task'];
  const scalar = (value: string): string =>
    /^[*[\]{}&!#|>%@`"'?:-]/.test(value) || value.includes(': ')
      ? JSON.stringify(value)
      : value;
  lines.push(`schema: ${scalar(manifest.schema)}`);
  lines.push(`task_id: ${scalar(manifest.task_id)}`);
  lines.push(`title: ${scalar(manifest.title)}`);
  if (manifest.status) lines.push(`status: ${manifest.status}`);
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

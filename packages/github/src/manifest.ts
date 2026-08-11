import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import { classifyDeclaredScopes, pathGlobCovers, type TaskRiskLevel } from '@openslack/kernel';
import taskManifestSchema from './task-manifest.schema.json' with { type: 'json' };

export interface IssueTaskManifest {
  schema: string;
  task_id: string;
  title: string;
  status: 'ready' | 'claimed' | 'running' | 'review' | 'done' | 'blocked';
  task_type?: string;
  agent_type: GitHubAgentType;
  risk_level: TaskRiskLevel;
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

export const GITHUB_AGENT_TYPES = ['codex', 'reviewer', 'sync', 'memory'] as const;
export type GitHubAgentType = (typeof GITHUB_AGENT_TYPES)[number];

export function isGitHubAgentType(value: unknown): value is GitHubAgentType {
  return typeof value === 'string' && (GITHUB_AGENT_TYPES as readonly string[]).includes(value);
}

export interface ManifestParseResult {
  valid: boolean;
  manifest?: IssueTaskManifest;
  errors: string[];
}

const validateTaskManifest = new Ajv2020({ allErrors: true, strict: true }).compile(
  taskManifestSchema,
);

function schemaField(error: ErrorObject): string {
  const segments = error.instancePath.split('/').filter(Boolean);
  return segments[0] ?? 'manifest';
}

function formatSchemaError(error: ErrorObject): string {
  const field = schemaField(error);
  const path = error.instancePath.slice(1).replaceAll('/', '.');
  if (error.keyword === 'required') {
    return `${String(error.params.missingProperty)} is required`;
  }
  if (error.keyword === 'enum') {
    const values = (error.params.allowedValues as unknown[]).map(String).join(', ');
    return `${field} must be one of: ${values}`;
  }
  if (error.keyword === 'additionalProperties') {
    return `${field} contains unsupported properties: ${String(error.params.additionalProperty)}`;
  }
  if (error.keyword === 'type') {
    if (
      (field === 'required_capabilities' ||
        field === 'allowed_paths' ||
        field === 'forbidden_paths' ||
        field === 'output_contract' ||
        field === 'success_criteria' ||
        field === 'human_approval_required_for') &&
      error.params.type === 'array'
    ) {
      return `${field} must be an array of strings`;
    }
    if (error.instancePath.split('/').filter(Boolean).length > 1) {
      return `${path} must be ${String(error.params.type)}`;
    }
    return `${field} must be ${String(error.params.type)}`;
  }
  if (error.keyword === 'uniqueItems') return `${field} must not contain duplicate values`;
  if (error.keyword === 'minimum' || error.keyword === 'maximum') {
    return `${path} ${error.message ?? 'is out of range'}`;
  }
  if (error.keyword === 'pattern') return `${field} ${error.message ?? 'has an invalid format'}`;
  if (error.keyword === 'minLength') return `${field} must be a non-empty string`;
  if (error.keyword === 'const') return `${field} ${error.message ?? 'has an invalid value'}`;
  return `${path || 'manifest'} ${error.message ?? 'is invalid'}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'unknown error';
}

export function extractTaskBlock(body: string): string | null {
  const match = body.match(/```openslack-task\s*\n([\s\S]*?)\n```/);
  if (match) return match[1];

  const yamlMatch = body.match(/```yaml\s*\n([\s\S]*?)\n```/);
  if (yamlMatch && yamlMatch[1].includes('schema: openslack.github_issue_task.v1')) {
    return yamlMatch[1];
  }

  return null;
}

export function parseIssueTaskManifest(body: string): ManifestParseResult {
  const yamlBlock = extractTaskBlock(body);
  if (!yamlBlock) {
    return { valid: false, errors: ['No openslack-task block found in issue body'] };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBlock);
  } catch (error) {
    return { valid: false, errors: [`YAML parse error: ${errorMessage(error)}`] };
  }

  if (!validateTaskManifest(parsed)) {
    return {
      valid: false,
      errors: (validateTaskManifest.errors ?? []).map(formatSchemaError),
    };
  }

  const manifest = parsed as unknown as IssueTaskManifest;
  const errors: string[] = [];
  const allowedPaths = manifest.allowed_paths ?? [];
  const forbiddenPaths = manifest.forbidden_paths ?? [];

  for (const allowedPath of allowedPaths) {
    for (const forbiddenPath of forbiddenPaths) {
      if (pathGlobCovers(forbiddenPath, allowedPath)) {
        errors.push(
          `Path conflict: allowed_path "${allowedPath}" conflicts with forbidden_path "${forbiddenPath}"`,
        );
      }
    }
  }

  for (const allowedPath of allowedPaths) {
    const zone = classifyDeclaredScopes([allowedPath]);
    if (zone === 'black') {
      errors.push(`Black Zone path "${allowedPath}" is prohibited`);
    } else if (
      zone === 'red' &&
      !manifest.human_approval_required_for?.includes('red_zone_change')
    ) {
      errors.push(
        `Red Zone path "${allowedPath}" requires human_approval_required_for: [red_zone_change]`,
      );
    }
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    manifest: {
      ...manifest,
      required_capabilities: manifest.required_capabilities
        ? [...manifest.required_capabilities]
        : undefined,
      allowed_paths: manifest.allowed_paths ? [...manifest.allowed_paths] : undefined,
      forbidden_paths: manifest.forbidden_paths ? [...manifest.forbidden_paths] : undefined,
      output_contract: manifest.output_contract ? [...manifest.output_contract] : undefined,
      success_criteria: manifest.success_criteria ? [...manifest.success_criteria] : undefined,
      human_approval_required_for: manifest.human_approval_required_for
        ? [...manifest.human_approval_required_for]
        : undefined,
      lease: manifest.lease ? { ...manifest.lease } : undefined,
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
    for (const capability of manifest.required_capabilities)
      lines.push(`  - ${scalar(capability)}`);
  }
  if (manifest.allowed_paths?.length) {
    lines.push('allowed_paths:');
    for (const path of manifest.allowed_paths) lines.push(`  - ${scalar(path)}`);
  }
  if (manifest.forbidden_paths?.length) {
    lines.push('forbidden_paths:');
    for (const path of manifest.forbidden_paths) lines.push(`  - ${scalar(path)}`);
  }
  if (manifest.output_contract?.length) {
    lines.push('output_contract:');
    for (const output of manifest.output_contract) lines.push(`  - ${output}`);
  }
  if (manifest.success_criteria?.length) {
    lines.push('success_criteria:');
    for (const criterion of manifest.success_criteria) lines.push(`  - ${scalar(criterion)}`);
  }
  if (manifest.human_approval_required_for?.length) {
    lines.push('human_approval_required_for:');
    for (const approval of manifest.human_approval_required_for) lines.push(`  - ${approval}`);
  }
  if (manifest.lease) {
    lines.push('lease:');
    lines.push(`  ttl_minutes: ${manifest.lease.ttl_minutes}`);
    lines.push(`  heartbeat_minutes: ${manifest.lease.heartbeat_minutes}`);
  }
  if (manifest.idempotency_key) lines.push(`idempotency_key: ${scalar(manifest.idempotency_key)}`);
  if (manifest.linked_pr !== undefined) lines.push(`linked_pr: ${manifest.linked_pr}`);
  lines.push('```');
  return lines.join('\n');
}

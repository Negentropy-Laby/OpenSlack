import { classifyPaths, type RiskZone } from '@openslack/kernel';
import { createTaskIssue } from './issue-tasks.js';
import {
  parseIssueTaskManifest,
  renderIssueTaskManifest,
  type IssueTaskManifest,
} from './manifest.js';

export type TaskTemplateKind =
  | 'bugfix'
  | 'docs'
  | 'test-fix'
  | 'refactor'
  | 'review'
  | 'investigation';

export interface TaskCreationInput {
  template: TaskTemplateKind;
  title: string;
  description?: string;
  agentType?: string;
  priority?: IssueTaskManifest['priority'];
  riskLevel?: IssueTaskManifest['risk_level'];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  requiredCapabilities?: string[];
  outputContract?: IssueTaskManifest['output_contract'];
  successCriteria?: string[];
  humanApprovalRequiredFor?: IssueTaskManifest['human_approval_required_for'];
}

export interface TaskCreationPreview {
  issueTitle: string;
  labels: string[];
  body: string;
  manifest: IssueTaskManifest;
  riskZone: RiskZone;
  agentMatchingHint: string;
  errors: string[];
}

export interface TaskCreationResult extends TaskCreationPreview {
  created: boolean;
  issueNumber?: number;
  url?: string;
  nodeId?: string;
}

const DEFAULT_FORBIDDEN_PATHS = ['.env', '*.pem', '*.key', 'secrets/**', 'credentials/**'];

interface TaskTemplateDefaults {
  template: TaskTemplateKind;
  agentType: string;
  priority: IssueTaskManifest['priority'];
  riskLevel: IssueTaskManifest['risk_level'];
  allowedPaths: string[];
  forbiddenPaths: string[];
  requiredCapabilities: string[];
  outputContract: IssueTaskManifest['output_contract'];
  successCriteria: string[];
  humanApprovalRequiredFor?: IssueTaskManifest['human_approval_required_for'];
}

const TEMPLATE_DEFAULTS: Record<TaskTemplateKind, TaskTemplateDefaults> = {
  bugfix: {
    template: 'bugfix',
    agentType: 'codex',
    priority: 'p1',
    riskLevel: 'medium',
    allowedPaths: ['apps/**', 'packages/**', 'docs/**'],
    forbiddenPaths: DEFAULT_FORBIDDEN_PATHS,
    requiredCapabilities: ['typescript', 'testing'],
    outputContract: ['draft_pr', 'workspace_run_record'],
    successCriteria: ['Bug is reproduced or explained', 'Fix is covered by a focused test'],
  },
  docs: {
    template: 'docs',
    agentType: 'codex',
    priority: 'p2',
    riskLevel: 'low',
    allowedPaths: ['docs/**', 'README.md'],
    forbiddenPaths: DEFAULT_FORBIDDEN_PATHS,
    requiredCapabilities: ['documentation'],
    outputContract: ['draft_pr'],
    successCriteria: ['Documentation matches current implementation'],
  },
  'test-fix': {
    template: 'test-fix',
    agentType: 'codex',
    priority: 'p1',
    riskLevel: 'medium',
    allowedPaths: ['apps/**', 'packages/**'],
    forbiddenPaths: DEFAULT_FORBIDDEN_PATHS,
    requiredCapabilities: ['typescript', 'testing'],
    outputContract: ['draft_pr', 'workspace_run_record'],
    successCriteria: ['Failing test is fixed without weakening coverage'],
  },
  refactor: {
    template: 'refactor',
    agentType: 'codex',
    priority: 'p2',
    riskLevel: 'medium',
    allowedPaths: ['apps/**', 'packages/**'],
    forbiddenPaths: DEFAULT_FORBIDDEN_PATHS,
    requiredCapabilities: ['typescript', 'architecture'],
    outputContract: ['draft_pr', 'workspace_run_record'],
    successCriteria: ['Behavior is preserved', 'Relevant tests still pass'],
  },
  review: {
    template: 'review',
    agentType: 'codex',
    priority: 'p2',
    riskLevel: 'low',
    allowedPaths: ['docs/**', 'packages/**', 'apps/**'],
    forbiddenPaths: DEFAULT_FORBIDDEN_PATHS,
    requiredCapabilities: ['code-review'],
    outputContract: ['issue_comment_summary', 'no_change'],
    successCriteria: ['Findings are grounded in file and line evidence'],
  },
  investigation: {
    template: 'investigation',
    agentType: 'codex',
    priority: 'p2',
    riskLevel: 'low',
    allowedPaths: ['docs/**', 'packages/**', 'apps/**'],
    forbiddenPaths: DEFAULT_FORBIDDEN_PATHS,
    requiredCapabilities: ['investigation'],
    outputContract: ['issue_comment_summary', 'no_change'],
    successCriteria: [
      'Current state is documented with evidence',
      'Recommended next action is explicit',
    ],
  },
};

function generateTaskId(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const suffix = Math.floor(now.getTime() % 1_000_000)
    .toString()
    .padStart(6, '0');
  return `TASK-${year}-${suffix}`;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => v.trim().length > 0)));
}

function zoneToRiskLevel(zone: RiskZone): IssueTaskManifest['risk_level'] {
  if (zone === 'black') return 'critical';
  if (zone === 'red') return 'high';
  if (zone === 'yellow') return 'medium';
  return 'low';
}

function buildAgentHint(agentType: string, capabilities: string[]): string {
  const caps = capabilities.length > 0 ? capabilities.join(', ') : 'none';
  return `Matches agents with type "${agentType}" and capabilities: ${caps}.`;
}

export function previewTaskCreation(input: TaskCreationInput): TaskCreationPreview {
  const defaults = TEMPLATE_DEFAULTS[input.template];
  const errors: string[] = [];

  if (!defaults) {
    return {
      issueTitle: input.title || 'Invalid task',
      labels: [],
      body: '',
      manifest: {
        schema: 'openslack.github_issue_task.v1',
        task_id: generateTaskId(),
        title: input.title || 'Invalid task',
        agent_type: input.agentType || 'codex',
        risk_level: 'low',
      },
      riskZone: 'green',
      agentMatchingHint: '',
      errors: [`Unknown template: ${input.template}`],
    };
  }

  if (!input.title || input.title.trim().length === 0) {
    errors.push('Task title is required.');
  }

  const allowedPaths = unique(input.allowedPaths ?? defaults.allowedPaths);
  const forbiddenPaths = unique(input.forbiddenPaths ?? defaults.forbiddenPaths);
  const requiredCapabilities = unique(input.requiredCapabilities ?? defaults.requiredCapabilities);
  const riskZone = classifyPaths(allowedPaths.length > 0 ? allowedPaths : ['docs/**']);
  const humanApprovalRequiredFor =
    input.humanApprovalRequiredFor ?? defaults.humanApprovalRequiredFor;

  if (riskZone === 'black') {
    errors.push('Black Zone paths are prohibited and cannot be used for task creation.');
  }

  if (riskZone === 'red' && !humanApprovalRequiredFor?.includes('red_zone_change')) {
    errors.push('Red Zone paths require human_approval_required_for: red_zone_change.');
  }

  const agentType = input.agentType ?? defaults.agentType;
  const manifest: IssueTaskManifest = {
    schema: 'openslack.github_issue_task.v1',
    task_id: generateTaskId(),
    title: input.title,
    status: 'ready',
    task_type: input.template,
    agent_type: agentType,
    risk_level: input.riskLevel ?? zoneToRiskLevel(riskZone),
    priority: input.priority ?? defaults.priority,
    required_capabilities: requiredCapabilities,
    allowed_paths: allowedPaths,
    forbidden_paths: forbiddenPaths,
    output_contract: input.outputContract ?? defaults.outputContract,
    success_criteria: input.successCriteria ?? defaults.successCriteria,
    human_approval_required_for: humanApprovalRequiredFor,
    lease: { ttl_minutes: 120, heartbeat_minutes: 15 },
    idempotency_key: `${input.template}:${input.title.toLowerCase().trim()}`,
  };

  const renderedManifest = renderIssueTaskManifest(manifest);
  const parseResult = parseIssueTaskManifest(renderedManifest);
  if (!parseResult.valid) errors.push(...parseResult.errors);

  const labels = unique([
    'openslack:task',
    'openslack:ready',
    `risk:${manifest.risk_level}`,
    `agent-type:${agentType}`,
    `task-type:${input.template}`,
  ]);

  const body = [
    input.description?.trim() || 'Created by OpenSlack task creation preview.',
    '',
    renderedManifest,
  ].join('\n');

  return {
    issueTitle: input.title,
    labels,
    body,
    manifest,
    riskZone,
    agentMatchingHint: buildAgentHint(agentType, requiredCapabilities),
    errors,
  };
}

export async function createTaskFromPreview(
  preview: TaskCreationPreview,
): Promise<TaskCreationResult> {
  if (preview.errors.length > 0) {
    return { ...preview, created: false };
  }

  const created = await createTaskIssue(preview.issueTitle, preview.body, preview.labels);
  return {
    ...preview,
    created: true,
    issueNumber: created.issueNumber,
    url: created.url,
    nodeId: created.nodeId,
  };
}

import type { Intent, PlanStep, RiskLevel } from './types.js';

export type ToolInputValue = string | number | boolean | undefined;
export type ToolInput = Record<string, ToolInputValue>;

export type RegisteredActionId =
  | 'status.show'
  | 'workspace.status'
  | 'github.metrics'
  | 'workspace.index'
  | 'doctor.run'
  | 'workspace.validate'
  | 'self.eval.golden'
  | 'self.observe'
  | 'governance.audit'
  | 'pr.status'
  | 'pr.doctor'
  | 'pr.review'
  | 'pr.queue'
  | 'pr.watch'
  | 'pr.merge'
  | 'task.create.preview'
  | 'self.triage.create_issues'
  | 'agent.claim_task'
  | 'task.checkout'
  | 'task.sync'
  | 'github.issue_done'
  | 'github.repair.labels.preview'
  | 'github.repair.claims.preview'
  | 'task.repair.worktrees.preview'
  | 'conversation.start'
  | 'conversation.list'
  | 'conversation.show'
  | 'conversation.send'
  | 'conversation.summarize'
  | 'conversation.archive';

type InputType = 'string' | 'number' | 'boolean';

export interface ToolInputField {
  type: InputType;
  required?: boolean;
}

export interface RegisteredAction {
  id: RegisteredActionId;
  description: string;
  inputSchema: Record<string, ToolInputField>;
  riskLevel: RiskLevel;
  sideEffects: boolean;
  confirmationRequired: boolean;
  build: (input: ToolInput, stepId: string) => PlanStep;
  match: (step: PlanStep) => boolean;
}

export interface RegisteredActionCall {
  actionId: string;
  input: ToolInput;
}

function valueMatchesType(value: ToolInputValue, type: InputType): boolean {
  if (value === undefined) return true;
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function str(value: ToolInputValue): string {
  return String(value);
}

function numArg(args: string[], index: number): boolean {
  return args[index] !== undefined && /^\d+$/.test(args[index]);
}

function exact(command: string, args: string[]): (step: PlanStep) => boolean {
  return (step) => step.command === command && step.args.length === args.length && step.args.every((arg, i) => arg === args[i]);
}

function variable(command: string, prefix: string[], requiredArgs: number): (step: PlanStep) => boolean {
  return (step) =>
    step.command === command &&
    step.args.length >= requiredArgs &&
    prefix.every((arg, i) => step.args[i] === arg);
}

export const REGISTERED_ACTIONS: Record<RegisteredActionId, RegisteredAction> = {
  'status.show': {
    id: 'status.show',
    description: 'Show product dashboard',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({ id, actionId: 'status.show', input: {}, tool: 'openslack-cli', command: 'status', args: [], description: 'Show product dashboard', confirmationRequired: false }),
    match: exact('status', []),
  },
  'workspace.status': {
    id: 'workspace.status',
    description: 'Show workspace status',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({ id, actionId: 'workspace.status', input: {}, tool: 'openslack-cli', command: 'workspace', args: ['status'], description: 'Show workspace status', confirmationRequired: false }),
    match: exact('workspace', ['status']),
  },
  'github.metrics': {
    id: 'github.metrics',
    description: 'Show task loop metrics',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({ id, actionId: 'github.metrics', input: {}, tool: 'openslack-cli', command: 'github', args: ['metrics'], description: 'Show task loop metrics', confirmationRequired: false }),
    match: exact('github', ['metrics']),
  },
  'workspace.index': {
    id: 'workspace.index',
    description: 'Build workspace index',
    inputSchema: {},
    riskLevel: 'low',
    sideEffects: true,
    confirmationRequired: false,
    build: (_input, id) => ({ id, actionId: 'workspace.index', input: {}, tool: 'openslack-cli', command: 'workspace', args: ['index'], description: 'Build workspace index', confirmationRequired: false }),
    match: exact('workspace', ['index']),
  },
  'doctor.run': {
    id: 'doctor.run',
    description: 'Run multi-module health check',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({ id, actionId: 'doctor.run', input: {}, tool: 'openslack-cli', command: 'doctor', args: [], description: 'Run multi-module health check', confirmationRequired: false }),
    match: exact('doctor', []),
  },
  'workspace.validate': {
    id: 'workspace.validate',
    description: 'Validate workspace',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({ id, actionId: 'workspace.validate', input: {}, tool: 'openslack-cli', command: 'workspace', args: ['validate'], description: 'Validate workspace', confirmationRequired: false }),
    match: exact('workspace', ['validate']),
  },
  'self.eval.golden': {
    id: 'self.eval.golden',
    description: 'Run golden evals',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({ id, actionId: 'self.eval.golden', input: {}, tool: 'openslack-cli', command: 'self', args: ['eval', '--suite', 'golden'], description: 'Run golden evals', confirmationRequired: false }),
    match: exact('self', ['eval', '--suite', 'golden']),
  },
  'self.observe': {
    id: 'self.observe',
    description: 'Check system health',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({ id, actionId: 'self.observe', input: {}, tool: 'openslack-cli', command: 'self', args: ['observe'], description: 'Check system health', confirmationRequired: false }),
    match: exact('self', ['observe']),
  },
  'governance.audit': {
    id: 'governance.audit',
    description: 'Audit governance compliance',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({ id, actionId: 'governance.audit', input: {}, tool: 'openslack-cli', command: 'governance', args: ['audit'], description: 'Audit governance compliance', confirmationRequired: false }),
    match: exact('governance', ['audit']),
  },
  'pr.status': {
    id: 'pr.status',
    description: 'Show PR status',
    inputSchema: { prNumber: { type: 'number', required: true } },
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (input, id) => ({ id, actionId: 'pr.status', input, tool: 'openslack-cli', command: 'pr', args: ['status', str(input.prNumber)], description: `Show PR #${input.prNumber} status`, confirmationRequired: false }),
    match: (step) => variable('pr', ['status'], 2)(step) && numArg(step.args, 1),
  },
  'pr.doctor': {
    id: 'pr.doctor',
    description: 'Diagnose PR governance',
    inputSchema: { prNumber: { type: 'number', required: true } },
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (input, id) => ({ id, actionId: 'pr.doctor', input, tool: 'openslack-cli', command: 'pr', args: ['doctor', str(input.prNumber)], description: `Diagnose PR #${input.prNumber} governance`, confirmationRequired: false, produces: ['diagnosis'] }),
    match: (step) => variable('pr', ['doctor'], 2)(step) && numArg(step.args, 1),
  },
  'pr.review': {
    id: 'pr.review',
    description: 'Review a PR',
    inputSchema: { prNumber: { type: 'number', required: true } },
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (input, id) => ({ id, actionId: 'pr.review', input, tool: 'openslack-cli', command: 'pr', args: ['review', str(input.prNumber)], description: `Review PR #${input.prNumber}`, confirmationRequired: false }),
    match: (step) => variable('pr', ['review'], 2)(step) && numArg(step.args, 1),
  },
  'pr.queue': {
    id: 'pr.queue',
    description: 'Show PR queue',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({ id, actionId: 'pr.queue', input: {}, tool: 'openslack-cli', command: 'pr', args: ['queue'], description: 'Show PR queue', confirmationRequired: false }),
    match: exact('pr', ['queue']),
  },
  'pr.watch': {
    id: 'pr.watch',
    description: 'Watch a PR until ready',
    inputSchema: { prNumber: { type: 'number', required: true } },
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (input, id) => ({ id, actionId: 'pr.watch', input, tool: 'openslack-cli', command: 'pr', args: ['watch', str(input.prNumber)], description: `Watch PR #${input.prNumber} until ready`, confirmationRequired: false }),
    match: (step) => variable('pr', ['watch'], 2)(step) && numArg(step.args, 1),
  },
  'pr.merge': {
    id: 'pr.merge',
    description: 'Merge a PR after PRMS gates pass',
    inputSchema: { prNumber: { type: 'number', required: true } },
    riskLevel: 'high',
    sideEffects: true,
    confirmationRequired: true,
    build: (input, id) => ({ id, actionId: 'pr.merge', input, tool: 'openslack-cli', command: 'pr', args: ['merge', str(input.prNumber)], description: `Merge PR #${input.prNumber}`, confirmationRequired: true }),
    match: (step) => variable('pr', ['merge'], 2)(step) && numArg(step.args, 1),
  },
  'task.create.preview': {
    id: 'task.create.preview',
    description: 'Preview a GitHub Issue task',
    inputSchema: { title: { type: 'string', required: true }, template: { type: 'string' } },
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (input, id) => ({
      id,
      actionId: 'task.create.preview',
      input,
      tool: 'openslack-cli',
      command: 'task',
      args: ['create', '--template', str(input.template ?? 'investigation'), '--title', str(input.title)],
      description: `Preview task "${input.title}"`,
      confirmationRequired: false,
    }),
    match: (step) => variable('task', ['create'], 5)(step) && step.args.includes('--title'),
  },
  'self.triage.create_issues': {
    id: 'self.triage.create_issues',
    description: 'Create EVOL tasks on GitHub',
    inputSchema: {},
    riskLevel: 'medium',
    sideEffects: true,
    confirmationRequired: false,
    build: (_input, id) => ({ id, actionId: 'self.triage.create_issues', input: {}, tool: 'openslack-cli', command: 'self', args: ['triage', '--create-issues'], description: 'Create EVOL tasks on GitHub', confirmationRequired: false }),
    match: exact('self', ['triage', '--create-issues']),
  },
  'agent.claim_task': {
    id: 'agent.claim_task',
    description: 'Claim a task from GitHub Issues',
    inputSchema: { agentId: { type: 'string', required: true } },
    riskLevel: 'low',
    sideEffects: true,
    confirmationRequired: false,
    build: (input, id) => ({ id, actionId: 'agent.claim_task', input, tool: 'openslack-cli', command: 'agent', args: ['tick', '--source', 'github-issues', '--agent-id', str(input.agentId)], description: `Claim task for ${input.agentId}`, confirmationRequired: false }),
    match: (step) => variable('agent', ['tick', '--source', 'github-issues', '--agent-id'], 5)(step),
  },
  'task.checkout': {
    id: 'task.checkout',
    description: 'Create worktree for an issue',
    inputSchema: { issueNumber: { type: 'number', required: true }, agentId: { type: 'string', required: true } },
    riskLevel: 'low',
    sideEffects: true,
    confirmationRequired: false,
    build: (input, id) => ({ id, actionId: 'task.checkout', input, tool: 'openslack-cli', command: 'task', args: ['checkout', '--issue-number', str(input.issueNumber), '--agent-id', str(input.agentId)], description: `Create worktree for issue #${input.issueNumber}`, confirmationRequired: false }),
    match: (step) => variable('task', ['checkout', '--issue-number'], 5)(step),
  },
  'task.sync': {
    id: 'task.sync',
    description: 'Propose workspace PR for an issue',
    inputSchema: { issueNumber: { type: 'number', required: true }, agentId: { type: 'string', required: true }, paths: { type: 'string', required: true } },
    riskLevel: 'medium',
    sideEffects: true,
    confirmationRequired: true,
    build: (input, id) => ({ id, actionId: 'task.sync', input, tool: 'openslack-cli', command: 'task', args: ['sync', '--issue-number', str(input.issueNumber), '--agent-id', str(input.agentId), '--paths', str(input.paths)], description: `Propose workspace PR for issue #${input.issueNumber}`, confirmationRequired: true }),
    match: (step) => variable('task', ['sync', '--issue-number'], 7)(step),
  },
  'github.issue_done': {
    id: 'github.issue_done',
    description: 'Mark issue done',
    inputSchema: { issueNumber: { type: 'number', required: true } },
    riskLevel: 'medium',
    sideEffects: true,
    confirmationRequired: true,
    build: (input, id) => ({ id, actionId: 'github.issue_done', input, tool: 'openslack-cli', command: 'github', args: ['issue-done', '--issue-number', str(input.issueNumber)], description: `Mark issue #${input.issueNumber} as done`, confirmationRequired: true }),
    match: (step) => variable('github', ['issue-done', '--issue-number'], 3)(step) && numArg(step.args, 2),
  },
  'github.repair.labels.preview': {
    id: 'github.repair.labels.preview',
    description: 'Preview GitHub label repair',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({ id, actionId: 'github.repair.labels.preview', input: {}, tool: 'openslack-cli', command: 'github', args: ['repair', 'labels'], description: 'Preview GitHub label repair', confirmationRequired: false }),
    match: exact('github', ['repair', 'labels']),
  },
  'github.repair.claims.preview': {
    id: 'github.repair.claims.preview',
    description: 'Preview GitHub claim repair',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({ id, actionId: 'github.repair.claims.preview', input: {}, tool: 'openslack-cli', command: 'github', args: ['repair', 'claims'], description: 'Preview GitHub claim repair', confirmationRequired: false }),
    match: exact('github', ['repair', 'claims']),
  },
  'task.repair.worktrees.preview': {
    id: 'task.repair.worktrees.preview',
    description: 'Preview local worktree repair',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({ id, actionId: 'task.repair.worktrees.preview', input: {}, tool: 'openslack-cli', command: 'task', args: ['repair', 'worktrees'], description: 'Preview local worktree repair', confirmationRequired: false }),
    match: exact('task', ['repair', 'worktrees']),
  },
  'conversation.start': {
    id: 'conversation.start',
    description: 'Create a new conversation thread',
    inputSchema: { title: { type: 'string', required: true }, pr: { type: 'number' }, issue: { type: 'number' }, workflow: { type: 'string' } },
    riskLevel: 'low',
    sideEffects: true,
    confirmationRequired: false,
    build: (input, id) => {
      const args = ['start', '--title', str(input.title)];
      if (input.pr !== undefined) args.push('--pr', str(input.pr));
      if (input.issue !== undefined) args.push('--issue', str(input.issue));
      if (input.workflow !== undefined) args.push('--workflow', str(input.workflow));
      return { id, actionId: 'conversation.start', input, tool: 'openslack-cli', command: 'conversation', args, description: `Create conversation thread "${input.title}"`, confirmationRequired: false };
    },
    match: (step) => variable('conversation', ['start'], 3)(step) && step.args.includes('--title'),
  },
  'conversation.list': {
    id: 'conversation.list',
    description: 'List conversation threads',
    inputSchema: { status: { type: 'string' } },
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (input, id) => {
      const args = ['list'];
      if (input.status) args.push('--status', str(input.status));
      return { id, actionId: 'conversation.list', input, tool: 'openslack-cli', command: 'conversation', args, description: 'List conversation threads', confirmationRequired: false };
    },
    match: (step) => variable('conversation', ['list'], 1)(step),
  },
  'conversation.show': {
    id: 'conversation.show',
    description: 'Show conversation thread details',
    inputSchema: { threadId: { type: 'string', required: true } },
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (input, id) => ({ id, actionId: 'conversation.show', input, tool: 'openslack-cli', command: 'conversation', args: ['show', str(input.threadId)], description: `Show conversation thread ${input.threadId}`, confirmationRequired: false }),
    match: (step) => variable('conversation', ['show'], 2)(step),
  },
  'conversation.send': {
    id: 'conversation.send',
    description: 'Send message to conversation thread',
    inputSchema: { threadId: { type: 'string', required: true }, message: { type: 'string', required: true } },
    riskLevel: 'medium',
    sideEffects: true,
    confirmationRequired: false,
    build: (input, id) => ({ id, actionId: 'conversation.send', input, tool: 'openslack-cli', command: 'conversation', args: ['send', str(input.threadId), str(input.message)], description: `Send message to thread ${input.threadId}`, confirmationRequired: false }),
    match: (step) => variable('conversation', ['send'], 3)(step),
  },
  'conversation.summarize': {
    id: 'conversation.summarize',
    description: 'Show conversation thread summary and next action',
    inputSchema: { threadId: { type: 'string', required: true } },
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (input, id) => ({ id, actionId: 'conversation.summarize', input, tool: 'openslack-cli', command: 'conversation', args: ['summarize', str(input.threadId)], description: `Summarize conversation thread ${input.threadId}`, confirmationRequired: false }),
    match: (step) => variable('conversation', ['summarize'], 2)(step),
  },
  'conversation.archive': {
    id: 'conversation.archive',
    description: 'Archive a conversation thread',
    inputSchema: { threadId: { type: 'string', required: true } },
    riskLevel: 'medium',
    sideEffects: true,
    confirmationRequired: false,
    build: (input, id) => ({ id, actionId: 'conversation.archive', input, tool: 'openslack-cli', command: 'conversation', args: ['archive', str(input.threadId)], description: `Archive conversation thread ${input.threadId}`, confirmationRequired: false }),
    match: (step) => variable('conversation', ['archive'], 2)(step),
  },
};

export function listRegisteredActions(): RegisteredAction[] {
  return Object.values(REGISTERED_ACTIONS);
}

export function getRegisteredAction(actionId: string): RegisteredAction | undefined {
  return REGISTERED_ACTIONS[actionId as RegisteredActionId];
}

export function validateRegisteredActionInput(action: RegisteredAction, input: ToolInput): string[] {
  const errors: string[] = [];
  for (const [name, field] of Object.entries(action.inputSchema)) {
    const value = input[name];
    if (field.required && value === undefined) {
      errors.push(`Missing required input: ${name}`);
      continue;
    }
    if (!valueMatchesType(value, field.type)) {
      errors.push(`Invalid input type for ${name}: expected ${field.type}`);
    }
  }
  for (const key of Object.keys(input)) {
    if (!action.inputSchema[key]) errors.push(`Unknown input: ${key}`);
  }
  return errors;
}

export function createRegisteredStep(actionId: string, input: ToolInput, stepId: string): PlanStep {
  const action = getRegisteredAction(actionId);
  if (!action) throw new Error(`Unregistered OpenSlack action: ${actionId}`);
  const errors = validateRegisteredActionInput(action, input);
  if (errors.length > 0) throw new Error(errors.join('; '));
  return action.build(input, stepId);
}

export function isRegisteredStep(step: PlanStep): boolean {
  if (step.actionId) {
    const action = getRegisteredAction(step.actionId);
    if (!action) return false;
    return action.match(step);
  }
  return listRegisteredActions().some((action) => action.match(step));
}

export function buildActionPlanFromRegisteredActions(
  goal: string,
  intent: Intent,
  calls: RegisteredActionCall[],
): PlanStep[] {
  if (calls.length > 6) throw new Error('Registered action plan exceeds max tool step limit: 6');
  return calls.map((call, index) => createRegisteredStep(call.actionId, call.input, `s${index + 1}`));
}

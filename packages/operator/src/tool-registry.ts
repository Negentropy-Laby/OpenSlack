import type { Intent, PlanStep, RiskLevel } from './types.js';

export type ToolInputValue = string | number | boolean | undefined;
export type ToolInput = Record<string, ToolInputValue>;

export const REGISTERED_ACTION_IDS = Object.freeze([
  'status.show',
  'workspace.status',
  'github.metrics',
  'workspace.index',
  'doctor.run',
  'workspace.validate',
  'self.eval.golden',
  'self.observe',
  'governance.audit',
  'pr.status',
  'pr.doctor',
  'pr.review',
  'pr.queue',
  'pr.watch',
  'pr.merge',
  'task.create.preview',
  'self.triage.create_issues',
  'agent.claim_task',
  'task.checkout',
  'task.sync',
  'github.issue_done',
  'github.repair.labels.preview',
  'github.repair.claims.preview',
  'task.repair.worktrees.preview',
  'conversation.start',
  'conversation.list',
  'conversation.show',
  'conversation.send',
  'conversation.summarize',
  'conversation.archive',
] as const);

export type RegisteredActionId = (typeof REGISTERED_ACTION_IDS)[number];
export type PluginActionId = `plugin:${string}:${string}`;
export type ActionId = RegisteredActionId | PluginActionId;

type InputType = 'string' | 'number' | 'boolean';

export interface ToolInputField {
  readonly type: InputType;
  readonly required?: boolean;
}

export interface RegisteredAction<TActionId extends ActionId = ActionId> {
  readonly id: TActionId;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, ToolInputField>>;
  readonly riskLevel: RiskLevel;
  readonly sideEffects: boolean;
  readonly confirmationRequired: boolean;
  /**
   * Synchronous, deterministic, side-effect-free object construction. Registry
   * validation may invoke this function more than once before any execution
   * authority is used; it must not perform I/O or read time/random state.
   */
  readonly build: (input: ToolInput, stepId: string) => PlanStep;
  /**
   * Synchronous, deterministic, side-effect-free validation of canonical output;
   * it must not perform I/O or read time/random state.
   */
  readonly match: (step: PlanStep) => boolean;
}

export interface RegisteredActionCall {
  readonly actionId: string;
  readonly input: ToolInput;
}

export type PlanStepRevalidation =
  | {
      readonly valid: true;
      readonly action: RegisteredAction;
      readonly step: PlanStep;
    }
  | {
      readonly valid: false;
      readonly stepId: string;
      readonly actionId?: string;
      readonly reason: string;
    };

export interface ActionRegistryPort {
  list(): readonly RegisteredAction[];
  get(actionId: string): RegisteredAction | undefined;
  createStep(actionId: string, input: ToolInput, stepId: string): PlanStep;
  revalidateStep(step: unknown): PlanStepRevalidation;
  buildPlanSteps(goal: string, intent: Intent, calls: readonly RegisteredActionCall[]): PlanStep[];
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
  return (step) =>
    step.command === command &&
    step.args.length === args.length &&
    step.args.every((arg, i) => arg === args[i]);
}

function variable(
  command: string,
  prefix: string[],
  requiredArgs: number,
): (step: PlanStep) => boolean {
  return (step) =>
    step.command === command &&
    step.args.length >= requiredArgs &&
    prefix.every((arg, i) => step.args[i] === arg);
}

const BUILT_IN_ACTION_DEFINITIONS: Record<
  RegisteredActionId,
  RegisteredAction<RegisteredActionId>
> = {
  'status.show': {
    id: 'status.show',
    description: 'Show product dashboard',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({
      id,
      actionId: 'status.show',
      input: {},
      tool: 'openslack-cli',
      command: 'status',
      args: [],
      description: 'Show product dashboard',
      confirmationRequired: false,
    }),
    match: exact('status', []),
  },
  'workspace.status': {
    id: 'workspace.status',
    description: 'Show workspace status',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({
      id,
      actionId: 'workspace.status',
      input: {},
      tool: 'openslack-cli',
      command: 'workspace',
      args: ['status'],
      description: 'Show workspace status',
      confirmationRequired: false,
    }),
    match: exact('workspace', ['status']),
  },
  'github.metrics': {
    id: 'github.metrics',
    description: 'Show task loop metrics',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({
      id,
      actionId: 'github.metrics',
      input: {},
      tool: 'openslack-cli',
      command: 'github',
      args: ['metrics'],
      description: 'Show task loop metrics',
      confirmationRequired: false,
    }),
    match: exact('github', ['metrics']),
  },
  'workspace.index': {
    id: 'workspace.index',
    description: 'Build workspace index',
    inputSchema: {},
    riskLevel: 'low',
    sideEffects: true,
    confirmationRequired: false,
    build: (_input, id) => ({
      id,
      actionId: 'workspace.index',
      input: {},
      tool: 'openslack-cli',
      command: 'workspace',
      args: ['index'],
      description: 'Build workspace index',
      confirmationRequired: false,
    }),
    match: exact('workspace', ['index']),
  },
  'doctor.run': {
    id: 'doctor.run',
    description: 'Run multi-module health check',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({
      id,
      actionId: 'doctor.run',
      input: {},
      tool: 'openslack-cli',
      command: 'doctor',
      args: [],
      description: 'Run multi-module health check',
      confirmationRequired: false,
    }),
    match: exact('doctor', []),
  },
  'workspace.validate': {
    id: 'workspace.validate',
    description: 'Validate workspace',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({
      id,
      actionId: 'workspace.validate',
      input: {},
      tool: 'openslack-cli',
      command: 'workspace',
      args: ['validate'],
      description: 'Validate workspace',
      confirmationRequired: false,
    }),
    match: exact('workspace', ['validate']),
  },
  'self.eval.golden': {
    id: 'self.eval.golden',
    description: 'Run golden evals',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({
      id,
      actionId: 'self.eval.golden',
      input: {},
      tool: 'openslack-cli',
      command: 'self',
      args: ['eval', '--suite', 'golden'],
      description: 'Run golden evals',
      confirmationRequired: false,
    }),
    match: exact('self', ['eval', '--suite', 'golden']),
  },
  'self.observe': {
    id: 'self.observe',
    description: 'Check system health',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({
      id,
      actionId: 'self.observe',
      input: {},
      tool: 'openslack-cli',
      command: 'self',
      args: ['observe'],
      description: 'Check system health',
      confirmationRequired: false,
    }),
    match: exact('self', ['observe']),
  },
  'governance.audit': {
    id: 'governance.audit',
    description: 'Audit governance compliance',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({
      id,
      actionId: 'governance.audit',
      input: {},
      tool: 'openslack-cli',
      command: 'governance',
      args: ['audit'],
      description: 'Audit governance compliance',
      confirmationRequired: false,
    }),
    match: exact('governance', ['audit']),
  },
  'pr.status': {
    id: 'pr.status',
    description: 'Show PR status',
    inputSchema: { prNumber: { type: 'number', required: true } },
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (input, id) => ({
      id,
      actionId: 'pr.status',
      input,
      tool: 'openslack-cli',
      command: 'pr',
      args: ['status', str(input.prNumber)],
      description: `Show PR #${input.prNumber} status`,
      confirmationRequired: false,
    }),
    match: (step) => variable('pr', ['status'], 2)(step) && numArg(step.args, 1),
  },
  'pr.doctor': {
    id: 'pr.doctor',
    description: 'Diagnose PR governance',
    inputSchema: { prNumber: { type: 'number', required: true } },
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (input, id) => ({
      id,
      actionId: 'pr.doctor',
      input,
      tool: 'openslack-cli',
      command: 'pr',
      args: ['doctor', str(input.prNumber)],
      description: `Diagnose PR #${input.prNumber} governance`,
      confirmationRequired: false,
      produces: ['diagnosis'],
    }),
    match: (step) => variable('pr', ['doctor'], 2)(step) && numArg(step.args, 1),
  },
  'pr.review': {
    id: 'pr.review',
    description: 'Review a PR',
    inputSchema: { prNumber: { type: 'number', required: true } },
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (input, id) => ({
      id,
      actionId: 'pr.review',
      input,
      tool: 'openslack-cli',
      command: 'pr',
      args: ['review', str(input.prNumber)],
      description: `Review PR #${input.prNumber}`,
      confirmationRequired: false,
    }),
    match: (step) => variable('pr', ['review'], 2)(step) && numArg(step.args, 1),
  },
  'pr.queue': {
    id: 'pr.queue',
    description: 'Show PR queue',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({
      id,
      actionId: 'pr.queue',
      input: {},
      tool: 'openslack-cli',
      command: 'pr',
      args: ['queue'],
      description: 'Show PR queue',
      confirmationRequired: false,
    }),
    match: exact('pr', ['queue']),
  },
  'pr.watch': {
    id: 'pr.watch',
    description: 'Watch a PR until ready',
    inputSchema: { prNumber: { type: 'number', required: true } },
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (input, id) => ({
      id,
      actionId: 'pr.watch',
      input,
      tool: 'openslack-cli',
      command: 'pr',
      args: ['watch', str(input.prNumber)],
      description: `Watch PR #${input.prNumber} until ready`,
      confirmationRequired: false,
    }),
    match: (step) => variable('pr', ['watch'], 2)(step) && numArg(step.args, 1),
  },
  'pr.merge': {
    id: 'pr.merge',
    description: 'Merge a PR after PRMS gates pass',
    inputSchema: { prNumber: { type: 'number', required: true } },
    riskLevel: 'high',
    sideEffects: true,
    confirmationRequired: true,
    build: (input, id) => ({
      id,
      actionId: 'pr.merge',
      input,
      tool: 'openslack-cli',
      command: 'pr',
      args: ['merge', str(input.prNumber)],
      description: `Merge PR #${input.prNumber}`,
      confirmationRequired: true,
    }),
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
      args: [
        'create',
        '--template',
        str(input.template ?? 'investigation'),
        '--title',
        str(input.title),
      ],
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
    build: (_input, id) => ({
      id,
      actionId: 'self.triage.create_issues',
      input: {},
      tool: 'openslack-cli',
      command: 'self',
      args: ['triage', '--create-issues'],
      description: 'Create EVOL tasks on GitHub',
      confirmationRequired: false,
    }),
    match: exact('self', ['triage', '--create-issues']),
  },
  'agent.claim_task': {
    id: 'agent.claim_task',
    description: 'Claim a task from GitHub Issues',
    inputSchema: { agentId: { type: 'string', required: true } },
    riskLevel: 'low',
    sideEffects: true,
    confirmationRequired: false,
    build: (input, id) => ({
      id,
      actionId: 'agent.claim_task',
      input,
      tool: 'openslack-cli',
      command: 'agent',
      args: ['tick', '--source', 'github-issues', '--agent-id', str(input.agentId)],
      description: `Claim task for ${input.agentId}`,
      confirmationRequired: false,
    }),
    match: (step) =>
      variable('agent', ['tick', '--source', 'github-issues', '--agent-id'], 5)(step),
  },
  'task.checkout': {
    id: 'task.checkout',
    description: 'Create worktree for an issue',
    inputSchema: {
      issueNumber: { type: 'number', required: true },
      agentId: { type: 'string', required: true },
    },
    riskLevel: 'low',
    sideEffects: true,
    confirmationRequired: false,
    build: (input, id) => ({
      id,
      actionId: 'task.checkout',
      input,
      tool: 'openslack-cli',
      command: 'task',
      args: [
        'checkout',
        '--issue-number',
        str(input.issueNumber),
        '--agent-id',
        str(input.agentId),
      ],
      description: `Create worktree for issue #${input.issueNumber}`,
      confirmationRequired: false,
    }),
    match: (step) => variable('task', ['checkout', '--issue-number'], 5)(step),
  },
  'task.sync': {
    id: 'task.sync',
    description: 'Propose workspace PR for an issue',
    inputSchema: {
      issueNumber: { type: 'number', required: true },
      agentId: { type: 'string', required: true },
      paths: { type: 'string', required: true },
    },
    riskLevel: 'medium',
    sideEffects: true,
    confirmationRequired: true,
    build: (input, id) => ({
      id,
      actionId: 'task.sync',
      input,
      tool: 'openslack-cli',
      command: 'task',
      args: [
        'sync',
        '--issue-number',
        str(input.issueNumber),
        '--agent-id',
        str(input.agentId),
        '--paths',
        str(input.paths),
      ],
      description: `Propose workspace PR for issue #${input.issueNumber}`,
      confirmationRequired: true,
    }),
    match: (step) => variable('task', ['sync', '--issue-number'], 7)(step),
  },
  'github.issue_done': {
    id: 'github.issue_done',
    description: 'Mark issue done',
    inputSchema: {
      issueNumber: { type: 'number', required: true },
      agentId: { type: 'string', required: true },
      prUrl: { type: 'string', required: true },
    },
    riskLevel: 'medium',
    sideEffects: true,
    confirmationRequired: true,
    build: (input, id) => ({
      id,
      actionId: 'github.issue_done',
      input,
      tool: 'openslack-cli',
      command: 'github',
      args: [
        'issue-done',
        '--issue-number',
        str(input.issueNumber),
        '--agent-id',
        str(input.agentId),
        '--pr-url',
        str(input.prUrl),
      ],
      description: `Mark issue #${input.issueNumber} as done`,
      confirmationRequired: true,
    }),
    match: (step) =>
      variable('github', ['issue-done', '--issue-number'], 7)(step) && numArg(step.args, 2),
  },
  'github.repair.labels.preview': {
    id: 'github.repair.labels.preview',
    description: 'Preview GitHub label repair',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({
      id,
      actionId: 'github.repair.labels.preview',
      input: {},
      tool: 'openslack-cli',
      command: 'github',
      args: ['repair', 'labels'],
      description: 'Preview GitHub label repair',
      confirmationRequired: false,
    }),
    match: exact('github', ['repair', 'labels']),
  },
  'github.repair.claims.preview': {
    id: 'github.repair.claims.preview',
    description: 'Preview GitHub claim repair',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({
      id,
      actionId: 'github.repair.claims.preview',
      input: {},
      tool: 'openslack-cli',
      command: 'github',
      args: ['repair', 'claims'],
      description: 'Preview GitHub claim repair',
      confirmationRequired: false,
    }),
    match: exact('github', ['repair', 'claims']),
  },
  'task.repair.worktrees.preview': {
    id: 'task.repair.worktrees.preview',
    description: 'Preview local worktree repair',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (_input, id) => ({
      id,
      actionId: 'task.repair.worktrees.preview',
      input: {},
      tool: 'openslack-cli',
      command: 'task',
      args: ['repair', 'worktrees'],
      description: 'Preview local worktree repair',
      confirmationRequired: false,
    }),
    match: exact('task', ['repair', 'worktrees']),
  },
  'conversation.start': {
    id: 'conversation.start',
    description: 'Create a new conversation thread',
    inputSchema: {
      title: { type: 'string', required: true },
      pr: { type: 'number' },
      issue: { type: 'number' },
      workflow: { type: 'string' },
    },
    riskLevel: 'low',
    sideEffects: true,
    confirmationRequired: false,
    build: (input, id) => {
      const args = ['start', '--title', str(input.title)];
      if (input.pr !== undefined) args.push('--pr', str(input.pr));
      if (input.issue !== undefined) args.push('--issue', str(input.issue));
      if (input.workflow !== undefined) args.push('--workflow', str(input.workflow));
      return {
        id,
        actionId: 'conversation.start',
        input,
        tool: 'openslack-cli',
        command: 'conversation',
        args,
        description: `Create conversation thread "${input.title}"`,
        confirmationRequired: false,
      };
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
      return {
        id,
        actionId: 'conversation.list',
        input,
        tool: 'openslack-cli',
        command: 'conversation',
        args,
        description: 'List conversation threads',
        confirmationRequired: false,
      };
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
    build: (input, id) => ({
      id,
      actionId: 'conversation.show',
      input,
      tool: 'openslack-cli',
      command: 'conversation',
      args: ['show', str(input.threadId)],
      description: `Show conversation thread ${input.threadId}`,
      confirmationRequired: false,
    }),
    match: (step) => variable('conversation', ['show'], 2)(step),
  },
  'conversation.send': {
    id: 'conversation.send',
    description: 'Send message to conversation thread',
    inputSchema: {
      threadId: { type: 'string', required: true },
      message: { type: 'string', required: true },
    },
    riskLevel: 'medium',
    sideEffects: true,
    confirmationRequired: false,
    build: (input, id) => ({
      id,
      actionId: 'conversation.send',
      input,
      tool: 'openslack-cli',
      command: 'conversation',
      args: ['send', str(input.threadId), str(input.message)],
      description: `Send message to thread ${input.threadId}`,
      confirmationRequired: false,
    }),
    match: (step) => variable('conversation', ['send'], 3)(step),
  },
  'conversation.summarize': {
    id: 'conversation.summarize',
    description: 'Show conversation thread summary and next action',
    inputSchema: { threadId: { type: 'string', required: true } },
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (input, id) => ({
      id,
      actionId: 'conversation.summarize',
      input,
      tool: 'openslack-cli',
      command: 'conversation',
      args: ['summarize', str(input.threadId)],
      description: `Summarize conversation thread ${input.threadId}`,
      confirmationRequired: false,
    }),
    match: (step) => variable('conversation', ['summarize'], 2)(step),
  },
  'conversation.archive': {
    id: 'conversation.archive',
    description: 'Archive a conversation thread',
    inputSchema: { threadId: { type: 'string', required: true } },
    riskLevel: 'medium',
    sideEffects: true,
    confirmationRequired: false,
    build: (input, id) => ({
      id,
      actionId: 'conversation.archive',
      input,
      tool: 'openslack-cli',
      command: 'conversation',
      args: ['archive', str(input.threadId)],
      description: `Archive conversation thread ${input.threadId}`,
      confirmationRequired: false,
    }),
    match: (step) => variable('conversation', ['archive'], 2)(step),
  },
};

const BUILT_IN_ACTION_ID_SET = new Set<string>(REGISTERED_ACTION_IDS);
const PLUGIN_ACTION_ID_PATTERN =
  /^plugin:([a-z][a-z0-9]*(?:-[a-z0-9]+)*):([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;
// Keep the host action schema compatible with plugin-api's bounded field-name grammar.
// Declarative-manifest forbidden names are rejected by the governed host before adaptation;
// this registry also supports explicitly imported, trusted bundled definitions.
const INPUT_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const RESERVED_PLUGIN_IDS = new Set([
  'openslack',
  'built-in',
  'plugin',
  'workspace',
  'external',
  'negentropy',
]);
// `satisfies Record<keyof PlanStep, true>` makes a PlanStep type change fail
// typecheck until the closed runtime allowlist is reviewed and updated.
const PLAN_STEP_KEY_MAP = Object.freeze({
  id: true,
  actionId: true,
  input: true,
  tool: true,
  command: true,
  args: true,
  description: true,
  confirmationRequired: true,
  produces: true,
} as const satisfies Record<keyof PlanStep, true>);
const PLAN_STEP_KEYS: ReadonlySet<string> = new Set(Object.keys(PLAN_STEP_KEY_MAP));

function isRegisteredActionId(value: string): value is RegisteredActionId {
  return BUILT_IN_ACTION_ID_SET.has(value);
}

export function isPluginActionId(value: string): value is PluginActionId {
  const match = PLUGIN_ACTION_ID_PATTERN.exec(value);
  if (!match) return false;
  const pluginId = match[1]!;
  const localId = match[2]!;
  return (
    pluginId.length <= 64 &&
    localId.length <= 64 &&
    !pluginId.startsWith('openslack-') &&
    !RESERVED_PLUGIN_IDS.has(pluginId)
  );
}

function freezeActionDefinition<TActionId extends ActionId>(
  action: RegisteredAction<TActionId>,
): RegisteredAction<TActionId> {
  const inputSchema = Object.create(null) as Record<string, ToolInputField>;
  for (const [name, field] of Object.entries(action.inputSchema)) {
    if (
      !INPUT_FIELD_PATTERN.test(name) ||
      (field.type !== 'string' && field.type !== 'number' && field.type !== 'boolean') ||
      (field.required !== undefined && typeof field.required !== 'boolean')
    ) {
      throw new Error(`Invalid registered action input field: ${action.id}.${name}`);
    }
    inputSchema[name] = Object.freeze({ type: field.type, required: field.required });
  }
  if (
    typeof action.description !== 'string' ||
    !['none', 'low', 'medium', 'high'].includes(action.riskLevel) ||
    typeof action.sideEffects !== 'boolean' ||
    typeof action.confirmationRequired !== 'boolean' ||
    typeof action.build !== 'function' ||
    typeof action.match !== 'function'
  ) {
    throw new Error(`Invalid registered action definition: ${action.id}`);
  }
  return Object.freeze({
    ...action,
    inputSchema: Object.freeze(inputSchema),
  });
}

export const REGISTERED_ACTIONS = Object.freeze(
  Object.fromEntries(
    REGISTERED_ACTION_IDS.map((actionId) => [
      actionId,
      freezeActionDefinition(BUILT_IN_ACTION_DEFINITIONS[actionId]),
    ]),
  ),
) as Readonly<Record<RegisteredActionId, RegisteredAction<RegisteredActionId>>>;

function ownDataDescriptors(value: unknown): Record<string, PropertyDescriptor> | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >;
    for (const descriptor of Object.values(descriptors)) {
      if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return undefined;
    }
    return descriptors;
  } catch {
    return undefined;
  }
}

function normalizeToolInput(value: unknown): ToolInput | undefined {
  const descriptors = ownDataDescriptors(value);
  if (!descriptors) return undefined;
  const normalized = Object.create(null) as ToolInput;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    const item = descriptor.value as unknown;
    if (
      item !== undefined &&
      typeof item !== 'string' &&
      typeof item !== 'boolean' &&
      (typeof item !== 'number' || !Number.isFinite(item))
    ) {
      return undefined;
    }
    normalized[key] = item as ToolInputValue;
  }
  return Object.freeze(normalized) as ToolInput;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getOwnPropertySymbols(value).length > 0) return undefined;
    if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >;
    const length = descriptors.length?.value as unknown;
    if (!Number.isSafeInteger(length) || (length as number) < 0) return undefined;
    if (Object.keys(descriptors).length !== (length as number) + 1) return undefined;
    const normalized: string[] = [];
    for (let index = 0; index < (length as number); index++) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, 'value') ||
        descriptor.enumerable !== true ||
        typeof descriptor.value !== 'string'
      ) {
        return undefined;
      }
      normalized.push(descriptor.value);
    }
    return Object.freeze(normalized) as unknown as string[];
  } catch {
    return undefined;
  }
}

function normalizePlanStep(value: unknown): PlanStep | undefined {
  const descriptors = ownDataDescriptors(value);
  if (!descriptors || Object.keys(descriptors).some((key) => !PLAN_STEP_KEYS.has(key))) {
    return undefined;
  }
  const data = (key: string): unknown => descriptors[key]?.value;
  const id = data('id');
  const actionId = data('actionId');
  const input = descriptors.input ? normalizeToolInput(data('input')) : undefined;
  const tool = data('tool');
  const command = data('command');
  const args = normalizeStringArray(data('args'));
  const description = data('description');
  const confirmationRequired = data('confirmationRequired');
  const produces = descriptors.produces ? normalizeStringArray(data('produces')) : undefined;
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    (actionId !== undefined && typeof actionId !== 'string') ||
    (descriptors.input && !input) ||
    (tool !== 'openslack-cli' && tool !== 'package-api') ||
    typeof command !== 'string' ||
    command.length === 0 ||
    !args ||
    typeof description !== 'string' ||
    typeof confirmationRequired !== 'boolean' ||
    (descriptors.produces && !produces)
  ) {
    return undefined;
  }
  const normalized: PlanStep = {
    id,
    tool,
    command,
    args,
    description,
    confirmationRequired,
  };
  if (actionId !== undefined) normalized.actionId = actionId;
  if (input !== undefined) normalized.input = input;
  if (produces !== undefined) normalized.produces = produces;
  return Object.freeze(normalized);
}

function sameStringArray(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameToolInput(left: ToolInput | undefined, right: ToolInput | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return sameStringArray(leftKeys, rightKeys) && leftKeys.every((key) => left[key] === right[key]);
}

function samePlanStep(left: PlanStep, right: PlanStep): boolean {
  return (
    left.id === right.id &&
    left.actionId === right.actionId &&
    sameToolInput(left.input, right.input) &&
    left.tool === right.tool &&
    left.command === right.command &&
    sameStringArray(left.args, right.args) &&
    left.description === right.description &&
    left.confirmationRequired === right.confirmationRequired &&
    sameStringArray(left.produces, right.produces)
  );
}

export function validateRegisteredActionInput(
  action: RegisteredAction,
  input: ToolInput,
): string[] {
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
    if (!Object.hasOwn(action.inputSchema, key)) errors.push(`Unknown input: ${key}`);
  }
  return errors;
}

function buildCanonicalStep(
  action: RegisteredAction,
  inputValue: unknown,
  stepId: string,
): PlanStep {
  const input = normalizeToolInput(inputValue);
  if (!input) throw new Error(`Invalid input object for registered action: ${action.id}`);
  const errors = validateRegisteredActionInput(action, input);
  if (errors.length > 0) throw new Error(errors.join('; '));
  const step = normalizePlanStep(action.build(input, stepId));
  if (
    !step ||
    step.id !== stepId ||
    step.actionId !== action.id ||
    !sameToolInput(step.input, input) ||
    step.confirmationRequired !== action.confirmationRequired
  ) {
    throw new Error(`Registered action returned a non-canonical PlanStep: ${action.id}`);
  }
  try {
    if (!action.match(step)) {
      throw new Error(`Registered action builder failed its own matcher: ${action.id}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Registered action builder')) {
      throw error;
    }
    throw new Error(`Registered action matcher failed: ${action.id}`, { cause: error });
  }
  return step;
}

function unsafeStepIdentity(value: unknown): {
  readonly stepId: string;
  readonly actionId?: string;
} {
  const descriptors = ownDataDescriptors(value);
  const stepId = typeof descriptors?.id?.value === 'string' ? descriptors.id.value : 'unknown';
  const actionId =
    typeof descriptors?.actionId?.value === 'string' ? descriptors.actionId.value : undefined;
  return actionId === undefined ? { stepId } : { stepId, actionId };
}

class InstanceActionRegistry implements ActionRegistryPort {
  readonly #actions: ReadonlyMap<string, RegisteredAction>;
  readonly #ordered: readonly RegisteredAction[];

  constructor(definitions: readonly RegisteredAction[]) {
    const actions = new Map<string, RegisteredAction>();
    const ordered: RegisteredAction[] = [];
    for (const definition of definitions) {
      const id = definition.id;
      if (!isRegisteredActionId(id) && !isPluginActionId(id)) {
        throw new Error(`Registered action id must be built-in or plugin-namespaced: ${id}`);
      }
      if (actions.has(id)) throw new Error(`Duplicate registered action: ${id}`);
      const action = isRegisteredActionId(id)
        ? REGISTERED_ACTIONS[id]
        : freezeActionDefinition(definition);
      actions.set(id, action);
      ordered.push(action);
    }
    this.#actions = actions;
    this.#ordered = Object.freeze(ordered);
    Object.freeze(this);
  }

  list(): readonly RegisteredAction[] {
    return this.#ordered;
  }

  get(actionId: string): RegisteredAction | undefined {
    return this.#actions.get(actionId);
  }

  createStep(actionId: string, input: ToolInput, stepId: string): PlanStep {
    const action = this.get(actionId);
    if (!action) throw new Error(`Unregistered OpenSlack action: ${actionId}`);
    return buildCanonicalStep(action, input, stepId);
  }

  revalidateStep(value: unknown): PlanStepRevalidation {
    const identity = unsafeStepIdentity(value);
    const step = normalizePlanStep(value);
    if (!step || !step.actionId || !step.input) {
      return Object.freeze({
        valid: false,
        ...identity,
        reason: 'PlanStep must be a closed data object with actionId and input.',
      });
    }
    const action = this.get(step.actionId);
    if (!action) {
      return Object.freeze({
        valid: false,
        stepId: step.id,
        actionId: step.actionId,
        reason: 'Action is not present in the execution registry.',
      });
    }
    try {
      const canonical = buildCanonicalStep(action, step.input, step.id);
      if (!samePlanStep(step, canonical)) {
        return Object.freeze({
          valid: false,
          stepId: step.id,
          actionId: step.actionId,
          reason: 'PlanStep differs from the current canonical registered action output.',
        });
      }
      return Object.freeze({ valid: true, action, step: canonical });
    } catch (error) {
      return Object.freeze({
        valid: false,
        stepId: step.id,
        actionId: step.actionId,
        reason: error instanceof Error ? error.message : 'PlanStep revalidation failed.',
      });
    }
  }

  buildPlanSteps(
    _goal: string,
    _intent: Intent,
    calls: readonly RegisteredActionCall[],
  ): PlanStep[] {
    if (calls.length > 6) {
      throw new Error('Registered action plan exceeds max tool step limit: 6');
    }
    return calls.map((call, index) => this.createStep(call.actionId, call.input, `s${index + 1}`));
  }
}

export function createActionRegistry(actions: readonly RegisteredAction[]): ActionRegistryPort {
  return new InstanceActionRegistry(actions);
}

export const BUILTIN_ACTION_REGISTRY = createActionRegistry(
  REGISTERED_ACTION_IDS.map((actionId) => REGISTERED_ACTIONS[actionId]),
);

export function listRegisteredActions(
  registry: ActionRegistryPort = BUILTIN_ACTION_REGISTRY,
): RegisteredAction[] {
  return [...registry.list()];
}

export function getRegisteredAction(
  actionId: string,
  registry: ActionRegistryPort = BUILTIN_ACTION_REGISTRY,
): RegisteredAction | undefined {
  return registry.get(actionId);
}

export function createRegisteredStep(
  actionId: string,
  input: ToolInput,
  stepId: string,
  registry: ActionRegistryPort = BUILTIN_ACTION_REGISTRY,
): PlanStep {
  return registry.createStep(actionId, input, stepId);
}

export function isRegisteredStep(
  step: PlanStep,
  registry: ActionRegistryPort = BUILTIN_ACTION_REGISTRY,
): boolean {
  return registry.revalidateStep(step).valid;
}

export function buildActionPlanFromRegisteredActions(
  goal: string,
  intent: Intent,
  calls: readonly RegisteredActionCall[],
  registry: ActionRegistryPort = BUILTIN_ACTION_REGISTRY,
): PlanStep[] {
  return registry.buildPlanSteps(goal, intent, calls);
}

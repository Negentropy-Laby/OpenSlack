import { types as utilTypes } from 'node:util';

export type JsonSchemaPrimitiveType = 'string' | 'integer' | 'boolean' | 'array' | 'object';

export interface JsonSchemaProperty {
  readonly type: JsonSchemaPrimitiveType;
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean)[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly maxProperties?: number;
  readonly additionalProperties?: boolean;
  readonly items?: Readonly<{
    type: 'string';
    minLength?: number;
    maxLength?: number;
    pattern?: string;
  }>;
}

export interface StrictObjectSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, JsonSchemaProperty>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface OpenSlackReadToolDefinition {
  readonly name: OpenSlackReadToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: StrictObjectSchema;
  readonly annotations: {
    readonly readOnlyHint: true;
    readonly destructiveHint: false;
    readonly idempotentHint: true;
    readonly openWorldHint: boolean;
  };
}

export interface OpenSlackMutationToolDefinition {
  readonly name: OpenSlackMutationToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: StrictObjectSchema;
  readonly annotations: {
    readonly readOnlyHint: false;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
}

export const OPENSLACK_READ_TOOL_NAMES = Object.freeze([
  'openslack_get_executive_overview',
  'openslack_list_work_items',
  'openslack_get_work_room',
  'openslack_get_activity',
  'openslack_get_workflow_progress',
  'openslack_get_pr_readiness',
  'openslack_list_pending_approvals',
  'openslack_get_business_outcomes',
  'openslack_get_notification_status',
  'openslack_list_scenarios',
  'openslack_query_graph',
  'openslack_explain_graph',
] as const);

export type OpenSlackReadToolName = (typeof OPENSLACK_READ_TOOL_NAMES)[number];
export const OPENSLACK_GOVERNED_MUTATION_TOOL_NAMES = Object.freeze([
  'openslack_preview_scenario',
  'openslack_preview_workflow',
  'openslack_confirm_plan',
  'openslack_cancel_plan',
] as const);
export const OPENSLACK_WORKFLOW_APPROVAL_TOOL_NAMES = Object.freeze([
  'openslack_decide_workflow_approval',
] as const);
export const OPENSLACK_MUTATION_TOOL_NAMES = Object.freeze([
  ...OPENSLACK_GOVERNED_MUTATION_TOOL_NAMES,
  ...OPENSLACK_WORKFLOW_APPROVAL_TOOL_NAMES,
] as const);
export type OpenSlackMutationToolName = (typeof OPENSLACK_MUTATION_TOOL_NAMES)[number];
export const OPENSLACK_DEMO_RESET_TOOL_NAME = 'openslack_demo_reset' as const;
export const OPENSLACK_TOOL_CATALOG_COMPOSITION = Object.freeze({
  components: Object.freeze({
    read: 12,
    governedMutations: 4,
    workflowApproval: 1,
    demoReset: 1,
  } as const),
  profiles: Object.freeze({
    productionReadOnly: 12,
    agentBound: 16,
    humanAttested: 17,
  } as const),
});
export type OpenSlackToolName =
  | OpenSlackReadToolName
  | OpenSlackMutationToolName
  | typeof OPENSLACK_DEMO_RESET_TOOL_NAME;

const commonAnnotations = Object.freeze({
  readOnlyHint: true as const,
  destructiveHint: false as const,
  idempotentHint: true as const,
});

function emptySchema(): StrictObjectSchema {
  return Object.freeze({
    type: 'object',
    properties: Object.freeze({}),
    additionalProperties: false,
  });
}

function strictSchema(
  properties: Record<string, JsonSchemaProperty>,
  required: readonly string[] = [],
): StrictObjectSchema {
  return Object.freeze({
    type: 'object',
    properties: Object.freeze({ ...properties }),
    ...(required.length > 0 ? { required: Object.freeze([...required]) } : {}),
    additionalProperties: false,
  });
}

const definitions: readonly OpenSlackReadToolDefinition[] = [
  {
    name: 'openslack_get_executive_overview',
    title: 'OpenSlack executive overview',
    description:
      'Read the current module registry and collaboration dashboard as a bounded management snapshot.',
    inputSchema: strictSchema({
      sinceHours: {
        type: 'integer',
        minimum: 0,
        maximum: 2_160,
        description: 'Dashboard window in hours; 0 means all recorded events.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximum recent events and detail items.',
      },
    }),
    annotations: { ...commonAnnotations, openWorldHint: false },
  },
  {
    name: 'openslack_list_work_items',
    title: 'OpenSlack work items',
    description:
      'List bounded Issue/task projections from recorded authoritative observations, with source and freshness labels.',
    inputSchema: strictSchema({
      status: {
        type: 'string',
        enum: ['created', 'claimed', 'blocked', 'done', 'released', 'expired'],
      },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      sinceHours: { type: 'integer', minimum: 0, maximum: 8_760 },
    }),
    annotations: { ...commonAnnotations, openWorldHint: false },
  },
  {
    name: 'openslack_get_work_room',
    title: 'OpenSlack work room',
    description:
      'Read one issue, PR, workflow, handoff, or decision room from collaboration projections.',
    inputSchema: strictSchema(
      {
        roomId: {
          type: 'string',
          minLength: 3,
          maxLength: 160,
          pattern: '^(issue|pr|workflow|handoff|decision):[A-Za-z0-9._:/-]+$',
        },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      ['roomId'],
    ),
    annotations: { ...commonAnnotations, openWorldHint: false },
  },
  {
    name: 'openslack_get_activity',
    title: 'OpenSlack activity',
    description: 'Read a bounded, filtered collaboration activity projection.',
    inputSchema: strictSchema({
      sinceHours: { type: 'integer', minimum: 0, maximum: 8_760 },
      objectKind: {
        type: 'string',
        enum: [
          'issue',
          'pr',
          'plan',
          'module',
          'agent',
          'handoff',
          'decision',
          'workspace',
          'workflow',
        ],
      },
      objectId: { type: 'string', minLength: 1, maxLength: 160 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    }),
    annotations: { ...commonAnnotations, openWorldHint: false },
  },
  {
    name: 'openslack_get_workflow_progress',
    title: 'OpenSlack workflow progress',
    description:
      'Read phase, agent, budget, approval, warning, and evidence progress for one workflow run.',
    inputSchema: strictSchema(
      {
        runId: {
          type: 'string',
          minLength: 1,
          maxLength: 160,
          pattern: '^[A-Za-z0-9._:-]+$',
        },
      },
      ['runId'],
    ),
    annotations: { ...commonAnnotations, openWorldHint: false },
  },
  {
    name: 'openslack_get_pr_readiness',
    title: 'OpenSlack PR readiness',
    description:
      'Read current-head PRMS readiness and blockers for one PR; this never reviews, approves, or merges.',
    inputSchema: strictSchema(
      {
        prNumber: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
        repo: {
          type: 'string',
          minLength: 3,
          maxLength: 200,
          pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$',
        },
      },
      ['prNumber'],
    ),
    annotations: { ...commonAnnotations, openWorldHint: true },
  },
  {
    name: 'openslack_list_pending_approvals',
    title: 'OpenSlack pending governance',
    description:
      'List OpenSlack confirmations, workflow trust/effect gates, and GitHub human-review requirements as three separate arrays.',
    inputSchema: strictSchema({
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    }),
    annotations: { ...commonAnnotations, openWorldHint: false },
  },
  {
    name: 'openslack_get_business_outcomes',
    title: 'OpenSlack business outcomes',
    description:
      'Read the evidence-labelled BusinessOutcomeProjection for a bounded reporting period.',
    inputSchema: strictSchema({
      from: {
        type: 'string',
        minLength: 10,
        maxLength: 40,
        pattern: '^\\d{4}-\\d{2}-\\d{2}(?:T.*Z)?$',
      },
      to: {
        type: 'string',
        minLength: 10,
        maxLength: 40,
        pattern: '^\\d{4}-\\d{2}-\\d{2}(?:T.*Z)?$',
      },
      scenarioId: {
        type: 'string',
        minLength: 1,
        maxLength: 100,
        pattern: '^[A-Za-z0-9._:-]+$',
      },
    }),
    annotations: { ...commonAnnotations, openWorldHint: false },
  },
  {
    name: 'openslack_get_notification_status',
    title: 'OpenSlack notification status',
    description:
      'Read configured routes and payload-blind local delivery counts; unavailable durable lifecycle fields remain explicit unknowns.',
    inputSchema: emptySchema(),
    annotations: { ...commonAnnotations, openWorldHint: false },
  },
  {
    name: 'openslack_list_scenarios',
    title: 'OpenSlack scenarios',
    description: 'List only locked Scenario Definitions accepted by the sealed host-owned catalog.',
    inputSchema: emptySchema(),
    annotations: { ...commonAnnotations, openWorldHint: false },
  },
  {
    name: 'openslack_query_graph',
    title: 'OpenSlack organization graph query',
    description:
      'Query one current Organization Graph snapshot with query-bound pagination and strict traversal/output limits.',
    inputSchema: strictSchema(
      {
        scenarioInstanceId: {
          type: 'string',
          minLength: 1,
          maxLength: 160,
          pattern: '^[A-Za-z0-9._:-]+$',
        },
        rootNodeIds: {
          type: 'array',
          maxItems: 200,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 512 },
        },
        nodeTypes: {
          type: 'array',
          maxItems: 50,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 512 },
        },
        edgeTypes: {
          type: 'array',
          maxItems: 50,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 512 },
        },
        statuses: {
          type: 'array',
          maxItems: 50,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 512 },
        },
        direction: { type: 'string', enum: ['outgoing', 'incoming', 'both'] },
        depth: { type: 'integer', minimum: 0, maximum: 3 },
        maxNodes: { type: 'integer', minimum: 1, maximum: 200 },
        maxEdges: { type: 'integer', minimum: 1, maximum: 500 },
        maxResponseBytes: { type: 'integer', minimum: 1_024, maximum: 512 * 1_024 },
        includeEvidence: { type: 'boolean' },
        cursor: { type: 'string', minLength: 1, maxLength: 512 },
      },
      ['scenarioInstanceId'],
    ),
    annotations: { ...commonAnnotations, openWorldHint: false },
  },
  {
    name: 'openslack_explain_graph',
    title: 'OpenSlack organization graph explanation',
    description:
      'Explain one graph node or edge from bounded provenance and an optional relationship path.',
    inputSchema: strictSchema(
      {
        scenarioInstanceId: {
          type: 'string',
          minLength: 1,
          maxLength: 160,
          pattern: '^[A-Za-z0-9._:-]+$',
        },
        targetId: { type: 'string', minLength: 1, maxLength: 512 },
        rootNodeId: { type: 'string', minLength: 1, maxLength: 512 },
        direction: { type: 'string', enum: ['outgoing', 'incoming', 'both'] },
        depth: { type: 'integer', minimum: 0, maximum: 3 },
      },
      ['scenarioInstanceId', 'targetId'],
    ),
    annotations: { ...commonAnnotations, openWorldHint: false },
  },
];

const mutationDefinitions: readonly OpenSlackMutationToolDefinition[] = [
  {
    name: 'openslack_preview_scenario',
    title: 'Preview a governed OpenSlack scenario',
    description:
      'Compile bounded business input into one immutable OpenSlack scenario plan without executing any effect.',
    inputSchema: strictSchema(
      {
        scenarioId: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$',
        },
        input: {
          type: 'object',
          maxProperties: 64,
          additionalProperties: true,
        },
      },
      ['scenarioId', 'input'],
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'openslack_preview_workflow',
    title: 'Preview a governed OpenSlack workflow',
    description:
      'Resolve one host-registered workflow and compile a bounded side-effect manifest without starting it.',
    inputSchema: strictSchema(
      {
        workflowId: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          pattern: '^[a-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*$',
        },
        input: {
          type: 'object',
          maxProperties: 64,
          additionalProperties: true,
        },
        repository: {
          type: 'string',
          minLength: 3,
          maxLength: 200,
          pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$',
        },
      },
      ['workflowId', 'input'],
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'openslack_confirm_plan',
    title: 'Confirm one immutable OpenSlack plan',
    description:
      'Revalidate and atomically claim one unexpired canonical plan for exactly one governed execution.',
    inputSchema: strictSchema(
      {
        planId: {
          type: 'string',
          minLength: 1,
          maxLength: 160,
          pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
        },
        confirmationToken: {
          type: 'string',
          minLength: 32,
          maxLength: 128,
          pattern: '^[A-Za-z0-9_-]+$',
        },
      },
      ['planId', 'confirmationToken'],
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'openslack_cancel_plan',
    title: 'Cancel one pending OpenSlack plan',
    description:
      'Atomically cancel an unclaimed pending plan; executing or terminal plans remain immutable.',
    inputSchema: strictSchema(
      {
        planId: {
          type: 'string',
          minLength: 1,
          maxLength: 160,
          pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
        },
        confirmationToken: {
          type: 'string',
          minLength: 32,
          maxLength: 128,
          pattern: '^[A-Za-z0-9_-]+$',
        },
      },
      ['planId', 'confirmationToken'],
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'openslack_decide_workflow_approval',
    title: 'Decide one OpenSlack workflow effect',
    description:
      'Apply one separately attested human decision to a bound OpenSlack workflow-effect approval; never a GitHub review.',
    inputSchema: strictSchema(
      {
        runId: {
          type: 'string',
          minLength: 1,
          maxLength: 160,
          pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
        },
        approvalId: {
          type: 'string',
          minLength: 1,
          maxLength: 160,
          pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
        },
        decision: { type: 'string', enum: ['approved', 'rejected'] },
        reason: { type: 'string', minLength: 1, maxLength: 1_000 },
      },
      ['runId', 'approvalId', 'decision', 'reason'],
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export const OPENSLACK_READ_TOOL_CATALOG = deepFreeze(
  definitions.map((definition) => ({ ...definition })),
) as readonly OpenSlackReadToolDefinition[];

export const OPENSLACK_MUTATION_TOOL_CATALOG = deepFreeze(
  mutationDefinitions.map((definition) => ({ ...definition })),
) as readonly OpenSlackMutationToolDefinition[];

export const OPENSLACK_DEMO_RESET_TOOL_DEFINITION = deepFreeze({
  name: OPENSLACK_DEMO_RESET_TOOL_NAME,
  title: 'Reset bounded OpenSlack demo fixture',
  description:
    'Invoke a host-injected local demo reset port. This tool is absent from production servers.',
  inputSchema: emptySchema(),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const);

const NOMINAL_CATALOGS = new WeakSet<object>();
const governedMutationToolNames = new Set<string>(OPENSLACK_GOVERNED_MUTATION_TOOL_NAMES);
NOMINAL_CATALOGS.add(OPENSLACK_READ_TOOL_CATALOG);
const DEMO_TOOL_CATALOG = deepFreeze([
  ...OPENSLACK_READ_TOOL_CATALOG,
  OPENSLACK_DEMO_RESET_TOOL_DEFINITION,
]);
NOMINAL_CATALOGS.add(DEMO_TOOL_CATALOG);
const AGENT_MUTATION_TOOL_CATALOG = deepFreeze([
  ...OPENSLACK_READ_TOOL_CATALOG,
  ...OPENSLACK_MUTATION_TOOL_CATALOG.filter((definition) =>
    governedMutationToolNames.has(definition.name),
  ),
]);
const HUMAN_MUTATION_TOOL_CATALOG = deepFreeze([
  ...OPENSLACK_READ_TOOL_CATALOG,
  ...OPENSLACK_MUTATION_TOOL_CATALOG,
]);
const AGENT_MUTATION_DEMO_TOOL_CATALOG = deepFreeze([
  ...AGENT_MUTATION_TOOL_CATALOG,
  OPENSLACK_DEMO_RESET_TOOL_DEFINITION,
]);
const HUMAN_MUTATION_DEMO_TOOL_CATALOG = deepFreeze([
  ...HUMAN_MUTATION_TOOL_CATALOG,
  OPENSLACK_DEMO_RESET_TOOL_DEFINITION,
]);
for (const catalog of [
  AGENT_MUTATION_TOOL_CATALOG,
  HUMAN_MUTATION_TOOL_CATALOG,
  AGENT_MUTATION_DEMO_TOOL_CATALOG,
  HUMAN_MUTATION_DEMO_TOOL_CATALOG,
]) {
  NOMINAL_CATALOGS.add(catalog);
}

export function getOpenSlackToolCatalog(options: {
  readonly includeDemoReset: boolean;
  readonly includeGovernedMutations?: boolean;
  readonly includeWorkflowApproval?: boolean;
}): readonly (
  | OpenSlackReadToolDefinition
  | OpenSlackMutationToolDefinition
  | typeof OPENSLACK_DEMO_RESET_TOOL_DEFINITION
)[] {
  if (!options.includeGovernedMutations) {
    if (options.includeWorkflowApproval) {
      throw new TypeError('Workflow approval cannot be advertised without governed mutations.');
    }
    return options.includeDemoReset ? DEMO_TOOL_CATALOG : OPENSLACK_READ_TOOL_CATALOG;
  }
  if (options.includeWorkflowApproval) {
    return options.includeDemoReset
      ? HUMAN_MUTATION_DEMO_TOOL_CATALOG
      : HUMAN_MUTATION_TOOL_CATALOG;
  }
  return options.includeDemoReset ? AGENT_MUTATION_DEMO_TOOL_CATALOG : AGENT_MUTATION_TOOL_CATALOG;
}

export function assertNominalOpenSlackToolCatalog(value: unknown): void {
  if (typeof value !== 'object' || value === null || !NOMINAL_CATALOGS.has(value)) {
    throw new TypeError('A host-owned nominal OpenSlack tool catalog is required.');
  }
}

const readToolNames = new Set<string>(OPENSLACK_READ_TOOL_NAMES);
const mutationToolNames = new Set<string>(OPENSLACK_MUTATION_TOOL_NAMES);

export function isOpenSlackReadToolName(value: string): value is OpenSlackReadToolName {
  return readToolNames.has(value);
}

export function isOpenSlackMutationToolName(value: string): value is OpenSlackMutationToolName {
  return mutationToolNames.has(value);
}

export function getOpenSlackReadToolDefinition(
  name: string,
): OpenSlackReadToolDefinition | undefined {
  return OPENSLACK_READ_TOOL_CATALOG.find((definition) => definition.name === name);
}

export function getOpenSlackMutationToolDefinition(
  name: string,
): OpenSlackMutationToolDefinition | undefined {
  return OPENSLACK_MUTATION_TOOL_CATALOG.find((definition) => definition.name === name);
}

export class ToolInputValidationError extends Error {
  readonly code = 'INVALID_TOOL_INPUT';
  readonly findings: readonly string[];

  constructor(findings: readonly string[]) {
    const boundedFindings = Object.freeze(
      findings
        .slice(0, MAX_VALIDATION_FINDINGS)
        .map((finding) => finding.slice(0, MAX_VALIDATION_FINDING_LENGTH)),
    );
    super(`Invalid tool input: ${boundedFindings.join('; ')}`);
    this.name = 'ToolInputValidationError';
    this.findings = boundedFindings;
  }
}

const MAX_INPUT_DEPTH = 6;
const MAX_INPUT_NODES = 2_048;
const MAX_INPUT_OBJECT_KEYS = 100;
const MAX_INPUT_KEY_LENGTH = 160;
const MAX_VALIDATION_FINDINGS = 20;
const MAX_VALIDATION_FINDING_LENGTH = 256;

interface CloneBudget {
  nodes: number;
}

function isOrdinaryObjectAcrossRealms(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  if (utilTypes.isProxy(prototype)) return false;
  return Object.getPrototypeOf(prototype) === null;
}

function isOrdinaryArrayAcrossRealms(value: readonly unknown[]): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null || utilTypes.isProxy(prototype)) return false;
  const parent = Object.getPrototypeOf(prototype);
  return parent !== null && !utilTypes.isProxy(parent) && Object.getPrototypeOf(parent) === null;
}

function cloneInertValue(
  value: unknown,
  path: string,
  depth = 0,
  budget: CloneBudget = { nodes: 0 },
): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_INPUT_NODES) {
    throw new ToolInputValidationError(['arguments exceeds the total node limit']);
  }
  if (depth > MAX_INPUT_DEPTH) {
    throw new ToolInputValidationError([`${path} exceeds the depth limit`]);
  }
  if (utilTypes.isProxy(value)) {
    throw new ToolInputValidationError([`${path} must not contain a Proxy`]);
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (!isOrdinaryArrayAcrossRealms(value) || value.length > 1_000) {
      throw new ToolInputValidationError([`${path} must be a bounded ordinary array`]);
    }
    const expected = new Set<string>(['length']);
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index);
      expected.add(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new ToolInputValidationError([`${path} contains sparse or accessor entries`]);
      }
      result.push(cloneInertValue(descriptor.value, `${path}[${index}]`, depth + 1, budget));
    }
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !expected.has(key))) {
      throw new ToolInputValidationError([`${path} contains named or symbol properties`]);
    }
    return Object.freeze(result);
  }
  if (typeof value !== 'object' || value === null) {
    throw new ToolInputValidationError([`${path} contains a non-JSON value`]);
  }
  if (!isOrdinaryObjectAcrossRealms(value)) {
    throw new ToolInputValidationError([`${path} must be an inert plain object`]);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_INPUT_OBJECT_KEYS) {
    throw new ToolInputValidationError([`${path} contains too many properties`]);
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string') {
      throw new ToolInputValidationError([`${path} contains symbol properties`]);
    }
    if (key.length > MAX_INPUT_KEY_LENGTH) {
      throw new ToolInputValidationError([`${path} contains an overlong property name`]);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new ToolInputValidationError([`${path} properties must each be a data property`]);
    }
    result[key] = cloneInertValue(descriptor.value, `${path}.property`, depth + 1, budget);
  }
  return Object.freeze(result);
}

export function validateToolInput(
  definition: Pick<OpenSlackReadToolDefinition | OpenSlackMutationToolDefinition, 'inputSchema'>,
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (utilTypes.isProxy(value)) {
    throw new ToolInputValidationError(['arguments must not be a Proxy']);
  }
  if (value === null || typeof value !== 'object') {
    throw new ToolInputValidationError(['arguments must be an object']);
  }
  if (Array.isArray(value)) {
    throw new ToolInputValidationError(['arguments must be an object']);
  }
  const input = cloneInertValue(value, 'arguments') as Readonly<Record<string, unknown>>;

  const findings: string[] = [];
  const addFinding = (finding: string): void => {
    if (findings.length < MAX_VALIDATION_FINDINGS) findings.push(finding);
  };
  const allowed = new Set(Object.keys(definition.inputSchema.properties));
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    addFinding('unexpected argument properties are not allowed');
  }
  for (const required of definition.inputSchema.required ?? []) {
    if (!Object.hasOwn(input, required)) addFinding(`${required} is required`);
  }

  for (const [key, raw] of Object.entries(input)) {
    const property = definition.inputSchema.properties[key];
    if (!property) continue;
    if (property.type === 'string') {
      if (typeof raw !== 'string') {
        addFinding(`${key} must be a string`);
        continue;
      }
      if (property.minLength !== undefined && raw.length < property.minLength)
        addFinding(`${key} is shorter than ${property.minLength}`);
      if (property.maxLength !== undefined && raw.length > property.maxLength)
        addFinding(`${key} is longer than ${property.maxLength}`);
      if (property.pattern && !new RegExp(property.pattern, 'u').test(raw))
        addFinding(`${key} has an invalid format`);
    } else if (property.type === 'integer') {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) {
        addFinding(`${key} must be an integer`);
        continue;
      }
      if (property.minimum !== undefined && raw < property.minimum)
        addFinding(`${key} must be at least ${property.minimum}`);
      if (property.maximum !== undefined && raw > property.maximum)
        addFinding(`${key} must be at most ${property.maximum}`);
    } else if (property.type === 'boolean' && typeof raw !== 'boolean') {
      addFinding(`${key} must be a boolean`);
    } else if (property.type === 'object') {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        addFinding(`${key} must be an object`);
        continue;
      }
      if (
        property.maxProperties !== undefined &&
        Object.keys(raw).length > property.maxProperties
      ) {
        addFinding(`${key} must contain at most ${property.maxProperties} properties`);
      }
    } else if (property.type === 'array') {
      if (!Array.isArray(raw)) {
        addFinding(`${key} must be an array`);
        continue;
      }
      if (property.minItems !== undefined && raw.length < property.minItems)
        addFinding(`${key} must contain at least ${property.minItems} items`);
      if (property.maxItems !== undefined && raw.length > property.maxItems)
        addFinding(`${key} must contain at most ${property.maxItems} items`);
      if (property.uniqueItems && new Set(raw).size !== raw.length)
        addFinding(`${key} must contain unique items`);
      const item = property.items;
      if (item) {
        raw.forEach((entry, index) => {
          if (typeof entry !== 'string') {
            addFinding(`${key}[${index}] must be a string`);
            return;
          }
          if (item.minLength !== undefined && entry.length < item.minLength)
            addFinding(`${key}[${index}] is shorter than ${item.minLength}`);
          if (item.maxLength !== undefined && entry.length > item.maxLength)
            addFinding(`${key}[${index}] is longer than ${item.maxLength}`);
          if (item.pattern && !new RegExp(item.pattern, 'u').test(entry))
            addFinding(`${key}[${index}] has an invalid format`);
        });
      }
    }
    if (property.enum && !property.enum.includes(raw as never)) {
      addFinding(`${key} must be one of ${property.enum.join(', ')}`);
    }
  }

  if (findings.length > 0) throw new ToolInputValidationError(Object.freeze(findings));
  return input;
}

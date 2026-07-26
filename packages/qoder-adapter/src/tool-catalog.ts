export type JsonSchemaPrimitiveType = 'string' | 'integer' | 'boolean';

export interface JsonSchemaProperty {
  readonly type: JsonSchemaPrimitiveType;
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean)[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
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
] as const);

export type OpenSlackReadToolName = (typeof OPENSLACK_READ_TOOL_NAMES)[number];

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

const toolNames = new Set<string>(OPENSLACK_READ_TOOL_NAMES);

export function isOpenSlackReadToolName(value: string): value is OpenSlackReadToolName {
  return toolNames.has(value);
}

export function getOpenSlackReadToolDefinition(
  name: string,
): OpenSlackReadToolDefinition | undefined {
  return OPENSLACK_READ_TOOL_CATALOG.find((definition) => definition.name === name);
}

export class ToolInputValidationError extends Error {
  readonly code = 'INVALID_TOOL_INPUT';

  constructor(readonly findings: readonly string[]) {
    super(`Invalid tool input: ${findings.join('; ')}`);
    this.name = 'ToolInputValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateToolInput(
  definition: OpenSlackReadToolDefinition,
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new ToolInputValidationError(['arguments must be an object']);
  }

  const findings: string[] = [];
  const allowed = new Set(Object.keys(definition.inputSchema.properties));
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) findings.push(`${key} is not allowed`);
  }
  for (const required of definition.inputSchema.required ?? []) {
    if (!(required in value)) findings.push(`${required} is required`);
  }

  for (const [key, raw] of Object.entries(value)) {
    const property = definition.inputSchema.properties[key];
    if (!property) continue;
    if (property.type === 'string') {
      if (typeof raw !== 'string') {
        findings.push(`${key} must be a string`);
        continue;
      }
      if (property.minLength !== undefined && raw.length < property.minLength)
        findings.push(`${key} is shorter than ${property.minLength}`);
      if (property.maxLength !== undefined && raw.length > property.maxLength)
        findings.push(`${key} is longer than ${property.maxLength}`);
      if (property.pattern && !new RegExp(property.pattern, 'u').test(raw))
        findings.push(`${key} has an invalid format`);
    } else if (property.type === 'integer') {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) {
        findings.push(`${key} must be an integer`);
        continue;
      }
      if (property.minimum !== undefined && raw < property.minimum)
        findings.push(`${key} must be at least ${property.minimum}`);
      if (property.maximum !== undefined && raw > property.maximum)
        findings.push(`${key} must be at most ${property.maximum}`);
    } else if (property.type === 'boolean' && typeof raw !== 'boolean') {
      findings.push(`${key} must be a boolean`);
    }
    if (property.enum && !property.enum.includes(raw as never)) {
      findings.push(`${key} must be one of ${property.enum.join(', ')}`);
    }
  }

  if (findings.length > 0) throw new ToolInputValidationError(Object.freeze(findings));
  return Object.freeze({ ...value });
}

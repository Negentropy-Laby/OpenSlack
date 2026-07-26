import type {
  JSONSchemaDefinition,
  PreviewResult,
  RunResult,
  WorkflowMeta,
  WorkflowRuntime,
} from '@openslack/workflows';

export const meta: WorkflowMeta = {
  name: 'ai-org-transformation',
  version: '1.0.0',
  description:
    'Deterministic six-phase contract for a manufacturing company 90-day AI transformation pilot.',
  whenToUse:
    'Use for the fixed AI-organization interview demo and rehearsals that require stable roles, phases, artifacts, and governance boundaries.',
  phases: [
    {
      title: 'Intake',
      detail: 'Establish the business objective and measurable success criteria.',
    },
    {
      title: 'Discover',
      detail: 'Inventory business processes and data systems with bounded parallelism.',
    },
    { title: 'Select', detail: 'Rank candidate use cases and select one bounded pilot.' },
    { title: 'Design', detail: 'Design the pilot architecture, data path, and agent controls.' },
    {
      title: 'Validate',
      detail: 'Run risk review and an adversarial ROI check with bounded parallelism.',
    },
    { title: 'Deliver', detail: 'Produce the governed 90-day delivery plan and seven artifacts.' },
  ],
  inputs: {
    organization: {
      type: 'string',
      default: '华东精密制造有限公司',
      description: 'Manufacturing organization used by the fixed demo scenario.',
    },
    objective: {
      type: 'string',
      default: '在 90 天内证明一个可审计、可回滚的 AI 试点能够降低质量异常处置周期',
      description: 'Business objective for the pilot.',
    },
    durationDays: {
      type: 'number',
      default: 90,
      description: 'Maximum pilot duration in calendar days.',
    },
    budgetCny: {
      type: 'number',
      default: 500000,
      description: 'Configured pilot budget ceiling in CNY.',
    },
  },
  permissions: {
    github: [],
    git: [],
    filesystem: [],
    openslack: [],
  },
  sideEffects: [],
  forbidden: [
    'github.review.approve',
    'github.pull_request.merge',
    'git.main.push',
    'shell.arbitrary',
  ],
  risk: 'low',
  dynamicPattern: 'fanout-synthesize',
  modelRouting: {
    'business-discovery-agent': 'cheap',
    'data-inventory-agent': 'cheap',
    'solution-architect-agent': 'strong',
    'roi-analyst-agent': 'strong',
    'risk-reviewer-agent': 'strong',
    'delivery-planner-agent': 'strong',
  },
  isolationPolicy: {
    'business-discovery-agent': 'none',
    'data-inventory-agent': 'none',
    'solution-architect-agent': 'none',
    'roi-analyst-agent': 'none',
    'risk-reviewer-agent': 'none',
    'delivery-planner-agent': 'none',
  },
  budgetPolicy: {
    maxAgents: 8,
    maxConcurrency: 2,
    tokenBudget: 64000,
    onExceeded: 'fail',
  },
};

export const DEMO_ROLE_IDS = [
  'business-discovery-agent',
  'data-inventory-agent',
  'solution-architect-agent',
  'roi-analyst-agent',
  'risk-reviewer-agent',
  'delivery-planner-agent',
] as const;

export const DEMO_ARTIFACT_FILES = [
  'executive-summary.md',
  'opportunity-matrix.md',
  'data-system-map.md',
  'roi-model.md',
  'target-architecture.md',
  'risk-register.md',
  '90-day-plan.md',
] as const;

const MAX_RESULT_STRING_LENGTH = 8_000;
const MAX_EVIDENCE_REF_LENGTH = 512;
const MAX_RESULT_ARRAY_ITEMS = 32;
const MAX_RESULT_OBJECT_KEYS = 32;
const MAX_RESULT_DEPTH = 10;
const MAX_RESULT_JSON_BYTES = 256 * 1024;

type DemoRoleId = (typeof DEMO_ROLE_IDS)[number];
type DemoArtifactFile = (typeof DEMO_ARTIFACT_FILES)[number];

interface DemoScenario {
  schema: 'openslack.ai_org_demo_input.v1';
  scenarioId: 'manufacturing-90-day';
  organization: string;
  industry: 'manufacturing';
  objective: string;
  durationDays: number;
  budgetCny: number;
  constraints: string[];
}

interface BusinessDiscoveryResult {
  executiveContext: string;
  processPainPoints: string[];
  successMeasures: string[];
  evidenceRefs: string[];
}

interface DataInventoryResult {
  systems: Array<{
    name: string;
    owner: string;
    dataClass: string;
    readiness: 'ready' | 'partial' | 'blocked';
  }>;
  gaps: string[];
  controls: string[];
  evidenceRefs: string[];
}

interface RoiAnalysisResult {
  candidate: string;
  score: number;
  baselineHours: number;
  projectedHours: number;
  estimatedAnnualValueCny: number;
  assumptions: string[];
  recommendation: string;
  evidenceRefs: string[];
}

interface SolutionArchitectureResult {
  pilotUseCase: string;
  components: string[];
  dataFlow: string[];
  agentControls: string[];
  evidenceRefs: string[];
}

interface RiskReviewResult {
  risks: Array<{
    id: string;
    category: string;
    severity: 'low' | 'medium' | 'high';
    mitigation: string;
    owner: string;
  }>;
  decision: 'proceed' | 'proceed_with_controls' | 'stop';
  approvalPoints: string[];
  evidenceRefs: string[];
}

interface DeliveryPlanResult {
  milestones: Array<{
    day: number;
    deliverable: string;
    owner: string;
    acceptance: string;
  }>;
  metrics: string[];
  rollbackTriggers: string[];
  evidenceRefs: string[];
}

export interface AiOrganizationArtifact {
  filename: DemoArtifactFile;
  title: string;
  ownerAgentType: DemoRoleId;
  content: string;
  evidenceRefs: string[];
}

export interface AiOrganizationWorkflowResult {
  schema: 'openslack.ai_org_demo_workflow_result.v1';
  scenario: DemoScenario;
  phases: Array<{
    id: string;
    status: 'completed';
    agentTypes: DemoRoleId[];
  }>;
  artifacts: AiOrganizationArtifact[];
  governance: {
    workflowCanApproveGitHubReview: false;
    workflowCanMergePullRequest: false;
    githubHumanApprovalRequired: true;
    writesGitHubObjects: false;
    writesMain: false;
  };
  evidenceRefs: string[];
}

const boundedStringSchema: JSONSchemaDefinition = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_RESULT_STRING_LENGTH,
};

const stringArraySchema: JSONSchemaDefinition = {
  type: 'array',
  minItems: 1,
  maxItems: MAX_RESULT_ARRAY_ITEMS,
  items: boundedStringSchema,
};

const evidenceRefsSchema: JSONSchemaDefinition = {
  type: 'array',
  minItems: 1,
  maxItems: MAX_RESULT_ARRAY_ITEMS,
  uniqueItems: true,
  items: {
    type: 'string',
    minLength: 1,
    maxLength: MAX_EVIDENCE_REF_LENGTH,
  },
};

const businessDiscoverySchema: JSONSchemaDefinition = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executiveContext: boundedStringSchema,
    processPainPoints: stringArraySchema,
    successMeasures: stringArraySchema,
    evidenceRefs: evidenceRefsSchema,
  },
  required: ['executiveContext', 'processPainPoints', 'successMeasures', 'evidenceRefs'],
};

const dataInventorySchema: JSONSchemaDefinition = {
  type: 'object',
  additionalProperties: false,
  properties: {
    systems: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_RESULT_ARRAY_ITEMS,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: boundedStringSchema,
          owner: boundedStringSchema,
          dataClass: boundedStringSchema,
          readiness: { type: 'string', enum: ['ready', 'partial', 'blocked'] },
        },
        required: ['name', 'owner', 'dataClass', 'readiness'],
      },
    },
    gaps: stringArraySchema,
    controls: stringArraySchema,
    evidenceRefs: evidenceRefsSchema,
  },
  required: ['systems', 'gaps', 'controls', 'evidenceRefs'],
};

const roiAnalysisSchema: JSONSchemaDefinition = {
  type: 'object',
  additionalProperties: false,
  properties: {
    candidate: boundedStringSchema,
    score: { type: 'number', minimum: 0, maximum: 100 },
    baselineHours: { type: 'number', minimum: 0, maximum: 100_000 },
    projectedHours: { type: 'number', minimum: 0, maximum: 100_000 },
    estimatedAnnualValueCny: { type: 'number', minimum: 0, maximum: 1_000_000_000 },
    assumptions: stringArraySchema,
    recommendation: boundedStringSchema,
    evidenceRefs: evidenceRefsSchema,
  },
  required: [
    'candidate',
    'score',
    'baselineHours',
    'projectedHours',
    'estimatedAnnualValueCny',
    'assumptions',
    'recommendation',
    'evidenceRefs',
  ],
};

const solutionArchitectureSchema: JSONSchemaDefinition = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pilotUseCase: boundedStringSchema,
    components: stringArraySchema,
    dataFlow: stringArraySchema,
    agentControls: stringArraySchema,
    evidenceRefs: evidenceRefsSchema,
  },
  required: ['pilotUseCase', 'components', 'dataFlow', 'agentControls', 'evidenceRefs'],
};

const riskReviewSchema: JSONSchemaDefinition = {
  type: 'object',
  additionalProperties: false,
  properties: {
    risks: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_RESULT_ARRAY_ITEMS,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: boundedStringSchema,
          category: boundedStringSchema,
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          mitigation: boundedStringSchema,
          owner: boundedStringSchema,
        },
        required: ['id', 'category', 'severity', 'mitigation', 'owner'],
      },
    },
    decision: { type: 'string', enum: ['proceed', 'proceed_with_controls', 'stop'] },
    approvalPoints: stringArraySchema,
    evidenceRefs: evidenceRefsSchema,
  },
  required: ['risks', 'decision', 'approvalPoints', 'evidenceRefs'],
};

const deliveryPlanSchema: JSONSchemaDefinition = {
  type: 'object',
  additionalProperties: false,
  properties: {
    milestones: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_RESULT_ARRAY_ITEMS,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          day: { type: 'number', minimum: 1, maximum: 90 },
          deliverable: boundedStringSchema,
          owner: boundedStringSchema,
          acceptance: boundedStringSchema,
        },
        required: ['day', 'deliverable', 'owner', 'acceptance'],
      },
    },
    metrics: stringArraySchema,
    rollbackTriggers: stringArraySchema,
    evidenceRefs: evidenceRefsSchema,
  },
  required: ['milestones', 'metrics', 'rollbackTriggers', 'evidenceRefs'],
};

const SENSITIVE_VALUE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'bearer credential', pattern: /\bbearer\s+[a-z0-9._~+/=-]{8,}/i },
  { name: 'basic credential', pattern: /\bbasic\s+[a-z0-9+/=]{8,}/i },
  { name: 'GitHub token', pattern: /\b(?:ghp_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,})\b/i },
  { name: 'Slack token', pattern: /\bxox[a-z]-[a-z0-9-]{10,}\b/i },
  {
    name: 'private key',
    pattern: /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/i,
  },
  {
    name: 'credential assignment',
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie|password|passwd|client[_-]?secret)\b["']?\s*[:=]\s*[^\s,;]+/i,
  },
];
const SENSITIVE_FIELD_PATTERN =
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie|password|passwd|client[_-]?secret)$/i;

function validateStructuredValue(
  value: unknown,
  schema: JSONSchemaDefinition,
  path = 'result',
): string[] {
  const violations: string[] = [];
  const types =
    schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const actualType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

  if (types.length > 0 && !types.includes(actualType)) {
    return [`${path}: expected ${types.join('|')}, received ${actualType}`];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    violations.push(`${path}: value is outside the allowlist`);
  }
  if (typeof value === 'string') {
    const minLength = typeof schema.minLength === 'number' ? schema.minLength : undefined;
    const maxLength = typeof schema.maxLength === 'number' ? schema.maxLength : undefined;
    if (minLength !== undefined && value.length < minLength) {
      violations.push(`${path}: string is shorter than ${minLength}`);
    }
    if (maxLength !== undefined && value.length > maxLength) {
      violations.push(`${path}: string exceeds ${maxLength} characters`);
    }
  }
  if (typeof value === 'number') {
    const minimum = typeof schema.minimum === 'number' ? schema.minimum : undefined;
    const maximum = typeof schema.maximum === 'number' ? schema.maximum : undefined;
    if (!Number.isFinite(value)) violations.push(`${path}: number must be finite`);
    if (minimum !== undefined && value < minimum) {
      violations.push(`${path}: number is below ${minimum}`);
    }
    if (maximum !== undefined && value > maximum) {
      violations.push(`${path}: number exceeds ${maximum}`);
    }
  }
  if (Array.isArray(value)) {
    const minItems = typeof schema.minItems === 'number' ? schema.minItems : undefined;
    const maxItems = typeof schema.maxItems === 'number' ? schema.maxItems : undefined;
    if (minItems !== undefined && value.length < minItems) {
      violations.push(`${path}: array has fewer than ${minItems} items`);
    }
    if (maxItems !== undefined && value.length > maxItems) {
      violations.push(`${path}: array exceeds ${maxItems} items`);
    }
    const itemSchema = Array.isArray(schema.items) ? undefined : schema.items;
    if (itemSchema) {
      value.forEach((item, index) => {
        violations.push(...validateStructuredValue(item, itemSchema, `${path}[${index}]`));
      });
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      const extras = Object.keys(object).filter((key) => !(key in properties));
      if (extras.length > 0) violations.push(`${path}: unexpected fields ${extras.join(', ')}`);
    }
    for (const required of schema.required ?? []) {
      if (!(required in object)) violations.push(`${path}.${required}: required field missing`);
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in object) {
        violations.push(...validateStructuredValue(object[key], propertySchema, `${path}.${key}`));
      }
    }
  }
  return violations;
}

export function assertNoSensitiveAiOrganizationValues(value: unknown, label: string): void {
  let serialized: string;
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') throw new Error('not serializable');
    serialized = json;
  } catch {
    throw new Error(`${label} is not JSON serializable.`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_JSON_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_RESULT_JSON_BYTES}-byte result boundary.`);
  }

  const visit = (candidate: unknown, path: string, depth: number): void => {
    if (depth > MAX_RESULT_DEPTH) throw new Error(`${label}.${path} exceeds the depth boundary.`);
    if (typeof candidate === 'string') {
      if (candidate.length > MAX_RESULT_STRING_LENGTH) {
        throw new Error(`${label}.${path} exceeds the string length boundary.`);
      }
      const match = SENSITIVE_VALUE_PATTERNS.find(({ pattern }) => pattern.test(candidate));
      if (match) throw new Error(`${label}.${path} contains a blocked ${match.name}.`);
      return;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_RESULT_ARRAY_ITEMS) {
        throw new Error(`${label}.${path} exceeds the array item boundary.`);
      }
      candidate.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (candidate !== null && typeof candidate === 'object') {
      const entries = Object.entries(candidate as Record<string, unknown>);
      if (entries.length > MAX_RESULT_OBJECT_KEYS) {
        throw new Error(`${label}.${path} exceeds the object key boundary.`);
      }
      for (const [key, item] of entries) {
        if (SENSITIVE_FIELD_PATTERN.test(key)) {
          throw new Error(`${label}.${path}.${key} is a blocked credential field.`);
        }
        visit(item, `${path}.${key}`, depth + 1);
      }
    }
  };
  visit(value, 'root', 0);
}

function assertAgentResult<T>(label: string, value: T, schema: JSONSchemaDefinition): T {
  const violations = validateStructuredValue(value, schema);
  if (violations.length > 0) {
    throw new Error(`${label} failed strict result validation: ${violations.join('; ')}`);
  }
  assertNoSensitiveAiOrganizationValues(value, label);
  return value;
}

function scenarioFromArgs(args: Record<string, unknown>): DemoScenario {
  const allowedKeys = new Set(['organization', 'objective', 'durationDays', 'budgetCny']);
  const unknownKeys = Object.keys(args).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown workflow input keys: ${unknownKeys.join(', ')}.`);
  }
  const organizationInput = args.organization;
  const objectiveInput = args.objective;
  const durationDaysInput = args.durationDays;
  const budgetCnyInput = args.budgetCny;
  if (organizationInput !== undefined && typeof organizationInput !== 'string') {
    throw new Error('organization must be a string.');
  }
  if (objectiveInput !== undefined && typeof objectiveInput !== 'string') {
    throw new Error('objective must be a string.');
  }
  if (durationDaysInput !== undefined && typeof durationDaysInput !== 'number') {
    throw new Error('durationDays must be a number.');
  }
  if (budgetCnyInput !== undefined && typeof budgetCnyInput !== 'number') {
    throw new Error('budgetCny must be a number.');
  }
  const durationDays = durationDaysInput ?? 90;
  const budgetCny = budgetCnyInput ?? 500000;
  const organization = (organizationInput ?? '华东精密制造有限公司').trim();
  const objective = (
    objectiveInput ?? '在 90 天内证明一个可审计、可回滚的 AI 试点能够降低质量异常处置周期'
  ).trim();
  if (!Number.isInteger(durationDays) || durationDays <= 0 || durationDays > 90) {
    throw new Error('durationDays must be an integer from 1 through 90.');
  }
  if (!Number.isInteger(budgetCny) || budgetCny <= 0 || budgetCny > 1_000_000_000) {
    throw new Error('budgetCny must be a positive integer no greater than 1000000000.');
  }
  if (organization.length < 1 || organization.length > 256) {
    throw new Error('organization must contain 1 through 256 characters.');
  }
  if (objective.length < 1 || objective.length > 2_000) {
    throw new Error('objective must contain 1 through 2000 characters.');
  }

  const scenario: DemoScenario = {
    schema: 'openslack.ai_org_demo_input.v1',
    scenarioId: 'manufacturing-90-day',
    organization,
    industry: 'manufacturing',
    objective,
    durationDays,
    budgetCny,
    constraints: [
      'GitHub remains the formal task, review, and delivery source of truth.',
      'Agents cannot approve GitHub reviews or merge pull requests.',
      'Configured estimates must never be presented as observed revenue.',
      'The pilot must be reversible inside 90 days.',
    ],
  };
  assertNoSensitiveAiOrganizationValues(scenario, 'scenario');
  return scenario;
}

function promptFor(
  role: DemoRoleId,
  instruction: string,
  context: Record<string, unknown>,
): string {
  return [
    `You are acting as ${role} for the fixed manufacturing 90-day AI pilot.`,
    instruction,
    'Return only the structured result requested by the provided JSON schema.',
    'Do not approve a GitHub review, merge a pull request, push to main, or claim unobserved value.',
    `Context: ${JSON.stringify(context)}`,
  ].join('\n');
}

function bulletList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '- Unknown';
}

function table(headers: string[], rows: string[][]): string {
  const heading = `| ${headers.join(' | ')} |`;
  const divider = `| ${headers.map(() => '---').join(' | ')} |`;
  return [heading, divider, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');
}

function artifact(
  filename: DemoArtifactFile,
  title: string,
  ownerAgentType: DemoRoleId,
  sections: string[],
  evidenceRefs: string[],
): AiOrganizationArtifact {
  return {
    filename,
    title,
    ownerAgentType,
    content: [`# ${title}`, '', ...sections].join('\n').trimEnd() + '\n',
    evidenceRefs: Array.from(new Set(evidenceRefs)),
  };
}

function synthesizeArtifacts(results: {
  scenario: DemoScenario;
  intake: BusinessDiscoveryResult;
  processDiscovery: BusinessDiscoveryResult;
  inventory: DataInventoryResult;
  roi: RoiAnalysisResult;
  architecture: SolutionArchitectureResult;
  risk: RiskReviewResult;
  roiChallenge: RoiAnalysisResult;
  delivery: DeliveryPlanResult;
}): AiOrganizationArtifact[] {
  const {
    scenario,
    intake,
    processDiscovery,
    inventory,
    roi,
    architecture,
    risk,
    roiChallenge,
    delivery,
  } = results;

  return [
    artifact(
      'executive-summary.md',
      '制造企业 90 天 AI 转型试点执行摘要',
      'business-discovery-agent',
      [
        `组织：${scenario.organization}`,
        '',
        `目标：${scenario.objective}`,
        '',
        '## 管理背景',
        '',
        intake.executiveContext,
        '',
        '## 关键痛点',
        '',
        bulletList(processDiscovery.processPainPoints),
        '',
        '## 成功标准',
        '',
        bulletList(intake.successMeasures),
      ],
      [...intake.evidenceRefs, ...processDiscovery.evidenceRefs],
    ),
    artifact(
      'opportunity-matrix.md',
      '试点机会矩阵',
      'roi-analyst-agent',
      [
        table(
          ['候选场景', '评分', '基线小时', '目标小时', '建议'],
          [
            [
              roi.candidate,
              String(roi.score),
              String(roi.baselineHours),
              String(roi.projectedHours),
              roi.recommendation,
            ],
          ],
        ),
        '',
        '估值均为配置假设，不是已观察收入。',
      ],
      roi.evidenceRefs,
    ),
    artifact(
      'data-system-map.md',
      '数据与系统地图',
      'data-inventory-agent',
      [
        table(
          ['系统', '负责人', '数据分类', '准备度'],
          inventory.systems.map((system) => [
            system.name,
            system.owner,
            system.dataClass,
            system.readiness,
          ]),
        ),
        '',
        '## 缺口',
        '',
        bulletList(inventory.gaps),
        '',
        '## 控制措施',
        '',
        bulletList(inventory.controls),
      ],
      inventory.evidenceRefs,
    ),
    artifact(
      'roi-model.md',
      'ROI 假设模型',
      'roi-analyst-agent',
      [
        `候选场景：${roi.candidate}`,
        '',
        `配置估算年化价值（CNY）：${roi.estimatedAnnualValueCny}`,
        '',
        '## 原始假设',
        '',
        bulletList(roi.assumptions),
        '',
        '## 反方校验',
        '',
        roiChallenge.recommendation,
        '',
        bulletList(roiChallenge.assumptions),
        '',
        '所有价值数字的 basis 均为 configured_estimate；正式试点数据缺失时不得升级为 observed。',
      ],
      [...roi.evidenceRefs, ...roiChallenge.evidenceRefs],
    ),
    artifact(
      'target-architecture.md',
      '目标架构',
      'solution-architect-agent',
      [
        `试点用例：${architecture.pilotUseCase}`,
        '',
        '## 组件',
        '',
        bulletList(architecture.components),
        '',
        '## 数据流',
        '',
        architecture.dataFlow.map((step, index) => `${index + 1}. ${step}`).join('\n'),
        '',
        '## Agent 控制',
        '',
        bulletList(architecture.agentControls),
      ],
      architecture.evidenceRefs,
    ),
    artifact(
      'risk-register.md',
      '风险登记册',
      'risk-reviewer-agent',
      [
        `审查结论：${risk.decision}`,
        '',
        table(
          ['ID', '类别', '等级', '缓解措施', '负责人'],
          risk.risks.map((item) => [
            item.id,
            item.category,
            item.severity,
            item.mitigation,
            item.owner,
          ]),
        ),
        '',
        '## 人工决策点',
        '',
        bulletList(risk.approvalPoints),
      ],
      risk.evidenceRefs,
    ),
    artifact(
      '90-day-plan.md',
      '90 天实施计划',
      'delivery-planner-agent',
      [
        table(
          ['天数', '交付物', '负责人', '验收'],
          delivery.milestones.map((milestone) => [
            String(milestone.day),
            milestone.deliverable,
            milestone.owner,
            milestone.acceptance,
          ]),
        ),
        '',
        '## 指标',
        '',
        bulletList(delivery.metrics),
        '',
        '## 回滚触发条件',
        '',
        bulletList(delivery.rollbackTriggers),
      ],
      delivery.evidenceRefs,
    ),
  ];
}

interface StructuredAgentResults {
  scenario: DemoScenario;
  intake: BusinessDiscoveryResult;
  processDiscovery: BusinessDiscoveryResult;
  inventory: DataInventoryResult;
  roi: RoiAnalysisResult;
  architecture: SolutionArchitectureResult;
  risk: RiskReviewResult;
  roiChallenge: RoiAnalysisResult;
  delivery: DeliveryPlanResult;
}

function dryRunAgentResults(scenario: DemoScenario): StructuredAgentResults {
  const business: BusinessDiscoveryResult = {
    executiveContext: 'Dry-run: current-state evidence will be collected from bounded sources.',
    processPainPoints: ['Dry-run: process handoffs and evidence gaps will be inventoried.'],
    successMeasures: ['Dry-run: cycle time and evidence completeness will be measured.'],
    evidenceRefs: ['workflow:dry-run/business-discovery'],
  };
  const roi: RoiAnalysisResult = {
    candidate: 'Dry-run candidate: quality exception handling copilot',
    score: 0,
    baselineHours: 0,
    projectedHours: 0,
    estimatedAnnualValueCny: 0,
    assumptions: ['Dry-run values are placeholders with configured_estimate basis.'],
    recommendation: 'Collect observed baseline evidence before any value claim.',
    evidenceRefs: ['workflow:dry-run/roi-analysis'],
  };
  return {
    scenario,
    intake: structuredClone(business),
    processDiscovery: structuredClone(business),
    inventory: {
      systems: [
        {
          name: 'Dry-run system inventory',
          owner: 'To be confirmed',
          dataClass: 'unknown',
          readiness: 'blocked',
        },
      ],
      gaps: ['Dry-run: source-system readiness has not been observed.'],
      controls: ['Dry-run performs no network access or external write.'],
      evidenceRefs: ['workflow:dry-run/data-inventory'],
    },
    roi,
    architecture: {
      pilotUseCase: roi.candidate,
      components: ['OpenSlack Workflow', 'GitHub governance boundary', 'read-only projection'],
      dataFlow: ['Read-only evidence to governed projection'],
      agentControls: ['No GitHub approval, merge, or main write authority'],
      evidenceRefs: ['workflow:dry-run/solution-architecture'],
    },
    risk: {
      risks: [
        {
          id: 'DRY-RUN-R1',
          category: 'evidence',
          severity: 'medium',
          mitigation: 'Collect observed evidence before execution.',
          owner: 'Human pilot owner',
        },
      ],
      decision: 'proceed_with_controls',
      approvalPoints: ['Independent human GitHub Review remains required.'],
      evidenceRefs: ['workflow:dry-run/risk-review'],
    },
    roiChallenge: {
      ...structuredClone(roi),
      recommendation: 'Dry-run cannot establish observed business value.',
      evidenceRefs: ['workflow:dry-run/roi-challenge'],
    },
    delivery: {
      milestones: [
        {
          day: 90,
          deliverable: 'Governed pilot evidence package',
          owner: 'Human pilot owner',
          acceptance: 'Observed evidence supports an explicit continue, adjust, or stop decision.',
        },
      ],
      metrics: ['Cycle hours', 'Evidence completeness', 'Unauthorized writes'],
      rollbackTriggers: ['Any unauthorized write or non-traceable conclusion'],
      evidenceRefs: ['workflow:dry-run/delivery-plan'],
    },
  };
}

function assembleWorkflowResult(results: StructuredAgentResults): AiOrganizationWorkflowResult {
  assertNoSensitiveAiOrganizationValues(results, 'structured workflow results');
  const artifacts = synthesizeArtifacts(results);
  const evidenceRefs = Array.from(
    new Set(artifacts.flatMap((item) => item.evidenceRefs).filter(Boolean)),
  );

  const result: AiOrganizationWorkflowResult = {
    schema: 'openslack.ai_org_demo_workflow_result.v1',
    scenario: results.scenario,
    phases: [
      {
        id: 'Intake',
        status: 'completed',
        agentTypes: ['business-discovery-agent'],
      },
      {
        id: 'Discover',
        status: 'completed',
        agentTypes: ['business-discovery-agent', 'data-inventory-agent'],
      },
      { id: 'Select', status: 'completed', agentTypes: ['roi-analyst-agent'] },
      {
        id: 'Design',
        status: 'completed',
        agentTypes: ['solution-architect-agent'],
      },
      {
        id: 'Validate',
        status: 'completed',
        agentTypes: ['risk-reviewer-agent', 'roi-analyst-agent'],
      },
      {
        id: 'Deliver',
        status: 'completed',
        agentTypes: ['delivery-planner-agent'],
      },
    ],
    artifacts,
    governance: {
      workflowCanApproveGitHubReview: false,
      workflowCanMergePullRequest: false,
      githubHumanApprovalRequired: true,
      writesGitHubObjects: false,
      writesMain: false,
    },
    evidenceRefs,
  };
  assertNoSensitiveAiOrganizationValues(result, 'workflow result');
  return result;
}

async function executeContract(
  ctx: WorkflowRuntime,
  args: Record<string, unknown>,
): Promise<AiOrganizationWorkflowResult> {
  const scenario = scenarioFromArgs(args);
  if (ctx.mode === 'dry-run') {
    const results = dryRunAgentResults(scenario);
    assertAgentResult('dry-run intake', results.intake, businessDiscoverySchema);
    assertAgentResult(
      'dry-run process discovery',
      results.processDiscovery,
      businessDiscoverySchema,
    );
    assertAgentResult('dry-run inventory', results.inventory, dataInventorySchema);
    assertAgentResult('dry-run ROI analysis', results.roi, roiAnalysisSchema);
    assertAgentResult('dry-run architecture', results.architecture, solutionArchitectureSchema);
    assertAgentResult('dry-run risk review', results.risk, riskReviewSchema);
    assertAgentResult('dry-run ROI challenge', results.roiChallenge, roiAnalysisSchema);
    assertAgentResult('dry-run delivery plan', results.delivery, deliveryPlanSchema);
    return assembleWorkflowResult(results);
  }

  ctx.phase('Intake');
  const intake = assertAgentResult(
    'intake:business-context',
    await ctx.agent<BusinessDiscoveryResult>(
      promptFor(
        'business-discovery-agent',
        'Frame the executive context, measurable success criteria, and hard business constraints.',
        { scenario },
      ),
      {
        agentType: 'business-discovery-agent',
        label: 'intake:business-context',
        phase: 'Intake',
        schema: businessDiscoverySchema,
        isolation: 'none',
        budget: { tokens: 5000, costUsd: 0.25 },
      },
    ),
    businessDiscoverySchema,
  );

  ctx.phase('Discover');
  const [processDiscoveryRaw, inventoryRaw] = await ctx.parallel(
    [
      () =>
        ctx.agent<BusinessDiscoveryResult>(
          promptFor(
            'business-discovery-agent',
            'Map the current quality-exception process, pain points, and measurable handoff delays.',
            { scenario, intake },
          ),
          {
            agentType: 'business-discovery-agent',
            label: 'discover:business-process',
            phase: 'Discover',
            schema: businessDiscoverySchema,
            isolation: 'none',
            budget: { tokens: 5000, costUsd: 0.25 },
          },
        ),
      () =>
        ctx.agent<DataInventoryResult>(
          promptFor(
            'data-inventory-agent',
            'Inventory only the systems and data needed by the bounded pilot, including owners and readiness.',
            { scenario, intake },
          ),
          {
            agentType: 'data-inventory-agent',
            label: 'discover:data-systems',
            phase: 'Discover',
            schema: dataInventorySchema,
            isolation: 'none',
            budget: { tokens: 5000, costUsd: 0.25 },
          },
        ),
    ],
    { concurrency: 2 },
  );
  const processDiscovery = assertAgentResult(
    'discover:business-process',
    processDiscoveryRaw,
    businessDiscoverySchema,
  );
  const inventory = assertAgentResult('discover:data-systems', inventoryRaw, dataInventorySchema);

  ctx.phase('Select');
  const roi = assertAgentResult(
    'select:pilot-roi',
    await ctx.agent<RoiAnalysisResult>(
      promptFor(
        'roi-analyst-agent',
        'Score candidate use cases, select one pilot, and label every financial value as a configured estimate.',
        { scenario, processDiscovery, inventory },
      ),
      {
        agentType: 'roi-analyst-agent',
        label: 'select:pilot-roi',
        phase: 'Select',
        schema: roiAnalysisSchema,
        isolation: 'none',
        budget: { tokens: 6000, costUsd: 0.3 },
      },
    ),
    roiAnalysisSchema,
  );

  ctx.phase('Design');
  const architecture = assertAgentResult(
    'design:target-architecture',
    await ctx.agent<SolutionArchitectureResult>(
      promptFor(
        'solution-architect-agent',
        'Design a reversible pilot architecture with explicit data paths, evidence, and least-privilege agent controls.',
        { scenario, inventory, roi },
      ),
      {
        agentType: 'solution-architect-agent',
        label: 'design:target-architecture',
        phase: 'Design',
        schema: solutionArchitectureSchema,
        isolation: 'none',
        budget: { tokens: 7000, costUsd: 0.4 },
      },
    ),
    solutionArchitectureSchema,
  );

  ctx.phase('Validate');
  const [riskRaw, roiChallengeRaw] = await ctx.parallel(
    [
      () =>
        ctx.agent<RiskReviewResult>(
          promptFor(
            'risk-reviewer-agent',
            'Review privacy, safety, governance, adoption, and rollback risks. Preserve human approval boundaries.',
            { scenario, inventory, roi, architecture },
          ),
          {
            agentType: 'risk-reviewer-agent',
            label: 'validate:risk-review',
            phase: 'Validate',
            schema: riskReviewSchema,
            isolation: 'none',
            budget: { tokens: 6000, costUsd: 0.35 },
          },
        ),
      () =>
        ctx.agent<RoiAnalysisResult>(
          promptFor(
            'roi-analyst-agent',
            'Act as an adversarial verifier: challenge the ROI assumptions and state what must be observed before claiming value.',
            { scenario, roi, architecture },
          ),
          {
            agentType: 'roi-analyst-agent',
            label: 'validate:roi-adversarial',
            phase: 'Validate',
            schema: roiAnalysisSchema,
            isolation: 'none',
            budget: { tokens: 6000, costUsd: 0.35 },
          },
        ),
    ],
    { concurrency: 2 },
  );
  const risk = assertAgentResult('validate:risk-review', riskRaw, riskReviewSchema);
  const roiChallenge = assertAgentResult(
    'validate:roi-adversarial',
    roiChallengeRaw,
    roiAnalysisSchema,
  );

  ctx.phase('Deliver');
  const delivery = assertAgentResult(
    'deliver:90-day-plan',
    await ctx.agent<DeliveryPlanResult>(
      promptFor(
        'delivery-planner-agent',
        'Produce a day-bounded delivery plan with acceptance criteria, owners, metrics, and rollback triggers.',
        { scenario, roi, architecture, risk, roiChallenge },
      ),
      {
        agentType: 'delivery-planner-agent',
        label: 'deliver:90-day-plan',
        phase: 'Deliver',
        schema: deliveryPlanSchema,
        isolation: 'none',
        budget: { tokens: 7000, costUsd: 0.4 },
      },
    ),
    deliveryPlanSchema,
  );

  return assembleWorkflowResult({
    scenario,
    intake,
    processDiscovery,
    inventory,
    roi,
    architecture,
    risk,
    roiChallenge,
    delivery,
  });
}

export async function preview(
  _ctx: WorkflowRuntime,
  args: Record<string, unknown>,
): Promise<PreviewResult> {
  const scenario = scenarioFromArgs(args);
  return {
    preview: true,
    schema: 'openslack.ai_org_demo_preview.v1',
    scenario,
    phases: meta.phases.map((phase) => ({ title: phase.title, detail: phase.detail })),
    roles: [...DEMO_ROLE_IDS],
    artifactFiles: [...DEMO_ARTIFACT_FILES],
    governance: {
      githubHumanApprovalRequired: true,
      workflowCanApproveGitHubReview: false,
      workflowCanMergePullRequest: false,
      writesGitHubObjects: false,
      writesMain: false,
    },
    budgetContract: {
      maxAgents: meta.budgetPolicy?.maxAgents,
      maxConcurrency: meta.budgetPolicy?.maxConcurrency,
      tokenBudget: meta.budgetPolicy?.tokenBudget,
      onExceeded: meta.budgetPolicy?.onExceeded,
      plannedAgentCalls: 8,
    },
  };
}

export async function run(ctx: WorkflowRuntime, args: Record<string, unknown>): Promise<RunResult> {
  return { status: 'completed', ...(await executeContract(ctx, args)) };
}

import { types as utilTypes } from 'node:util';
import {
  OPENSLACK_DEMO_RESET_TOOL_NAME,
  OPENSLACK_GOVERNED_MUTATION_TOOL_NAMES,
  OPENSLACK_MUTATION_TOOL_NAMES,
  OPENSLACK_READ_TOOL_NAMES,
  OPENSLACK_TOOL_CATALOG_COMPOSITION,
  OPENSLACK_WORKFLOW_APPROVAL_TOOL_NAMES,
  ToolInputValidationError,
  assertNominalOpenSlackToolCatalog,
  createOpenSlackMcpResult,
  getOpenSlackToolCatalog,
  isOpenSlackMutationToolName,
  isOpenSlackReadToolName,
  upgradeOpenSlackMcpResult,
  validateToolInput,
  type OpenSlackMcpResult,
  type OpenSlackMcpResultV2,
  type OpenSlackToolName,
} from '@openslack/qoder-adapter';
import type { OpenSlackMcpContext } from './context.js';
import { OpenSlackMcpProtocolError, safeToolError, type OpenSlackMcpToolError } from './errors.js';
import { projectToolData } from './projections.js';
import {
  normalizeTypedEvidenceReference,
  normalizeTypedEvidenceReferences,
  redactProtocolString,
} from './sanitizer.js';
import { OPENSLACK_READ_TOOL_HANDLERS } from './tools/index.js';
import {
  callGovernedMutationTool,
  governedMutationRecordResult,
  type GovernedMutationToolResult,
} from './tools/mutations.js';
import {
  callWorkflowApprovalTool,
  workflowApprovalRecordResult,
  type WorkflowApprovalToolResult,
} from './tools/workflow-approvals.js';
import { evidenceFrom, normalizeEvidenceReferences } from './tools/shared.js';

export interface OpenSlackMcpContent {
  readonly type: 'text';
  readonly text: string;
}

export interface OpenSlackMcpToolCallResult {
  readonly content: readonly OpenSlackMcpContent[];
  readonly structuredContent: Readonly<Record<string, unknown>>;
  readonly isError: boolean;
}

export interface OpenSlackMcpCoreOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;
const MIN_MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_TEXT_LENGTH = 4_000;
const MAX_ARRAY_ITEMS = 500;
const MAX_OBJECT_KEYS = 200;
const SENSITIVE_NORMALIZED_KEYS = new Set([
  'apikey',
  'accesskey',
  'accesskeyid',
  'secret',
  'secretkey',
  'secretaccesskey',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'npmtoken',
  'password',
  'passwd',
  'authorization',
  'proxyauthorization',
  'auth',
  'cookie',
  'setcookie',
  'session',
  'sessionid',
  'privatekey',
  'jwt',
]);
function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    SENSITIVE_NORMALIZED_KEYS.has(normalized) ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('clientsecret') ||
    normalized.endsWith('password') ||
    normalized.endsWith('token') ||
    normalized.endsWith('cookie') ||
    normalized.endsWith('sessionid')
  );
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return resolved;
}

function redactString(value: string): string {
  return redactProtocolString(value, MAX_TEXT_LENGTH);
}

const CONFIRMATION_CAPABILITY = /^[A-Za-z0-9_-]{32,128}$/;

function sanitizeForProtocol(
  value: unknown,
  depth = 0,
  preserveRootConfirmationToken = false,
): unknown {
  if (depth > 12) return '[MAX_DEPTH]';
  if (value === null || value === undefined || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return redactString(value);
  if ((typeof value === 'object' || typeof value === 'function') && utilTypes.isProxy(value)) {
    throw new TypeError('PROTOCOL_OUTPUT_PROXY_REJECTED');
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (let index = 0; index < Math.min(value.length, MAX_ARRAY_ITEMS); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      const sanitized =
        descriptor && Object.hasOwn(descriptor, 'value')
          ? sanitizeForProtocol(descriptor.value, depth + 1, preserveRootConfirmationToken)
          : '[UNSAFE_ARRAY_ENTRY]';
      output.push(sanitized === undefined ? null : sanitized);
    }
    return output;
  }
  if (typeof value !== 'object') return String(value);
  const output: Record<string, unknown> = {};
  const keys = Reflect.ownKeys(value)
    .filter((key): key is string => typeof key === 'string')
    .slice(0, MAX_OBJECT_KEYS);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      output[key] = '[UNSAFE_PROPERTY]';
      continue;
    }
    const child = descriptor.value;
    if (key === 'evidenceRef') {
      if (typeof child === 'string') {
        const reference = normalizeTypedEvidenceReference(child);
        if (reference) output[key] = reference;
      }
      continue;
    }
    if (key === 'evidenceRefs') {
      if (
        (typeof child === 'object' || typeof child === 'function') &&
        child !== null &&
        utilTypes.isProxy(child)
      ) {
        throw new TypeError('PROTOCOL_OUTPUT_PROXY_REJECTED');
      }
      output[key] = Array.isArray(child) ? normalizeTypedEvidenceReferences(child) : [];
      continue;
    }
    // Confirmation capabilities are bearer secrets. Only the explicit root response
    // field may survive sanitization; nested copies remain subject to key redaction.
    if (
      depth === 0 &&
      preserveRootConfirmationToken &&
      key === 'confirmationToken' &&
      typeof child === 'string' &&
      CONFIRMATION_CAPABILITY.test(child)
    ) {
      output[key] = child;
      continue;
    }
    const sanitized = isSensitiveKey(key)
      ? '[REDACTED]'
      : sanitizeForProtocol(child, depth + 1, preserveRootConfirmationToken);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function failedResult(code: string, message: string): OpenSlackMcpResult {
  return createOpenSlackMcpResult({
    status: 'failed',
    summary: message,
    error: { code, message },
    governance: { blocker: code },
  });
}

function toolErrorResult(error: OpenSlackMcpToolError): OpenSlackMcpResult {
  if (error.safeStatus === 'blocked') {
    return createOpenSlackMcpResult({
      status: 'blocked',
      summary: error.safeMessage,
      governance: { blocker: error.safeCode },
    });
  }
  return failedResult(error.safeCode, error.safeMessage);
}

class ToolDeadlineExceededError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ToolDeadlineExceededError';
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
  timeoutCode = 'READ_PROJECTION_TIMEOUT',
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort(new Error(timeoutCode));
          reject(new ToolDeadlineExceededError(timeoutCode));
        }, timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function deepFreezeJson<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && Object.hasOwn(descriptor, 'value')) deepFreezeJson(descriptor.value);
    }
    Object.freeze(value);
  }
  return value;
}

const AUTHORITY_SOURCES = Object.freeze({
  openslack_get_executive_overview: Object.freeze([
    'openslack.module_registry',
    'openslack.collaboration_projection',
  ]),
  openslack_list_work_items: Object.freeze(['openslack.collaboration_events']),
  openslack_get_work_room: Object.freeze(['openslack.collaboration_projection']),
  openslack_get_activity: Object.freeze(['openslack.collaboration_events']),
  openslack_get_workflow_progress: Object.freeze(['openslack.workflow_run_store']),
  openslack_get_pr_readiness: Object.freeze(['github.live', 'openslack.prms']),
  openslack_list_pending_approvals: Object.freeze([
    'openslack.operator_plans',
    'openslack.workflow_governance',
    'github.review_evidence',
  ]),
  openslack_get_business_outcomes: Object.freeze(['openslack.business_outcome_projection']),
  openslack_get_notification_status: Object.freeze(['openslack.notification_projection']),
  openslack_list_scenarios: Object.freeze(['openslack.locked_scenario_pack']),
  openslack_query_graph: Object.freeze(['openslack.organization_graph_snapshot']),
  openslack_explain_graph: Object.freeze(['openslack.organization_graph_snapshot']),
  openslack_preview_scenario: Object.freeze([
    'openslack.locked_scenario_pack',
    'openslack.governed_plan_store',
  ]),
  openslack_preview_workflow: Object.freeze([
    'openslack.sealed_workflow_registry',
    'openslack.governed_plan_store',
  ]),
  openslack_confirm_plan: Object.freeze([
    'openslack.governed_plan_store',
    'openslack.typed_action_registry',
  ]),
  openslack_cancel_plan: Object.freeze(['openslack.governed_plan_store']),
  openslack_decide_workflow_approval: Object.freeze(['openslack.workflow_effect_approval_v2']),
  openslack_demo_reset: Object.freeze(['openslack.local_demo_fixture']),
}) satisfies Readonly<Record<OpenSlackToolName, readonly string[]>>;

function observedAt(value: unknown, fallback: Date): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const candidate = (value as Record<string, unknown>).generatedAt;
    if (typeof candidate === 'string') {
      const parsed = new Date(candidate);
      if (Number.isFinite(parsed.getTime()) && parsed.toISOString() === candidate) return candidate;
    }
  }
  return fallback.toISOString();
}

function assertFrozenCatalog(
  includeDemoReset: boolean,
  includeGovernedMutations: boolean,
  includeWorkflowApproval: boolean,
): void {
  const catalog = getOpenSlackToolCatalog({
    includeDemoReset,
    includeGovernedMutations,
    includeWorkflowApproval,
  });
  assertNominalOpenSlackToolCatalog(catalog);
  const { components, profiles } = OPENSLACK_TOOL_CATALOG_COMPOSITION;
  const expectedProfileLength = includeWorkflowApproval
    ? profiles.humanAttested
    : includeGovernedMutations
      ? profiles.agentBound
      : profiles.productionReadOnly;
  const expectedLength = expectedProfileLength + (includeDemoReset ? components.demoReset : 0);
  if (
    catalog.length !== expectedLength ||
    OPENSLACK_READ_TOOL_NAMES.length !== components.read ||
    OPENSLACK_GOVERNED_MUTATION_TOOL_NAMES.length !== components.governedMutations ||
    OPENSLACK_WORKFLOW_APPROVAL_TOOL_NAMES.length !== components.workflowApproval ||
    OPENSLACK_MUTATION_TOOL_NAMES.length !==
      components.governedMutations + components.workflowApproval ||
    profiles.productionReadOnly !== components.read ||
    profiles.agentBound !== components.read + components.governedMutations ||
    profiles.humanAttested !==
      components.read + components.governedMutations + components.workflowApproval ||
    !Object.isFrozen(catalog)
  ) {
    throw new Error('READ_TOOL_CATALOG_INVALID');
  }
  const catalogNames = catalog.map((tool) => tool.name);
  if (
    new Set(catalogNames).size !== expectedLength ||
    OPENSLACK_READ_TOOL_NAMES.some((name) => !catalogNames.includes(name)) ||
    OPENSLACK_READ_TOOL_NAMES.some((name) => !(name in OPENSLACK_READ_TOOL_HANDLERS)) ||
    includeGovernedMutations !==
      OPENSLACK_GOVERNED_MUTATION_TOOL_NAMES.every((name) => catalogNames.includes(name)) ||
    includeWorkflowApproval !==
      OPENSLACK_WORKFLOW_APPROVAL_TOOL_NAMES.every((name) => catalogNames.includes(name)) ||
    includeDemoReset !== catalogNames.includes(OPENSLACK_DEMO_RESET_TOOL_NAME)
  ) {
    throw new Error('READ_TOOL_CATALOG_DRIFT');
  }
}

export class OpenSlackMcpCore {
  readonly #context: OpenSlackMcpContext;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #catalog: ReturnType<typeof getOpenSlackToolCatalog>;

  constructor(context: OpenSlackMcpContext, options: OpenSlackMcpCoreOptions = {}) {
    assertFrozenCatalog(
      context.demoReset !== undefined,
      context.governedMutations !== undefined,
      context.workflowApprovalAuthority !== undefined,
    );
    this.#context = context;
    this.#catalog = getOpenSlackToolCatalog({
      includeDemoReset: context.demoReset !== undefined,
      includeGovernedMutations: context.governedMutations !== undefined,
      includeWorkflowApproval: context.workflowApprovalAuthority !== undefined,
    });
    this.#timeoutMs = boundedInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      'timeoutMs',
    );
    this.#maxOutputBytes = boundedInteger(
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      MIN_MAX_OUTPUT_BYTES,
      MAX_MAX_OUTPUT_BYTES,
      'maxOutputBytes',
    );
  }

  listTools(): ReturnType<typeof getOpenSlackToolCatalog> {
    return this.#catalog;
  }

  async callTool(name: string, args: unknown = {}): Promise<OpenSlackMcpToolCallResult> {
    const demoReset = name === OPENSLACK_DEMO_RESET_TOOL_NAME && this.#context.demoReset;
    const governedMutation =
      isOpenSlackMutationToolName(name) &&
      name !== 'openslack_decide_workflow_approval' &&
      this.#context.governedMutations;
    const workflowApproval =
      name === 'openslack_decide_workflow_approval' && this.#context.workflowApprovalAuthority;
    if (!isOpenSlackReadToolName(name) && !demoReset && !governedMutation && !workflowApproval) {
      throw new OpenSlackMcpProtocolError(-32602, `Unknown tool: ${name}`);
    }
    const definition = this.#catalog.find((tool) => tool.name === name);
    if (!definition) throw new OpenSlackMcpProtocolError(-32602, `Unknown tool: ${name}`);

    let input: Readonly<Record<string, unknown>>;
    try {
      input = validateToolInput(definition, args);
    } catch (error) {
      if (error instanceof ToolInputValidationError) {
        throw new OpenSlackMcpProtocolError(-32602, error.message);
      }
      throw error;
    }

    const callTime = this.#context.runtime.now();
    const requestCorrelationId = this.#context.runtime.nextCorrelationId();
    const toolName = name as OpenSlackToolName;
    let result: OpenSlackMcpResult;
    let mutationMetadata: GovernedMutationToolResult | WorkflowApprovalToolResult | undefined;
    try {
      const controller = new AbortController();
      const deadlineAt = new Date(callTime.getTime() + this.#timeoutMs).toISOString();
      if (demoReset) {
        result = await withTimeout(
          Promise.resolve(
            demoReset.reset(Object.freeze({ signal: controller.signal, deadlineAt })),
          ).then((data) =>
            createOpenSlackMcpResult({
              summary: 'The bounded local demo reset port completed.',
              data,
              governance: { risk: 'low' },
            }),
          ),
          this.#timeoutMs,
          controller,
          'DEMO_RESET_TIMEOUT',
        );
      } else if (governedMutation) {
        const executionDeadlineAt = new Date(
          callTime.getTime() + Math.max(50, Math.floor(this.#timeoutMs * 0.8)),
        ).toISOString();
        mutationMetadata = await withTimeout(
          callGovernedMutationTool(
            governedMutation,
            name as Exclude<
              (typeof OPENSLACK_MUTATION_TOOL_NAMES)[number],
              'openslack_decide_workflow_approval'
            >,
            input,
            Object.freeze({
              signal: controller.signal,
              deadlineAt: executionDeadlineAt,
            }),
          ),
          this.#timeoutMs,
          controller,
          'GOVERNED_MUTATION_TIMEOUT',
        );
        result = mutationMetadata.result;
      } else if (workflowApproval) {
        const executionDeadlineAt = new Date(
          callTime.getTime() + Math.max(50, Math.floor(this.#timeoutMs * 0.8)),
        ).toISOString();
        mutationMetadata = await withTimeout(
          callWorkflowApprovalTool(
            workflowApproval,
            input,
            Object.freeze({
              signal: controller.signal,
              deadlineAt: executionDeadlineAt,
            }),
          ),
          this.#timeoutMs,
          controller,
          'WORKFLOW_APPROVAL_TIMEOUT',
        );
        result = mutationMetadata.result;
      } else {
        result = await withTimeout(
          OPENSLACK_READ_TOOL_HANDLERS[name as keyof typeof OPENSLACK_READ_TOOL_HANDLERS](
            this.#context,
            input,
            controller.signal,
          ),
          this.#timeoutMs,
          controller,
        );
      }
    } catch (error) {
      if (demoReset && error instanceof ToolDeadlineExceededError) {
        result = createOpenSlackMcpResult({
          status: 'blocked',
          summary:
            'The demo reset deadline expired; reconcile the fixture before any further demo mutation.',
          data: { outcome: 'reconciliation_required' },
          governance: {
            risk: 'low',
            blocker: 'DEMO_RESET_RECONCILIATION_REQUIRED',
          },
        });
      } else if (
        governedMutation &&
        error instanceof ToolDeadlineExceededError &&
        typeof input.planId === 'string'
      ) {
        const durable = await governedMutation.get(input.planId).catch(() => null);
        if (durable?.state === 'reconciliation_required') {
          mutationMetadata = governedMutationRecordResult(durable);
          result = mutationMetadata.result;
        } else if (durable?.state === 'executing') {
          mutationMetadata = governedMutationRecordResult(durable);
          result = createOpenSlackMcpResult({
            status: 'blocked',
            summary:
              'The governed mutation deadline expired after its durable execution claim; reconcile the plan before another mutation.',
            data: {
              planId: durable.planId,
              state: 'reconciliation_required',
              durableState: durable.state,
              revision: durable.revision,
              executionId: durable.execution?.executionId,
            },
            governance: {
              risk: 'medium',
              blocker: 'GOVERNED_MUTATION_RECONCILIATION_REQUIRED',
            },
            evidenceRefs: [`plan:${durable.planId}`],
            planId: durable.planId,
            ...(durable.execution?.executionId
              ? { executionId: durable.execution.executionId }
              : {}),
          });
        } else {
          result = createOpenSlackMcpResult({
            status: 'blocked',
            summary:
              'The governed mutation deadline expired; reconcile the plan before another mutation.',
            data: { outcome: 'reconciliation_required' },
            governance: {
              risk: 'medium',
              blocker: 'GOVERNED_MUTATION_RECONCILIATION_REQUIRED',
            },
            ...(typeof input.planId === 'string' ? { planId: input.planId } : {}),
          });
        }
      } else if (
        workflowApproval &&
        error instanceof ToolDeadlineExceededError &&
        typeof input.runId === 'string' &&
        typeof input.approvalId === 'string'
      ) {
        const durable = await workflowApproval
          .read(input.runId, input.approvalId)
          .catch(() => undefined);
        if (durable) {
          mutationMetadata = workflowApprovalRecordResult(durable);
          result = mutationMetadata.result;
        } else {
          result = createOpenSlackMcpResult({
            status: 'blocked',
            summary:
              'The workflow-effect decision deadline expired; reconcile the approval before another decision.',
            governance: {
              risk: 'medium',
              blocker: 'WORKFLOW_APPROVAL_RECONCILIATION_REQUIRED',
            },
          });
        }
      } else if (
        workflowApproval &&
        typeof input.runId === 'string' &&
        typeof input.approvalId === 'string'
      ) {
        const durable = await workflowApproval
          .read(input.runId, input.approvalId)
          .catch(() => undefined);
        if (durable) {
          mutationMetadata = workflowApprovalRecordResult(durable);
          result = mutationMetadata.result;
        } else {
          const safe = safeToolError(error);
          result = toolErrorResult(safe);
        }
      } else {
        const safe = safeToolError(error);
        result = toolErrorResult(safe);
      }
    }

    try {
      const safeRawData = result.data === undefined ? undefined : sanitizeForProtocol(result.data);
      const projectedRawData =
        safeRawData === undefined
          ? undefined
          : demoReset || governedMutation || workflowApproval
            ? safeRawData
            : projectToolData(name as Parameters<typeof projectToolData>[0], safeRawData);
      const projectedData =
        projectedRawData === undefined ? undefined : sanitizeForProtocol(projectedRawData);
      result = createOpenSlackMcpResult({
        status: result.status,
        summary: result.summary,
        ...(projectedData === undefined ? {} : { data: projectedData }),
        governance: result.governance,
        nextActions: governedMutation ? result.nextActions : [],
        evidenceRefs: normalizeEvidenceReferences([
          ...result.evidenceRefs,
          ...evidenceFrom(projectedData),
        ]),
        ...(result.planId ? { planId: result.planId } : {}),
        ...(result.executionId ? { executionId: result.executionId } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
      const resultV2: OpenSlackMcpResultV2 = upgradeOpenSlackMcpResult(result, {
        correlationId: mutationMetadata?.correlationId ?? requestCorrelationId,
        authority: {
          mode:
            demoReset || governedMutation || workflowApproval ? 'governed_mutation' : 'projection',
          sources: AUTHORITY_SOURCES[toolName],
          observedAt: observedAt(projectedData, callTime),
        },
        ...(mutationMetadata &&
        'confirmationActionIds' in mutationMetadata &&
        mutationMetadata.confirmationActionIds
          ? { confirmationActionIds: mutationMetadata.confirmationActionIds }
          : {}),
        ...(mutationMetadata && 'planHash' in mutationMetadata && mutationMetadata.planHash
          ? { planHash: mutationMetadata.planHash }
          : {}),
        ...(mutationMetadata &&
        'confirmationToken' in mutationMetadata &&
        mutationMetadata.confirmationToken
          ? { confirmationToken: mutationMetadata.confirmationToken }
          : {}),
        ...(mutationMetadata && 'approval' in mutationMetadata && mutationMetadata.approval
          ? { approval: mutationMetadata.approval }
          : {}),
      });
      const structured = deepFreezeJson(
        sanitizeForProtocol(resultV2, 0, true) as Readonly<Record<string, unknown>>,
      );
      let serialized = JSON.stringify(structured);
      if (Buffer.byteLength(serialized, 'utf8') > this.#maxOutputBytes) {
        const bounded = deepFreezeJson(
          sanitizeForProtocol(
            upgradeOpenSlackMcpResult(
              failedResult(
                'READ_PROJECTION_TOO_LARGE',
                'The requested OpenSlack projection exceeded the protocol output bound.',
              ),
              {
                correlationId: mutationMetadata?.correlationId ?? requestCorrelationId,
                authority: {
                  mode:
                    demoReset || governedMutation || workflowApproval
                      ? 'governed_mutation'
                      : 'projection',
                  sources: AUTHORITY_SOURCES[toolName],
                  observedAt: callTime.toISOString(),
                },
              },
            ),
          ) as Readonly<Record<string, unknown>>,
        );
        serialized = JSON.stringify(bounded);
        return Object.freeze({
          content: Object.freeze([{ type: 'text' as const, text: serialized }]),
          structuredContent: bounded,
          isError: true,
        });
      }

      return Object.freeze({
        content: Object.freeze([{ type: 'text' as const, text: serialized }]),
        structuredContent: structured,
        isError: result.status === 'failed',
      });
    } catch {
      const fallback = deepFreezeJson(
        sanitizeForProtocol(
          upgradeOpenSlackMcpResult(
            failedResult(
              'PROTOCOL_OUTPUT_UNSAFE',
              'The OpenSlack result could not be safely projected onto the MCP protocol.',
            ),
            {
              correlationId: mutationMetadata?.correlationId ?? requestCorrelationId,
              authority: {
                mode:
                  demoReset || governedMutation || workflowApproval
                    ? 'governed_mutation'
                    : 'projection',
                sources: AUTHORITY_SOURCES[toolName],
                observedAt: callTime.toISOString(),
              },
            },
          ),
        ) as Readonly<Record<string, unknown>>,
      );
      const serialized = JSON.stringify(fallback);
      return Object.freeze({
        content: Object.freeze([{ type: 'text' as const, text: serialized }]),
        structuredContent: fallback,
        isError: true,
      });
    }
  }
}

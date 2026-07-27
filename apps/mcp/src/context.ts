import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  BLOCKER_TYPES,
  buildBusinessOutcomeProjection,
  filterEvents,
  validateEvent,
  type CollaborationEvent,
  type DashboardProjection,
  type Decision,
  type EventFilter,
  type Handoff,
  type RoomView,
} from '@openslack/collaboration';
import {
  WATCH_DELIVERY_QUEUE_V2_SCHEMA,
  parseGitHubWatchConfigV2,
  type WatchDeliveryQueueV2State,
  type WatchDeliveryQueueV2Stats,
} from '@openslack/github';
import {
  GraphStoreError,
  LocalGraphStore,
  explainGraph,
  queryGraph,
  type GraphExplainInput,
  type GraphExplanation,
  type GraphQueryInput,
  type GraphQueryResult,
} from '@openslack/organization-graph';
import type {
  ActionRegistryPort,
  ConversationStoreBindingPort,
  LLMPlannerProviderRegistryPort,
} from '@openslack/operator';
import {
  classifyPRReport,
  diagnosePR,
  fetchPRDetails,
  loadPRCodeownerEvidence,
  loadPRReviewPolicy,
  summarizePRDecision,
} from '@openslack/pr';
import {
  createSoftwareDeliveryScenarioCatalog,
  loadScenarioPack,
  type LoadedScenarioDefinition,
} from '@openslack/scenario-runtime';
import { getWorkflowRunProgress } from '@openslack/workflows';
import { parse as parseYaml } from 'yaml';
import {
  LocalReadBoundError,
  MCP_MAX_LOCAL_DIRECTORY_ITEMS,
  MCP_MAX_LOCAL_FILE_BYTES,
  MCP_MAX_LOCAL_JSONL_LINES,
  readBoundedDirectoryFilesSync,
  readBoundedJsonFileSync,
  readBoundedJsonlFileSync,
  readBoundedTextFileSync,
} from './bounded-read.js';
import {
  assertOpenSlackGovernedMutationPort,
  type OpenSlackGovernedMutationPort,
} from './mutations.js';
import {
  assertOpenSlackWorkflowApprovalPort,
  type OpenSlackWorkflowApprovalPort,
} from './workflow-approvals.js';

export interface OperatorApplicationContextPort {
  readonly actionRegistry: ActionRegistryPort;
  readonly llmProviderRegistry: LLMPlannerProviderRegistryPort;
  readonly conversationStore: ConversationStoreBindingPort;
}

export interface BusinessOutcomesReaderInput {
  readonly rootDir: string;
  readonly from?: string;
  readonly to?: string;
  readonly scenarioId?: string;
}

export interface BusinessOutcomesReaderPort {
  (input: BusinessOutcomesReaderInput): unknown | Promise<unknown>;
}

export interface OpenSlackReadModelPorts {
  readonly executiveOverview: (input: {
    sinceHours: number;
    limit: number;
  }) => unknown | Promise<unknown>;
  readonly workItems: (input: {
    status?: string;
    sinceHours: number;
    limit: number;
  }) => unknown | Promise<unknown>;
  readonly workRoom: (input: { roomId: string; limit: number }) => unknown | Promise<unknown>;
  readonly activity: (input: {
    sinceHours: number;
    objectKind?: string;
    objectId?: string;
    limit: number;
  }) => unknown | Promise<unknown>;
  readonly workflowProgress: (input: { runId: string }) => unknown | Promise<unknown>;
  readonly prReadiness: (input: {
    prNumber: number;
    repo?: string;
    signal?: AbortSignal;
  }) => unknown | Promise<unknown>;
  readonly pendingApprovals: (input: { limit: number }) => unknown | Promise<unknown>;
  readonly notificationStatus: () => unknown | Promise<unknown>;
  readonly businessOutcomes?: BusinessOutcomesReaderPort;
  readonly scenarios: () => unknown | Promise<unknown>;
  readonly graphQuery: (input: GraphQueryInput) => unknown | Promise<unknown>;
  readonly graphExplain: (input: GraphExplainInput) => unknown | Promise<unknown>;
}

export interface OpenSlackMcpContext {
  readonly workspaceRoot: string;
  readonly operator: OperatorApplicationContextPort;
  readonly readers: OpenSlackReadModelPorts;
  readonly runtime: OpenSlackMcpRuntimePort;
  readonly governedMutations?: OpenSlackGovernedMutationPort;
  readonly workflowApprovalAuthority?: OpenSlackWorkflowApprovalPort;
  readonly demoReset?: LocalDemoResetPort;
}

export interface CreateOpenSlackMcpContextOptions {
  readonly workspaceRoot: string;
  readonly operator: OperatorApplicationContextPort;
  readonly readers?: Partial<OpenSlackReadModelPorts>;
  readonly businessOutcomes?: BusinessOutcomesReaderPort;
  /** Test seam. Production callers omit this and receive the system clock. */
  readonly clock?: () => Date;
  /** Test seam. Production callers omit this and receive server-generated UUIDs. */
  readonly correlationIdFactory?: () => string;
  readonly graphMaxAgeMs?: number;
  /** Optional nominal Operator mutation port. Omit to preserve the exact read-only catalog. */
  readonly governedMutations?: OpenSlackGovernedMutationPort;
  /** Optional separately human-attested workflow-effect decision port. Requires governedMutations. */
  readonly workflowApprovalAuthority?: OpenSlackWorkflowApprovalPort;
  /** Required before the local-only demo reset tool can be registered. */
  readonly demoMode?: boolean;
  readonly demoReset?: LocalDemoResetPort;
}

export interface OpenSlackMcpRuntimePort {
  readonly now: () => Date;
  readonly nextCorrelationId: () => string;
}

export interface LocalDemoResetInvocation {
  readonly root: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: string;
}

export interface CreateLocalDemoResetPortOptions {
  readonly workspaceRoot: string;
  readonly fixtureRoot: string;
  readonly demoMode: true;
  readonly reset: (invocation: LocalDemoResetInvocation) => unknown | Promise<unknown>;
}

export interface LocalDemoResetPort {
  readonly reset: (input: {
    readonly signal: AbortSignal;
    readonly deadlineAt: string;
  }) => unknown | Promise<unknown>;
}

export class ProjectionEvidenceUnavailableError extends Error {
  constructor(
    readonly code: 'SOURCE_EVIDENCE_UNAVAILABLE' | 'SOURCE_EVIDENCE_STALE',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectionEvidenceUnavailableError';
  }
}

const MAX_LOCAL_JSON_BYTES = MCP_MAX_LOCAL_FILE_BYTES;
const TASK_TYPES = new Set([
  'task.created',
  'task.claimed',
  'task.blocked',
  'task.done',
  'task.released',
  'task.expired',
]);
const DEFAULT_GRAPH_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const MIN_GRAPH_MAX_AGE_MS = 60 * 1_000;
const MAX_GRAPH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const SCENARIO_IDS = Object.freeze(['software-delivery'] as const);
const NOMINAL_LOCAL_DEMO_RESET_PORTS = new WeakMap<
  object,
  { readonly workspaceRoot: string; readonly fixtureRoot: string }
>();

function graphMaxAge(value: number | undefined): number {
  const resolved = value ?? DEFAULT_GRAPH_MAX_AGE_MS;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < MIN_GRAPH_MAX_AGE_MS ||
    resolved > MAX_GRAPH_MAX_AGE_MS
  ) {
    throw new TypeError(
      `graphMaxAgeMs must be between ${MIN_GRAPH_MAX_AGE_MS} and ${MAX_GRAPH_MAX_AGE_MS}.`,
    );
  }
  return resolved;
}

function canonicalClock(clock: (() => Date) | undefined): () => Date {
  const source = clock ?? (() => new Date());
  return () => {
    const value = source();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError('MCP runtime clock returned an invalid date.');
    }
    return new Date(value.getTime());
  };
}

function canonicalCorrelationFactory(factory: (() => string) | undefined): () => string {
  const source = factory ?? (() => `mcp:${randomUUID()}`);
  return () => {
    const value = source();
    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > 160 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
    ) {
      throw new TypeError('MCP correlation factory returned an invalid identifier.');
    }
    return value;
  };
}

function directoryIdentity(path: string): string {
  const stat = statSync(path, { bigint: true });
  if (!stat.isDirectory()) throw new TypeError('demo fixture root must be an existing directory.');
  return `${stat.dev}:${stat.ino}`;
}

function assertNoSymbolicPathComponents(base: string, target: string): void {
  const child = relative(base, target);
  if (!child || child.startsWith('..') || isAbsolute(child)) {
    throw new TypeError('demo fixture root must be a non-empty child of .openslack.local/demo.');
  }
  let current = base;
  for (const segment of child.split(sep)) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new TypeError('demo fixture path components must not be symlinks or reparse points.');
    }
  }
}

function canonicalDemoFixtureRoot(
  workspaceRoot: string,
  fixtureRoot: string,
): {
  readonly workspaceRoot: string;
  readonly allowedRoot: string;
  readonly canonicalRoot: string;
  readonly identity: string;
} {
  if (!isAbsolute(fixtureRoot) || fixtureRoot.includes('\0')) {
    throw new TypeError('demo fixture root must be an absolute local path.');
  }
  const canonicalWorkspace = realpathSync.native(resolve(workspaceRoot));
  const lexicalAllowedRoot = resolve(canonicalWorkspace, '.openslack.local', 'demo');
  const lexicalTarget = resolve(fixtureRoot);
  assertNoSymbolicPathComponents(canonicalWorkspace, lexicalAllowedRoot);
  assertNoSymbolicPathComponents(lexicalAllowedRoot, lexicalTarget);
  const allowedRoot = realpathSync.native(lexicalAllowedRoot);
  const canonicalRoot = realpathSync.native(lexicalTarget);
  assertNoSymbolicPathComponents(allowedRoot, canonicalRoot);
  return Object.freeze({
    workspaceRoot: canonicalWorkspace,
    allowedRoot,
    canonicalRoot,
    identity: directoryIdentity(canonicalRoot),
  });
}

export function createLocalDemoResetPort(
  options: CreateLocalDemoResetPortOptions,
): LocalDemoResetPort {
  if (options.demoMode !== true || typeof options.reset !== 'function') {
    throw new TypeError('local demo reset requires explicit demoMode=true and a reset callback.');
  }
  const binding = canonicalDemoFixtureRoot(options.workspaceRoot, options.fixtureRoot);
  const port: LocalDemoResetPort = Object.freeze({
    reset: (input: { readonly signal: AbortSignal; readonly deadlineAt: string }) => {
      if (
        !input ||
        typeof input !== 'object' ||
        !(input.signal instanceof AbortSignal) ||
        typeof input.deadlineAt !== 'string'
      ) {
        throw new TypeError('demo reset invocation requires a signal and canonical deadline.');
      }
      const deadline = new Date(input.deadlineAt);
      if (
        !Number.isFinite(deadline.getTime()) ||
        deadline.toISOString() !== input.deadlineAt ||
        input.signal.aborted
      ) {
        throw new TypeError('demo reset invocation is expired or invalid.');
      }
      const current = canonicalDemoFixtureRoot(options.workspaceRoot, options.fixtureRoot);
      if (
        current.allowedRoot !== binding.allowedRoot ||
        current.canonicalRoot !== binding.canonicalRoot ||
        current.identity !== binding.identity
      ) {
        throw new TypeError('demo fixture root identity changed after the port was created.');
      }
      return options.reset(
        Object.freeze({
          root: binding.canonicalRoot,
          signal: input.signal,
          deadlineAt: input.deadlineAt,
        }),
      );
    },
  });
  NOMINAL_LOCAL_DEMO_RESET_PORTS.set(
    port,
    Object.freeze({
      workspaceRoot: binding.workspaceRoot,
      fixtureRoot: binding.canonicalRoot,
    }),
  );
  return port;
}

function assertLocalDemoResetPort(
  workspaceRoot: string,
  demoMode: boolean | undefined,
  port: LocalDemoResetPort | undefined,
): LocalDemoResetPort | undefined {
  if (!port) return undefined;
  const binding = NOMINAL_LOCAL_DEMO_RESET_PORTS.get(port);
  if (
    demoMode !== true ||
    !binding ||
    binding.workspaceRoot !== realpathSync.native(workspaceRoot)
  ) {
    throw new TypeError(
      'demoReset must be created by createLocalDemoResetPort with explicit demoMode=true.',
    );
  }
  return port;
}

function sourceRef(event: CollaborationEvent): string {
  return `${event.source.kind}:${event.source.ref}`;
}

function eventEvidence(event: CollaborationEvent): string {
  return `event:${event.id}`;
}

function eventsForWindow(rootDir: string, sinceHours: number): CollaborationEvent[] {
  const eventsPath = join(rootDir, '.openslack.local', 'collaboration', 'events.jsonl');
  const events = existsSync(eventsPath)
    ? readBoundedJsonlFileSync<CollaborationEvent>(eventsPath, {
        maxBytes: MAX_LOCAL_JSON_BYTES,
        maxLines: MCP_MAX_LOCAL_JSONL_LINES,
        maxItems: MCP_MAX_LOCAL_JSONL_LINES,
        accept: (event) => validateEvent(event).valid,
      })
    : [];
  const cutoff =
    sinceHours <= 0 ? Number.NEGATIVE_INFINITY : Date.now() - sinceHours * 60 * 60 * 1_000;
  return events
    .filter((event) => new Date(event.timestamp).getTime() >= cutoff)
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

function canonicalPeriodBoundary(
  value: string | undefined,
  edge: 'from' | 'to',
  fallback: Date,
): string {
  if (!value) return fallback.toISOString();
  const expanded = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${edge === 'from' ? '00:00:00.000' : '23:59:59.999'}Z`
    : value;
  const parsed = new Date(expanded);
  if (!Number.isFinite(parsed.getTime())) throw new Error('BUSINESS_OUTCOME_PERIOD_INVALID');
  return parsed.toISOString();
}

function defaultBusinessOutcomesReader(rootDir: string): BusinessOutcomesReaderPort {
  return ({ from, to, scenarioId }) => {
    const generatedAt = new Date();
    const periodTo = canonicalPeriodBoundary(to, 'to', generatedAt);
    const periodFrom = canonicalPeriodBoundary(
      from,
      'from',
      new Date(Date.parse(periodTo) - 24 * 60 * 60 * 1_000),
    );
    if (Date.parse(periodFrom) > Date.parse(periodTo)) {
      throw new Error('BUSINESS_OUTCOME_PERIOD_INVALID');
    }
    return buildBusinessOutcomeProjection({
      generatedAt: generatedAt.toISOString(),
      period: { from: periodFrom, to: periodTo },
      ...(scenarioId ? { scenario: scenarioId } : {}),
      events: eventsForWindow(rootDir, 0),
      evidenceRefs: [
        `query:collaboration-events:${periodFrom}/${periodTo}${
          scenarioId ? `?scenario=${scenarioId}` : ''
        }`,
      ],
    });
  };
}

function safeText(value: unknown, max = 500): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function safeIdentifier(value: unknown, max = 160): string | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9@_.:/-]+$/.test(value)) return undefined;
  return value.slice(0, max);
}

function safeWebUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2_048) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return undefined;
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function eventDto(event: CollaborationEvent): Record<string, unknown> {
  return {
    id: event.id,
    timestamp: event.timestamp,
    type: event.type,
    actor: { id: event.actor.id, kind: event.actor.kind },
    object: {
      kind: event.object.kind,
      id: event.object.id,
      ...(safeWebUrl(event.object.url) ? { url: safeWebUrl(event.object.url) } : {}),
    },
    source: { kind: event.source.kind, ref: event.source.ref },
    summary: event.summary,
    ...(event.owner ? { owner: { id: event.owner.id, kind: event.owner.kind } } : {}),
    ...(event.nextAction
      ? {
          nextAction: {
            owner: event.nextAction.owner,
            action: event.nextAction.action,
            ...(safeWebUrl(event.nextAction.url) ? { url: safeWebUrl(event.nextAction.url) } : {}),
          },
        }
      : {}),
    ...(event.risk ? { risk: event.risk } : {}),
    ...(event.severity ? { severity: event.severity } : {}),
    visibility: event.visibility,
    ...(event.correlationId ? { correlationId: event.correlationId } : {}),
    ...(event.parentEventId ? { parentEventId: event.parentEventId } : {}),
    redacted: event.redacted,
    evidenceRef: eventEvidence(event),
  };
}

function handoffDto(value: unknown): Record<string, unknown> {
  const item = value as Record<string, unknown>;
  return {
    id: safeText(item.id, 160),
    status: safeText(item.status, 40),
    from: safeText(item.from, 160),
    to: safeText(item.to, 160),
    createdAt: safeText(item.createdAt, 80),
    issueRef: safeText(item.issueRef, 160),
    prRef: safeText(item.prRef, 160),
    context: safeText(item.context),
    nextSteps: Array.isArray(item.nextSteps)
      ? item.nextSteps
          .slice(0, 20)
          .map((step) => safeText(step))
          .filter(Boolean)
      : [],
    evidenceRef: typeof item.id === 'string' ? `handoff:${item.id}` : undefined,
  };
}

function decisionDto(value: unknown): Record<string, unknown> {
  const item = value as Record<string, unknown>;
  return {
    id: safeText(item.id, 160),
    status: safeText(item.status, 40),
    topic: safeText(item.topic),
    decision: safeText(item.decision),
    decidedBy: safeText(item.decidedBy, 160),
    createdAt: safeText(item.createdAt, 80),
    tags: Array.isArray(item.tags)
      ? item.tags
          .slice(0, 20)
          .map((tag) => safeText(tag, 160))
          .filter(Boolean)
      : [],
    evidenceRef: typeof item.id === 'string' ? `decision:${item.id}` : undefined,
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalReadBoundError('LOCAL_INPUT_INVALID_ITEM');
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 10_000) {
    throw new LocalReadBoundError(`LOCAL_INPUT_INVALID_${field.toUpperCase()}`);
  }
  return value;
}

function optionalStringArray(value: unknown, maxItems: number): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 10_000)
  ) {
    throw new LocalReadBoundError('LOCAL_INPUT_INVALID_STRING_ARRAY');
  }
  return value as string[];
}

function optionalStringValue(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, field);
}

function isoDateValue(value: unknown, field: string): string {
  const result = stringValue(value, field);
  if (!Number.isFinite(Date.parse(result))) {
    throw new LocalReadBoundError(`LOCAL_INPUT_INVALID_${field.toUpperCase()}`);
  }
  return result;
}

function assertOnlyKeys(item: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(item).some((key) => !allowedSet.has(key))) {
    throw new LocalReadBoundError('LOCAL_INPUT_UNKNOWN_FIELD');
  }
}

function parseHandoff(raw: string): Handoff {
  const item = objectValue(parseYaml(raw));
  assertOnlyKeys(item, [
    'schema',
    'id',
    'status',
    'from',
    'to',
    'createdAt',
    'acceptedAt',
    'closedAt',
    'issueRef',
    'prRef',
    'context',
    'nextSteps',
    'notes',
    'principal',
  ]);
  const status = stringValue(item.status, 'handoff_status');
  if (item.schema !== 'openslack.handoff.v1' || !['open', 'accepted', 'closed'].includes(status)) {
    throw new LocalReadBoundError('LOCAL_INPUT_INVALID_HANDOFF');
  }
  let principal: Handoff['principal'];
  if (item.principal !== undefined) {
    const value = objectValue(item.principal);
    assertOnlyKeys(value, ['registry_id', 'run_id']);
    principal = {
      registry_id: stringValue(value.registry_id, 'handoff_principal_registry_id'),
      run_id: stringValue(value.run_id, 'handoff_principal_run_id'),
    };
  }
  const acceptedAt = optionalStringValue(item.acceptedAt, 'handoff_accepted_at');
  const closedAt = optionalStringValue(item.closedAt, 'handoff_closed_at');
  const issueRef = optionalStringValue(item.issueRef, 'handoff_issue_ref');
  const prRef = optionalStringValue(item.prRef, 'handoff_pr_ref');
  const notes = optionalStringValue(item.notes, 'handoff_notes');
  return {
    schema: 'openslack.handoff.v1',
    id: stringValue(item.id, 'handoff_id'),
    status: status as Handoff['status'],
    from: stringValue(item.from, 'handoff_from'),
    to: stringValue(item.to, 'handoff_to'),
    createdAt: isoDateValue(item.createdAt, 'handoff_created_at'),
    ...(acceptedAt ? { acceptedAt: isoDateValue(acceptedAt, 'handoff_accepted_at') } : {}),
    ...(closedAt ? { closedAt: isoDateValue(closedAt, 'handoff_closed_at') } : {}),
    ...(issueRef ? { issueRef } : {}),
    ...(prRef ? { prRef } : {}),
    context: stringValue(item.context, 'handoff_context'),
    nextSteps: optionalStringArray(item.nextSteps, 100),
    ...(notes ? { notes } : {}),
    ...(principal ? { principal } : {}),
  };
}

function parseDecision(raw: string): Decision {
  const item = objectValue(parseYaml(raw));
  assertOnlyKeys(item, [
    'schema',
    'id',
    'topic',
    'decision',
    'rationale',
    'alternatives',
    'consequences',
    'decidedBy',
    'createdAt',
    'status',
    'supersedes',
    'supersededBy',
    'supersededAt',
    'tags',
    'principal',
  ]);
  const status = stringValue(item.status, 'decision_status');
  if (item.schema !== 'openslack.decision.v1' || !['active', 'superseded'].includes(status)) {
    throw new LocalReadBoundError('LOCAL_INPUT_INVALID_DECISION');
  }
  let principal: Decision['principal'];
  if (item.principal !== undefined) {
    const value = objectValue(item.principal);
    assertOnlyKeys(value, ['registry_id', 'run_id']);
    principal = {
      registry_id: stringValue(value.registry_id, 'decision_principal_registry_id'),
      run_id: stringValue(value.run_id, 'decision_principal_run_id'),
    };
  }
  const supersedes = optionalStringValue(item.supersedes, 'decision_supersedes');
  const supersededBy = optionalStringValue(item.supersededBy, 'decision_superseded_by');
  const supersededAt = optionalStringValue(item.supersededAt, 'decision_superseded_at');
  return {
    schema: 'openslack.decision.v1',
    id: stringValue(item.id, 'decision_id'),
    topic: stringValue(item.topic, 'decision_topic'),
    decision: stringValue(item.decision, 'decision_value'),
    rationale: stringValue(item.rationale, 'decision_rationale'),
    alternatives: optionalStringArray(item.alternatives, 100),
    consequences: optionalStringArray(item.consequences, 100),
    decidedBy: stringValue(item.decidedBy, 'decision_owner'),
    createdAt: isoDateValue(item.createdAt, 'decision_created_at'),
    status: status as Decision['status'],
    ...(supersedes ? { supersedes } : {}),
    ...(supersededBy ? { supersededBy } : {}),
    ...(supersededAt ? { supersededAt: isoDateValue(supersededAt, 'decision_superseded_at') } : {}),
    tags: optionalStringArray(item.tags, 100),
    ...(principal ? { principal } : {}),
  };
}

function readCollaborationStores(rootDir: string): {
  handoffs: Handoff[];
  decisions: Decision[];
} {
  const handoffs = readBoundedDirectoryFilesSync(
    join(rootDir, '.openslack', 'collaboration', 'handoffs'),
    {
      extensions: ['.yaml'],
      maxItems: MCP_MAX_LOCAL_DIRECTORY_ITEMS,
      maxFileBytes: 256 * 1024,
    },
  )
    .map((file) => parseHandoff(file.text))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const decisions = readBoundedDirectoryFilesSync(
    join(rootDir, '.openslack', 'collaboration', 'decisions'),
    {
      extensions: ['.yaml'],
      maxItems: MCP_MAX_LOCAL_DIRECTORY_ITEMS,
      maxFileBytes: 256 * 1024,
    },
  )
    .map((file) => parseDecision(file.text))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { handoffs, decisions };
}

function dashboardDto(dashboard: DashboardProjection, limit: number): Record<string, unknown> {
  return {
    generatedAt: dashboard.generatedAt,
    sinceHours: dashboard.sinceHours,
    taskCounts: dashboard.taskCounts,
    prCounts: dashboard.prCounts,
    blockerCount: dashboard.blockerCount,
    blockers: dashboard.blockers.slice(0, limit).map((blocker) => ({
      object: blocker.object,
      summary: blocker.summary,
      owner: blocker.owner,
      nextAction: blocker.nextAction,
      severity: blocker.severity,
    })),
    openHandoffs: dashboard.openHandoffs,
    activeDecisions: dashboard.activeDecisions,
    recentEvents: dashboard.recentEvents.slice(0, limit).map(eventDto),
    openHandoffDetails: dashboard.openHandoffDetails.slice(0, limit).map(handoffDto),
    activeDecisionDetails: dashboard.activeDecisionDetails.slice(0, limit).map(decisionDto),
  };
}

function roomDto(room: RoomView, limit: number): Record<string, unknown> {
  return {
    roomId: room.roomId,
    objectKind: room.objectKind,
    objectId: room.objectId,
    sourceUrl: safeWebUrl(room.sourceUrl),
    owner: room.owner,
    nextAction: room.nextAction,
    recentEvents: room.recentEvents.slice(0, limit).map(eventDto),
    blockers: room.blockers.slice(0, limit).map(eventDto),
    linkedDecisions: room.linkedDecisions.slice(0, limit).map(decisionDto),
    linkedHandoffs: room.linkedHandoffs.slice(0, limit).map(handoffDto),
  };
}

function fallbackDashboard(
  events: CollaborationEvent[],
  sinceHours: number,
  stores: { handoffs: Handoff[]; decisions: Decision[] },
): DashboardProjection {
  const taskCounts: Record<string, number> = {};
  const prCounts: Record<string, number> = {};
  for (const event of events) {
    if (event.object.kind === 'issue' || event.type.startsWith('task.'))
      taskCounts[event.type] = (taskCounts[event.type] ?? 0) + 1;
    if (event.object.kind === 'pr' || event.type.startsWith('pr.'))
      prCounts[event.type] = (prCounts[event.type] ?? 0) + 1;
  }
  const blockers = events
    .filter((event) => BLOCKER_TYPES.has(event.type))
    .map((event) => ({
      object: `${event.object.kind}:${event.object.id}`,
      summary: event.summary,
      owner: event.owner ? `${event.owner.kind}:${event.owner.id}` : event.nextAction?.owner,
      nextAction: event.nextAction?.action,
      severity: event.severity,
    }));
  const openHandoffs = stores.handoffs.filter((handoff) => handoff.status !== 'closed');
  const activeDecisions = stores.decisions.filter((decision) => decision.status === 'active');
  return {
    generatedAt: new Date().toISOString(),
    sinceHours,
    taskCounts,
    prCounts,
    blockerCount: blockers.length,
    blockers: blockers.slice(0, 20),
    openHandoffs: openHandoffs.length,
    activeDecisions: activeDecisions.length,
    recentEvents: events.slice(0, 20),
    openHandoffDetails: openHandoffs.slice(0, 10),
    activeDecisionDetails: activeDecisions.slice(0, 10),
    appliedFilters: {},
  };
}

function fallbackRoom(
  roomId: string,
  events: CollaborationEvent[],
  stores: { handoffs: Handoff[]; decisions: Decision[] },
): RoomView | undefined {
  const match = roomId.match(/^(\w+):(.+)$/);
  if (!match) return undefined;
  const [, objectKind, objectId] = match;
  const recentEvents = events
    .filter((event) => event.object.kind === objectKind && event.object.id === objectId)
    .slice(0, 20);
  const blockers = recentEvents.filter((event) => BLOCKER_TYPES.has(event.type));
  const ownership = recentEvents.find((event) => event.owner);
  const next = recentEvents.find((event) => event.nextAction);
  const linkedDecisions = stores.decisions.filter((decision) => {
    const searchable =
      `${decision.topic} ${decision.decision} ${decision.rationale} ${(decision.tags ?? []).join(' ')}`.toLowerCase();
    return searchable.includes(objectId.toLowerCase());
  });
  const linkedHandoffs = stores.handoffs.filter(
    (handoff) =>
      (objectKind === 'issue' && handoff.issueRef === objectId) ||
      (objectKind === 'pr' && handoff.prRef === objectId),
  );
  return {
    roomId,
    objectKind,
    objectId,
    recentEvents,
    blockers,
    owner: ownership?.owner ? `${ownership.owner.kind}:${ownership.owner.id}` : undefined,
    nextAction: next?.nextAction
      ? `${next.nextAction.owner} — ${next.nextAction.action}`
      : undefined,
    linkedDecisions,
    linkedHandoffs,
  };
}

function safeReadPendingPlans(rootDir: string, limit: number): unknown[] {
  const directory = join(rootDir, '.openslack.local', 'operator', 'plans');
  const now = Date.now();
  const plans: Array<Record<string, unknown>> = [];
  const files = readBoundedDirectoryFilesSync(directory, {
    extensions: ['.json'],
    maxItems: MCP_MAX_LOCAL_DIRECTORY_ITEMS,
    maxFileBytes: MAX_LOCAL_JSON_BYTES,
  });
  for (const file of files) {
    if (plans.length >= limit) break;
    let value: Record<string, unknown>;
    try {
      value = objectValue(JSON.parse(file.text));
    } catch {
      throw new LocalReadBoundError('LOCAL_INPUT_INVALID_OPERATOR_PLAN');
    }
    if (
      typeof value.planId !== 'string' ||
      typeof value.createdAt !== 'string' ||
      typeof value.expiresAt !== 'string'
    ) {
      throw new LocalReadBoundError('LOCAL_INPUT_INVALID_OPERATOR_PLAN');
    }
    const recordedState = typeof value.state === 'string' ? value.state : 'unknown';
    const state =
      recordedState === 'pending' && new Date(value.expiresAt).getTime() < now
        ? 'expired'
        : recordedState;
    if (state !== 'pending') continue;
    const plan = objectValue(value.plan);
    plans.push({
      planId: value.planId.slice(0, 160),
      actorId: typeof value.actorId === 'string' ? value.actorId.slice(0, 160) : undefined,
      goal: typeof plan.goal === 'string' ? plan.goal.slice(0, 500) : 'not recorded',
      risk: typeof plan.risk === 'string' ? plan.risk : 'unknown',
      createdAt: value.createdAt,
      expiresAt: value.expiresAt,
      evidenceRef: `plan:${value.planId.slice(0, 160)}`,
    });
  }
  return plans.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function pendingGovernance(events: CollaborationEvent[], rootDir: string, limit: number): unknown {
  const openSlackConfirmations = safeReadPendingPlans(rootDir, limit);
  const workflowTrust = events
    .filter(
      (event) =>
        event.metadata?.approvalKind === 'workflow_trust' ||
        event.metadata?.approval_kind === 'workflow_trust',
    )
    .slice(0, limit)
    .map((event) => ({
      object: `${event.object.kind}:${event.object.id}`,
      summary: event.summary,
      owner: event.owner ? `${event.owner.kind}:${event.owner.id}` : event.nextAction?.owner,
      source: sourceRef(event),
      observedAt: event.timestamp,
      evidenceRef: eventEvidence(event),
    }));
  const githubHumanReviews = events
    .filter((event) =>
      ['NEEDS_HUMAN_APPROVAL', 'NEEDS_CODEOWNER_APPROVAL', 'BOT_APPROVAL_IGNORED'].includes(
        String(event.metadata?.decision ?? ''),
      ),
    )
    .slice(0, limit)
    .map((event) => ({
      object: `${event.object.kind}:${event.object.id}`,
      requirement: event.metadata?.decision,
      owner: event.owner ? `${event.owner.kind}:${event.owner.id}` : 'human',
      source: sourceRef(event),
      observedAt: event.timestamp,
      evidenceRef: eventEvidence(event),
    }));
  return {
    generatedAt: new Date().toISOString(),
    openSlackConfirmations,
    workflowTrust,
    githubHumanReviews,
    semantics: {
      qoderPermissionIsOpenSlackConfirmation: false,
      openSlackConfirmationIsGithubReview: false,
    },
  };
}

function notificationProjection(rootDir: string): unknown {
  const configPath = join(rootDir, '.openslack', 'monitors', 'github-watch.yaml');
  let parsed: ReturnType<typeof parseGitHubWatchConfigV2>;
  if (!existsSync(configPath)) {
    parsed = { valid: false, errors: ['Notification config is not recorded.'] };
  } else {
    try {
      parsed = parseGitHubWatchConfigV2(readBoundedTextFileSync(configPath, MAX_LOCAL_JSON_BYTES));
    } catch {
      parsed = { valid: false, errors: ['Notification config exceeds the safe read bound.'] };
    }
  }
  const repositoryCount = parsed.config?.repositories.length ?? 0;
  const routeCount =
    parsed.config?.repositories.reduce(
      (total, repository) => total + (repository.routes?.length ?? 0),
      0,
    ) ?? 0;
  if (repositoryCount > 100 || routeCount > 1_000) {
    parsed = {
      valid: false,
      errors: ['Notification config exceeds the repository or route item bound.'],
    };
  }
  const configuredRoutes = (parsed.config?.repositories ?? []).flatMap((repository) =>
    (repository.routes ?? []).map((route) => ({
      repository: `${repository.owner}/${repository.repo}`,
      id: route.id,
      sink: route.sink,
      backend: route.delivery?.backend ?? 'local',
    })),
  );
  const statePath = join(rootDir, '.openslack.local', 'daemon', 'delivery-state.v2.json');
  let localQueue: WatchDeliveryQueueV2Stats | { status: 'unknown'; reason: string } = {
    status: 'unknown',
    reason: 'No typed local v2 queue state is available.',
  };
  if (existsSync(statePath)) {
    try {
      const state = readBoundedJsonFileSync<WatchDeliveryQueueV2State>(
        statePath,
        MAX_LOCAL_JSON_BYTES,
      );
      if (
        state.schema !== WATCH_DELIVERY_QUEUE_V2_SCHEMA ||
        !Array.isArray(state.routes) ||
        !Array.isArray(state.legacyEventTombstones) ||
        state.routes.length > MCP_MAX_LOCAL_JSONL_LINES ||
        state.legacyEventTombstones.length > MCP_MAX_LOCAL_JSONL_LINES
      ) {
        throw new Error('QUEUE_STATE_INVALID');
      }
      const stats: WatchDeliveryQueueV2Stats = {
        count: state.routes.length + state.legacyEventTombstones.length,
        pending: 0,
        processing: 0,
        retryable: 0,
        accepted: 0,
        rejected: 0,
        quarantined: 0,
        handoffDead: 0,
        completed: 0,
        failed: 0,
        legacyOwned: 0,
        pendingReceiptLedgers: 0,
      };
      for (const route of state.routes) {
        if (!route || typeof route !== 'object' || typeof route.state !== 'string') {
          throw new Error('QUEUE_STATE_INVALID');
        }
        switch (route.state) {
          case 'pending':
            stats.pending += 1;
            break;
          case 'processing':
            stats.processing += 1;
            break;
          case 'retryable':
            stats.retryable += 1;
            break;
          case 'accepted':
            stats.accepted += 1;
            break;
          case 'rejected':
            stats.rejected += 1;
            break;
          case 'quarantined':
            stats.quarantined += 1;
            break;
          case 'handoff_dead':
            stats.handoffDead += 1;
            break;
          case 'completed':
            stats.completed += 1;
            break;
          case 'failed':
            stats.failed += 1;
            break;
          default:
            throw new Error('QUEUE_STATE_INVALID');
        }
        if (route.authority === 'legacy_v1') stats.legacyOwned += 1;
        if (route.receiptLedger === 'pending') stats.pendingReceiptLedgers += 1;
      }
      localQueue = stats;
    } catch {
      localQueue = {
        status: 'unknown',
        reason: 'Local v2 queue state could not be validated safely.',
      };
    }
  }
  const accepted =
    'accepted' in localQueue && typeof localQueue.accepted === 'number'
      ? { value: localQueue.accepted, basis: 'observed' }
      : { value: null, basis: 'unknown' };
  return {
    generatedAt: new Date().toISOString(),
    config: {
      valid: parsed.valid,
      errors: parsed.errors.slice(0, 20),
      notificationServiceConfigured: Boolean(parsed.config?.notification_service),
      routes: configuredRoutes.slice(0, 100),
    },
    localQueue,
    lifecycle: {
      accepted,
      delivered:
        'completed' in localQueue && typeof localQueue.completed === 'number'
          ? { value: localQueue.completed, basis: 'observed', scope: 'direct_only' }
          : { value: null, basis: 'unknown' },
      remoteDelivered: { value: null, basis: 'unknown' },
    },
    nonClaims: [
      'accepted does not mean delivered',
      'local direct completion does not prove remote durable delivery',
    ],
  };
}

function workflowProgressDto(value: unknown): Record<string, unknown> {
  const progress = value as Record<string, unknown>;
  const budget = (progress.budget ?? {}) as Record<string, unknown>;
  const phases = Array.isArray(progress.phases) ? progress.phases : [];
  return {
    runId: safeText(progress.runId, 160),
    workflowName: safeText(progress.workflowName, 160),
    mode: safeText(progress.mode, 40),
    status: safeText(progress.status, 80),
    startedAt: safeText(progress.startedAt, 80),
    updatedAt: safeText(progress.updatedAt, 80),
    elapsedMs: typeof progress.elapsedMs === 'number' ? progress.elapsedMs : undefined,
    currentPhase: safeText(progress.currentPhase, 160),
    phaseCount: typeof progress.phaseCount === 'number' ? progress.phaseCount : 0,
    agentCount: typeof progress.agentCount === 'number' ? progress.agentCount : 0,
    pendingApprovalCount:
      typeof progress.pendingApprovalCount === 'number' ? progress.pendingApprovalCount : 0,
    budget: {
      tokenBudget: typeof budget.tokenBudget === 'number' ? budget.tokenBudget : null,
      tokensUsed: typeof budget.tokensUsed === 'number' ? budget.tokensUsed : 0,
      tokensRemaining: typeof budget.tokensRemaining === 'number' ? budget.tokensRemaining : null,
      costEstimateUsd:
        typeof budget.costEstimateUsd === 'number' ? budget.costEstimateUsd : undefined,
      costSource: safeText(budget.costSource, 80),
      status: safeText(budget.status, 80),
      warnings: Array.isArray(budget.warnings)
        ? budget.warnings
            .slice(0, 20)
            .map((warning) => safeText(warning))
            .filter(Boolean)
        : [],
      agentCalls: typeof budget.agentCalls === 'number' ? budget.agentCalls : 0,
      maxAgents: typeof budget.maxAgents === 'number' ? budget.maxAgents : undefined,
      maxConcurrency: typeof budget.maxConcurrency === 'number' ? budget.maxConcurrency : undefined,
    },
    phases: phases.slice(0, 100).map((phaseValue) => {
      const phase = phaseValue as Record<string, unknown>;
      const agents = Array.isArray(phase.agents) ? phase.agents : [];
      return {
        phase: safeText(phase.phase, 160),
        status: safeText(phase.status, 80),
        timestamp: safeText(phase.timestamp, 80),
        agentCount: typeof phase.agentCount === 'number' ? phase.agentCount : 0,
        tokenTotal: typeof phase.tokenTotal === 'number' ? phase.tokenTotal : 0,
        cachedCount: typeof phase.cachedCount === 'number' ? phase.cachedCount : 0,
        liveCount: typeof phase.liveCount === 'number' ? phase.liveCount : 0,
        failedCount: typeof phase.failedCount === 'number' ? phase.failedCount : 0,
        agents: agents.slice(0, 100).map((agentValue) => {
          const agent = agentValue as Record<string, unknown>;
          const recentTools = Array.isArray(agent.recentTools) ? agent.recentTools : [];
          return {
            id: safeIdentifier(agent.id),
            label: safeIdentifier(agent.label),
            phase: safeIdentifier(agent.phase),
            status: safeIdentifier(agent.status, 80),
            cached: agent.cached === true,
            agentRunId: safeIdentifier(agent.agentRunId),
            model: safeIdentifier(agent.model),
            runtimeProvider: safeIdentifier(agent.runtimeProvider),
            bridgeMode: safeIdentifier(agent.bridgeMode, 80),
            isolation: safeIdentifier(agent.isolation, 80),
            terminalReason: safeIdentifier(agent.terminalReason, 200),
            tokensUsed: typeof agent.tokensUsed === 'number' ? agent.tokensUsed : 0,
            tokensRemaining:
              typeof agent.tokensRemaining === 'number' ? agent.tokensRemaining : null,
            recentTools: recentTools.slice(0, 8).map((toolValue) => {
              const tool = toolValue as Record<string, unknown>;
              return {
                type: safeIdentifier(tool.type, 80),
                name: safeIdentifier(tool.name),
                timestamp: safeText(tool.timestamp, 80),
              };
            }),
            warnings: Array.isArray(agent.warnings)
              ? agent.warnings
                  .slice(0, 20)
                  .map((warning) => safeText(warning))
                  .filter(Boolean)
              : [],
          };
        }),
      };
    }),
    warnings: Array.isArray(progress.warnings)
      ? progress.warnings
          .slice(0, 50)
          .map((warning) => safeText(warning))
          .filter(Boolean)
      : [],
    evidenceRef:
      typeof progress.runId === 'string'
        ? `workflow-run:${progress.runId.slice(0, 160)}`
        : undefined,
  };
}

function modulesDto(rootDir: string): readonly Record<string, unknown>[] {
  const modulesPath = join(rootDir, '.openslack', 'modules.yaml');
  const registry = objectValue(
    parseYaml(readBoundedTextFileSync(modulesPath, MAX_LOCAL_JSON_BYTES)),
  );
  if (
    !['openslack.modules.v1', 'openslack.modules.v2'].includes(String(registry.schema)) ||
    !Array.isArray(registry.modules) ||
    registry.modules.length > 100
  ) {
    throw new LocalReadBoundError('LOCAL_INPUT_INVALID_MODULE_REGISTRY');
  }
  return registry.modules.map((value) => {
    const module = objectValue(value);
    const status = stringValue(module.status, 'module_status');
    const isV2 = registry.schema === 'openslack.modules.v2';
    if (!['planned', 'early', 'active', 'retired'].includes(status)) {
      throw new LocalReadBoundError('LOCAL_INPUT_INVALID_MODULE_STATUS');
    }
    const maturity = isV2
      ? stringValue(module.maturity, 'module_maturity')
      : status === 'planned'
        ? 'planned'
        : 'implemented';
    if (
      !['planned', 'implemented', 'local_ready', 'live_verified', 'production_ready'].includes(
        maturity,
      )
    ) {
      throw new LocalReadBoundError('LOCAL_INPUT_INVALID_MODULE_MATURITY');
    }
    return {
      id: stringValue(module.id, 'module_id'),
      name: stringValue(module.name, 'module_name'),
      status,
      maturity,
      operatorConfigured: isV2 ? module.operatorConfigured === true : false,
      externalBlockers: isV2 ? optionalStringArray(module.externalBlockers, 50) : [],
      evidenceRefs: isV2 ? optionalStringArray(module.evidenceRefs, 50) : [],
      phase: stringValue(module.phase, 'module_phase'),
      cli: optionalStringArray(module.cli, 100),
      packages: optionalStringArray(module.packages, 100),
      ...(typeof module.notes === 'string' ? { notes: module.notes } : {}),
    };
  });
}

export function createDefaultOpenSlackReadModelPorts(
  workspaceRoot: string,
  businessOutcomes?: BusinessOutcomesReaderPort,
  options: {
    readonly clock?: () => Date;
    readonly graphMaxAgeMs?: number;
  } = {},
): OpenSlackReadModelPorts {
  const rootDir = resolve(workspaceRoot);
  const clock = canonicalClock(options.clock);
  const maxGraphAgeMs = graphMaxAge(options.graphMaxAgeMs);
  const graphStore = new LocalGraphStore(join(rootDir, '.openslack.local', 'graph'));
  const graphCursorSecret = randomBytes(32);
  const scenarioRoot = join(rootDir, 'scenarios');

  const loadScenarios = async (): Promise<readonly LoadedScenarioDefinition[]> => {
    const catalog = createSoftwareDeliveryScenarioCatalog();
    try {
      return await Promise.all(
        SCENARIO_IDS.map((scenarioId) => loadScenarioPack({ scenarioRoot, scenarioId, catalog })),
      );
    } catch {
      throw new ProjectionEvidenceUnavailableError(
        'SOURCE_EVIDENCE_UNAVAILABLE',
        'No locked Scenario Definition is available from the bounded scenario catalog.',
      );
    }
  };

  const currentGraph = async (scenarioInstanceId: string) => {
    const cursor = await graphStore.currentCursor(scenarioInstanceId);
    if (cursor === null) {
      throw new ProjectionEvidenceUnavailableError(
        'SOURCE_EVIDENCE_UNAVAILABLE',
        `No current graph snapshot is recorded for ${scenarioInstanceId}.`,
      );
    }
    let snapshot;
    try {
      snapshot = await graphStore.readCurrentSnapshot(scenarioInstanceId);
    } catch (error) {
      if (error instanceof GraphStoreError && error.code === 'GRAPH_STORE_NOT_FOUND') {
        throw new ProjectionEvidenceUnavailableError(
          'SOURCE_EVIDENCE_UNAVAILABLE',
          `No current graph snapshot is recorded for ${scenarioInstanceId}.`,
        );
      }
      throw error;
    }
    const generatedAt = Date.parse(snapshot.generatedAt);
    const now = clock().getTime();
    if (!Number.isFinite(generatedAt) || generatedAt > now + 5 * 60 * 1_000) {
      throw new Error('GRAPH_SNAPSHOT_TIME_INVALID');
    }
    if (now - generatedAt > maxGraphAgeMs) {
      throw new ProjectionEvidenceUnavailableError(
        'SOURCE_EVIDENCE_STALE',
        `The current graph snapshot for ${scenarioInstanceId} is stale.`,
      );
    }
    return snapshot;
  };

  const ports: OpenSlackReadModelPorts = {
    executiveOverview: ({ sinceHours, limit }) => {
      const events = eventsForWindow(rootDir, sinceHours);
      const stores = readCollaborationStores(rootDir);
      const dashboard = fallbackDashboard(events, sinceHours, stores);
      return {
        generatedAt: new Date().toISOString(),
        modules: modulesDto(rootDir),
        dashboard: dashboardDto(dashboard, limit),
      };
    },
    workItems: ({ status, sinceHours, limit }) => {
      const events = eventsForWindow(rootDir, sinceHours).filter(
        (event) =>
          event.object.kind === 'issue' &&
          TASK_TYPES.has(event.type) &&
          (!status || event.type === `task.${status}`),
      );
      const latest = new Map<string, CollaborationEvent>();
      for (const event of events)
        if (!latest.has(event.object.id)) latest.set(event.object.id, event);
      return {
        generatedAt: new Date().toISOString(),
        freshness: events[0]?.timestamp ?? null,
        items: [...latest.values()].slice(0, limit).map((event) => ({
          id: event.object.id,
          status: event.type.slice('task.'.length),
          summary: event.summary,
          owner: event.owner ? `${event.owner.kind}:${event.owner.id}` : undefined,
          source: sourceRef(event),
          observedAt: event.timestamp,
          evidenceRef: eventEvidence(event),
        })),
      };
    },
    workRoom: ({ roomId, limit }) => {
      const events = eventsForWindow(rootDir, 0);
      const room = fallbackRoom(roomId, events, readCollaborationStores(rootDir));
      if (!room) return null;
      return roomDto(room, limit);
    },
    activity: ({ sinceHours, objectKind, objectId, limit }) => {
      const filter: EventFilter = {};
      if (objectKind) filter.objectKind = objectKind as EventFilter['objectKind'];
      if (objectId) filter.objectId = objectId;
      const events = filterEvents(eventsForWindow(rootDir, sinceHours), filter).slice(0, limit);
      return {
        generatedAt: new Date().toISOString(),
        events: events.map(eventDto),
        evidenceRefs: events.map(eventEvidence),
      };
    },
    workflowProgress: async ({ runId }) => {
      const progress = await getWorkflowRunProgress(runId, {
        rootDir,
        loadWorkflowManifest: false,
        loadCostConfig: false,
        strictRead: true,
      });
      return progress ? workflowProgressDto(progress) : null;
    },
    prReadiness: async ({ prNumber, repo, signal }) => {
      const options = {
        ...(repo ? { repoFullName: repo } : {}),
        cwd: rootDir,
        localStateRoot: join(rootDir, '.openslack.local'),
        requireLive: true,
        strictEvidence: true,
        signal,
        evidenceLimits: {
          maxPages: 5,
          maxFiles: 500,
          maxReviews: 500,
          maxChecks: 500,
          maxTreeEntries: 20_000,
          maxPatches: 500,
          maxCodeownerMatchOperations: 50_000,
        },
      } as const;
      const fetched = await fetchPRDetails(prNumber, options);
      const classified = classifyPRReport(fetched);
      const policy = loadPRReviewPolicy(rootDir, { strict: true });
      const codeowners = (await loadPRCodeownerEvidence(classified, options)).owners;
      const report = diagnosePR(classified, policy, codeowners);
      return {
        generatedAt: new Date().toISOString(),
        headSha: report.headSha ?? null,
        summary: summarizePRDecision(report, codeowners),
        readiness: {
          prNumber: report.prNumber,
          title: report.title,
          state: report.state,
          draft: report.draft,
          baseRef: report.baseRef,
          headSha: report.headSha,
          riskZone: report.riskZone,
          decision: report.decision,
          reason: report.reason,
          recommendation: report.recommendation,
          mergeable: report.mergeable,
          checks: report.checks.slice(0, 100).map((check) => ({
            name: check.name,
            status: check.status,
            conclusion: check.conclusion,
          })),
          humanApprovalCount: report.humanApprovals.length,
          workflowGate: report.workflowGate
            ? {
                overall: report.workflowGate.overall,
                criteria: report.workflowGate.criteria.slice(0, 50).map((criterion) => ({
                  name: criterion.name,
                  status: criterion.status,
                  detail: criterion.detail,
                })),
              }
            : undefined,
        },
      };
    },
    pendingApprovals: ({ limit }) => pendingGovernance(eventsForWindow(rootDir, 0), rootDir, limit),
    notificationStatus: () => notificationProjection(rootDir),
    businessOutcomes: businessOutcomes ?? defaultBusinessOutcomesReader(rootDir),
    scenarios: async () => {
      const definitions = await loadScenarios();
      return {
        generatedAt: clock().toISOString(),
        scenarios: definitions.map((definition) => ({
          id: definition.manifest.id,
          version: definition.manifest.version,
          title: definition.manifest.title,
          description: definition.manifest.description,
          definitionHash: definition.definitionHash,
          projectorIds: definition.projections.projectors.map((projector) => projector.id),
          viewIds: definition.views.views.map((view) => view.id),
          evidenceRef: `artifact:sha256:${definition.definitionHash}`,
        })),
        evidenceRefs: definitions.map(
          (definition) => `artifact:sha256:${definition.definitionHash}`,
        ),
      };
    },
    graphQuery: async (input) => {
      const snapshot = await currentGraph(input.scenarioInstanceId);
      const result: GraphQueryResult = queryGraph(snapshot, input, {
        cursorSecret: graphCursorSecret,
        now: clock(),
      });
      return {
        generatedAt: snapshot.generatedAt,
        ...result,
      };
    },
    graphExplain: async (input) => {
      const snapshot = await currentGraph(input.scenarioInstanceId);
      const result: GraphExplanation = explainGraph(snapshot, input);
      return {
        generatedAt: snapshot.generatedAt,
        snapshotCursor: snapshot.cursor,
        ...result,
      };
    },
  };
  return Object.freeze(ports);
}

export function createOpenSlackMcpContext(
  options: CreateOpenSlackMcpContextOptions,
): OpenSlackMcpContext {
  const workspaceRoot = resolve(options.workspaceRoot);
  const clock = canonicalClock(options.clock);
  const defaults = createDefaultOpenSlackReadModelPorts(workspaceRoot, options.businessOutcomes, {
    clock,
    graphMaxAgeMs: options.graphMaxAgeMs,
  });
  const runtime = Object.freeze({
    now: clock,
    nextCorrelationId: canonicalCorrelationFactory(options.correlationIdFactory),
  });
  const demoReset = assertLocalDemoResetPort(workspaceRoot, options.demoMode, options.demoReset);
  const governedMutations =
    options.governedMutations === undefined
      ? undefined
      : assertOpenSlackGovernedMutationPort(options.governedMutations);
  const workflowApprovalAuthority =
    options.workflowApprovalAuthority === undefined
      ? undefined
      : assertOpenSlackWorkflowApprovalPort(options.workflowApprovalAuthority);
  if (workflowApprovalAuthority && !governedMutations) {
    throw new TypeError(
      'Workflow approval authority cannot be exposed without governed mutations.',
    );
  }
  return Object.freeze({
    workspaceRoot,
    operator: options.operator,
    readers: Object.freeze({ ...defaults, ...options.readers }),
    runtime,
    ...(governedMutations ? { governedMutations } : {}),
    ...(workflowApprovalAuthority ? { workflowApprovalAuthority } : {}),
    ...(demoReset ? { demoReset } : {}),
  });
}

import type { CollaborationEvent } from './types.js';

export type BusinessOutcomeBasis = 'observed' | 'configured_estimate' | 'unknown';

export interface BusinessOutcomeMetric<T = number | string | null> {
  value: T;
  basis: BusinessOutcomeBasis;
  unit?: string;
  evidenceRefs: string[];
  note?: string;
}

export interface ObservedBusinessOutcomeValue<T> {
  value: T;
  evidenceRefs: string[];
  unit?: string;
  note?: string;
}

export interface ConfiguredBusinessOutcomeEstimate<T> {
  value: T;
  assumptionRef: string;
  assumptionVersion: string;
  unit?: string;
  note?: string;
}

export interface BusinessOutcomeSourceSnapshot {
  generatedAt: string;
  period: {
    from: string;
    to: string;
  };
  scenario?: string;
  events: CollaborationEvent[];
  /**
   * References that identify the bounded source query, even when it returned no
   * rows. They are evidence for observed zero counts, not evidence of delivery
   * or approval.
   */
  evidenceRefs: string[];
  observed?: {
    blockedHours?: ObservedBusinessOutcomeValue<number>;
    currentHeadHumanApprovals?: ObservedBusinessOutcomeValue<number>;
    /**
     * Human review actions other than the current-head approvals supplied
     * above. Keeping approvals out of this count prevents a single GitHub
     * approval from being counted as two interventions.
     */
    reviewsExcludingApprovals?: ObservedBusinessOutcomeValue<number>;
    activeAgents?: ObservedBusinessOutcomeValue<number>;
    agentRuntimeCost?: ObservedBusinessOutcomeValue<number>;
    notificationAccepted?: ObservedBusinessOutcomeValue<number>;
    notificationDelivered?: ObservedBusinessOutcomeValue<number>;
  };
  estimates?: {
    agentRuntimeCost?: ConfiguredBusinessOutcomeEstimate<number>;
    estimatedManualHours?: ConfiguredBusinessOutcomeEstimate<number>;
  };
  reuse?: {
    reusedWorkflowRunIds?: ObservedBusinessOutcomeValue<string[]>;
    exportedSkillIds?: ObservedBusinessOutcomeValue<string[]>;
  };
}

export interface BusinessOutcomeProjection {
  schema: 'openslack.business_outcome.v1';
  generatedAt: string;
  period: { from: string; to: string };
  scenario?: string;
  work: {
    created: BusinessOutcomeMetric<number>;
    completed: BusinessOutcomeMetric<number>;
    completionRate: BusinessOutcomeMetric<number | null>;
    averageCycleHours: BusinessOutcomeMetric<number | null>;
    blockedHours: BusinessOutcomeMetric<number | null>;
  };
  governance: {
    humanApprovals: BusinessOutcomeMetric<number | null>;
    humanInterventions: BusinessOutcomeMetric<number | null>;
    prFirstPassRate: BusinessOutcomeMetric<number | null>;
    reworkCount: BusinessOutcomeMetric<number>;
  };
  agents: {
    agentActions: BusinessOutcomeMetric<number>;
    agentRuns: BusinessOutcomeMetric<number>;
    failedRuns: BusinessOutcomeMetric<number>;
    activeAgents: BusinessOutcomeMetric<number>;
  };
  economics: {
    agentRuntimeCost: BusinessOutcomeMetric<number | null>;
    estimatedManualHours: BusinessOutcomeMetric<number | null>;
    costPerCompletedItem: BusinessOutcomeMetric<number | null>;
  };
  reuse: {
    workflowRuns: BusinessOutcomeMetric<number>;
    workflowReuseCount: BusinessOutcomeMetric<number>;
    exportedSkills: BusinessOutcomeMetric<number>;
  };
  notifications: {
    approvalNotifications: BusinessOutcomeMetric<number>;
    blockerNotifications: BusinessOutcomeMetric<number>;
    accepted: BusinessOutcomeMetric<number | null>;
    delivered: BusinessOutcomeMetric<number | null>;
  };
  gaps: string[];
  evidenceRefs: string[];
}

type MetricGroup = Omit<
  BusinessOutcomeProjection,
  'schema' | 'generatedAt' | 'period' | 'scenario' | 'gaps' | 'evidenceRefs'
>;

const METRIC_PATHS = [
  'work.created',
  'work.completed',
  'work.completionRate',
  'work.averageCycleHours',
  'work.blockedHours',
  'governance.humanApprovals',
  'governance.humanInterventions',
  'governance.prFirstPassRate',
  'governance.reworkCount',
  'agents.agentActions',
  'agents.agentRuns',
  'agents.failedRuns',
  'agents.activeAgents',
  'economics.agentRuntimeCost',
  'economics.estimatedManualHours',
  'economics.costPerCompletedItem',
  'reuse.workflowRuns',
  'reuse.workflowReuseCount',
  'reuse.exportedSkills',
  'notifications.approvalNotifications',
  'notifications.blockerNotifications',
  'notifications.accepted',
  'notifications.delivered',
] as const;

const NULLABLE_METRIC_PATHS = new Set<string>([
  'work.completionRate',
  'work.averageCycleHours',
  'work.blockedHours',
  'governance.humanApprovals',
  'governance.humanInterventions',
  'governance.prFirstPassRate',
  'economics.agentRuntimeCost',
  'economics.estimatedManualHours',
  'economics.costPerCompletedItem',
  'notifications.accepted',
  'notifications.delivered',
]);

const COUNT_METRIC_PATHS = new Set<string>([
  'work.created',
  'work.completed',
  'governance.humanApprovals',
  'governance.humanInterventions',
  'governance.reworkCount',
  'agents.agentActions',
  'agents.agentRuns',
  'agents.failedRuns',
  'agents.activeAgents',
  'reuse.workflowRuns',
  'reuse.workflowReuseCount',
  'reuse.exportedSkills',
  'notifications.approvalNotifications',
  'notifications.blockerNotifications',
  'notifications.accepted',
  'notifications.delivered',
]);

const RATIO_METRIC_PATHS = new Set<string>(['work.completionRate', 'governance.prFirstPassRate']);

const BASIS_STRENGTH: Readonly<Record<BusinessOutcomeBasis, number>> = {
  unknown: 0,
  configured_estimate: 1,
  observed: 2,
};

function weakestBasis(
  first: BusinessOutcomeBasis,
  ...remaining: BusinessOutcomeBasis[]
): BusinessOutcomeBasis {
  return remaining.reduce(
    (weakest, basis) => (BASIS_STRENGTH[basis] < BASIS_STRENGTH[weakest] ? basis : weakest),
    first,
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function eventRef(event: CollaborationEvent): string {
  return `event:${event.id}`;
}

function eventObjectRef(event: CollaborationEvent): string {
  return `${event.object.kind}:${event.object.id}`;
}

function observed<T>(
  value: T,
  evidenceRefs: string[],
  options: { unit?: string; note?: string } = {},
): BusinessOutcomeMetric<T> {
  return {
    value,
    basis: 'observed',
    ...(options.unit ? { unit: options.unit } : {}),
    evidenceRefs: unique(evidenceRefs),
    ...(options.note ? { note: options.note } : {}),
  };
}

function observedInput<T>(
  input: ObservedBusinessOutcomeValue<T> | undefined,
  fallback: T,
  unknownNote: string,
): BusinessOutcomeMetric<T> {
  if (!input || input.evidenceRefs.length === 0) {
    return unknown(fallback, unknownNote);
  }
  return observed(input.value, input.evidenceRefs, {
    ...(input.unit ? { unit: input.unit } : {}),
    ...(input.note ? { note: input.note } : {}),
  });
}

function validObservedCount(
  input: ObservedBusinessOutcomeValue<number> | undefined,
): input is ObservedBusinessOutcomeValue<number> {
  return (
    input !== undefined &&
    Number.isInteger(input.value) &&
    input.value >= 0 &&
    input.evidenceRefs.length > 0 &&
    input.evidenceRefs.every((reference) => reference.trim() !== '')
  );
}

function normalizedObservedIds(
  input: ObservedBusinessOutcomeValue<string[]> | undefined,
): ObservedBusinessOutcomeValue<string[]> | undefined {
  if (
    !input ||
    !Array.isArray(input.value) ||
    input.value.some((id) => typeof id !== 'string' || id.trim() === '') ||
    input.evidenceRefs.length === 0 ||
    input.evidenceRefs.some((reference) => reference.trim() === '')
  ) {
    return undefined;
  }
  return {
    ...input,
    value: unique(input.value.map((id) => id.trim())),
  };
}

function estimateInput<T>(
  input: ConfiguredBusinessOutcomeEstimate<T> | undefined,
  fallback: T,
  unknownNote: string,
): BusinessOutcomeMetric<T> {
  if (!input || !input.assumptionRef.trim() || !input.assumptionVersion.trim()) {
    return unknown(fallback, unknownNote);
  }
  return {
    value: input.value,
    basis: 'configured_estimate',
    ...(input.unit ? { unit: input.unit } : {}),
    evidenceRefs: [`${input.assumptionRef}@${input.assumptionVersion}`],
    ...(input.note ? { note: input.note } : {}),
  };
}

function unknown<T>(value: T, note: string): BusinessOutcomeMetric<T> {
  return { value, basis: 'unknown', evidenceRefs: [], note };
}

function isInPeriod(event: CollaborationEvent, period: BusinessOutcomeSourceSnapshot['period']) {
  const timestamp = Date.parse(event.timestamp);
  const from = Date.parse(period.from);
  const to = Date.parse(period.to);
  return Number.isFinite(timestamp) && timestamp >= from && timestamp <= to;
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function validateBusinessOutcomeSourceSnapshot(
  snapshot: BusinessOutcomeSourceSnapshot,
): string[] {
  const errors: string[] = [];
  if (!isCanonicalIsoTimestamp(snapshot.generatedAt)) {
    errors.push('generatedAt must be a canonical ISO-8601 UTC timestamp.');
  }
  if (!isCanonicalIsoTimestamp(snapshot.period.from)) {
    errors.push('period.from must be a canonical ISO-8601 UTC timestamp.');
  }
  if (!isCanonicalIsoTimestamp(snapshot.period.to)) {
    errors.push('period.to must be a canonical ISO-8601 UTC timestamp.');
  }
  if (
    isCanonicalIsoTimestamp(snapshot.period.from) &&
    isCanonicalIsoTimestamp(snapshot.period.to) &&
    Date.parse(snapshot.period.from) > Date.parse(snapshot.period.to)
  ) {
    errors.push('period.from must be before or equal to period.to.');
  }
  if (
    isCanonicalIsoTimestamp(snapshot.period.to) &&
    isCanonicalIsoTimestamp(snapshot.generatedAt) &&
    Date.parse(snapshot.period.to) > Date.parse(snapshot.generatedAt)
  ) {
    errors.push('period.to must be before or equal to generatedAt.');
  }
  if (
    snapshot.evidenceRefs.length === 0 ||
    snapshot.evidenceRefs.some((reference) => reference.trim() === '')
  ) {
    errors.push('evidenceRefs must contain at least one non-empty bounded source-query reference.');
  }
  return errors;
}

export interface BusinessOutcomeProjectionValidation {
  valid: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function valueAtPath(value: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    return isRecord(current) ? current[key] : undefined;
  }, value);
}

/**
 * Runtime validation for the complete public v1 JSON contract. This deliberately
 * validates metric evidence invariants as well as the schema discriminator.
 */
export function validateBusinessOutcomeProjection(
  value: unknown,
): BusinessOutcomeProjectionValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ['projection must be an object.'] };
  if (value.schema !== 'openslack.business_outcome.v1') {
    errors.push('schema must be openslack.business_outcome.v1.');
  }
  if (typeof value.generatedAt !== 'string' || !isCanonicalIsoTimestamp(value.generatedAt)) {
    errors.push('generatedAt must be a canonical ISO-8601 UTC timestamp.');
  }
  if (!isRecord(value.period)) {
    errors.push('period must be an object.');
  } else {
    if (typeof value.period.from !== 'string' || !isCanonicalIsoTimestamp(value.period.from)) {
      errors.push('period.from must be a canonical ISO-8601 UTC timestamp.');
    }
    if (typeof value.period.to !== 'string' || !isCanonicalIsoTimestamp(value.period.to)) {
      errors.push('period.to must be a canonical ISO-8601 UTC timestamp.');
    }
    if (
      typeof value.period.from === 'string' &&
      typeof value.period.to === 'string' &&
      isCanonicalIsoTimestamp(value.period.from) &&
      isCanonicalIsoTimestamp(value.period.to) &&
      Date.parse(value.period.from) > Date.parse(value.period.to)
    ) {
      errors.push('period.from must be before or equal to period.to.');
    }
    if (
      typeof value.period.to === 'string' &&
      typeof value.generatedAt === 'string' &&
      isCanonicalIsoTimestamp(value.period.to) &&
      isCanonicalIsoTimestamp(value.generatedAt) &&
      Date.parse(value.period.to) > Date.parse(value.generatedAt)
    ) {
      errors.push('period.to must be before or equal to generatedAt.');
    }
  }
  if (value.scenario !== undefined && typeof value.scenario !== 'string') {
    errors.push('scenario must be a string when present.');
  }

  for (const path of METRIC_PATHS) {
    const metric = valueAtPath(value, path);
    if (!isRecord(metric)) {
      errors.push(`${path} must be a metric object.`);
      continue;
    }
    if (!['observed', 'configured_estimate', 'unknown'].includes(String(metric.basis))) {
      errors.push(`${path}.basis is invalid.`);
    }
    const nullable = NULLABLE_METRIC_PATHS.has(path);
    if (typeof metric.value !== 'number' && !(nullable && metric.value === null)) {
      errors.push(
        `${path}.value must be ${nullable ? 'a finite number or null' : 'a finite number'}.`,
      );
    } else if (typeof metric.value === 'number' && !Number.isFinite(metric.value)) {
      errors.push(`${path}.value must be finite.`);
    } else if (typeof metric.value === 'number' && metric.value < 0) {
      errors.push(`${path}.value must not be negative.`);
    } else if (
      typeof metric.value === 'number' &&
      COUNT_METRIC_PATHS.has(path) &&
      !Number.isInteger(metric.value)
    ) {
      errors.push(`${path}.value must be an integer.`);
    } else if (
      typeof metric.value === 'number' &&
      RATIO_METRIC_PATHS.has(path) &&
      metric.value > 1
    ) {
      errors.push(`${path}.value must be between 0 and 1.`);
    }
    if (
      !Array.isArray(metric.evidenceRefs) ||
      metric.evidenceRefs.some(
        (reference) => typeof reference !== 'string' || reference.trim() === '',
      )
    ) {
      errors.push(`${path}.evidenceRefs must be a string array.`);
    } else if (
      (metric.basis === 'observed' || metric.basis === 'configured_estimate') &&
      metric.evidenceRefs.length === 0
    ) {
      errors.push(`${path} requires evidence for ${String(metric.basis)} basis.`);
    }
    if (metric.unit !== undefined && typeof metric.unit !== 'string') {
      errors.push(`${path}.unit must be a string when present.`);
    }
    if (metric.note !== undefined && typeof metric.note !== 'string') {
      errors.push(`${path}.note must be a string when present.`);
    }
  }

  if (!Array.isArray(value.gaps) || value.gaps.some((gap) => typeof gap !== 'string')) {
    errors.push('gaps must be a string array.');
  }
  if (
    !Array.isArray(value.evidenceRefs) ||
    value.evidenceRefs.length === 0 ||
    value.evidenceRefs.some((reference) => typeof reference !== 'string' || reference.trim() === '')
  ) {
    errors.push('evidenceRefs must be a non-empty string array.');
  }
  return { valid: errors.length === 0, errors };
}

function belongsToScenario(event: CollaborationEvent, scenario: string | undefined): boolean {
  if (!scenario) return true;
  const eventScenario = event.metadata?.scenarioId ?? event.metadata?.scenario;
  return eventScenario === scenario;
}

function notificationSubject(event: CollaborationEvent): string | undefined {
  const candidate =
    event.metadata?.notificationType ?? event.metadata?.subject ?? event.metadata?.eventType;
  return typeof candidate === 'string' ? candidate : undefined;
}

function collectMetricEntries(groups: MetricGroup): Array<[string, BusinessOutcomeMetric]> {
  const entries: Array<[string, BusinessOutcomeMetric]> = [];
  for (const [groupName, group] of Object.entries(groups)) {
    for (const [metricName, metric] of Object.entries(group)) {
      entries.push([`${groupName}.${metricName}`, metric as BusinessOutcomeMetric]);
    }
  }
  return entries;
}

export function buildBusinessOutcomeProjection(
  snapshot: BusinessOutcomeSourceSnapshot,
): BusinessOutcomeProjection {
  const snapshotErrors = validateBusinessOutcomeSourceSnapshot(snapshot);
  if (snapshotErrors.length > 0) {
    throw new Error(`Invalid business outcome source snapshot: ${snapshotErrors.join(' ')}`);
  }

  const scopedEvents = snapshot.events
    .filter((event) => isInPeriod(event, snapshot.period))
    .filter((event) => belongsToScenario(event, snapshot.scenario));
  const seenEventIds = new Set<string>();
  const periodEvents = scopedEvents
    .filter((event) => {
      if (seenEventIds.has(event.id)) return false;
      seenEventIds.add(event.id);
      return true;
    })
    .sort(
      (left, right) =>
        Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.id.localeCompare(right.id),
    );
  const queryEvidence = unique(snapshot.evidenceRefs);

  const createdByObject = new Map<string, CollaborationEvent>();
  for (const event of periodEvents) {
    if (event.type !== 'task.created') continue;
    const key = eventObjectRef(event);
    if (!createdByObject.has(key)) createdByObject.set(key, event);
  }

  const completedPairs: Array<{
    created: CollaborationEvent;
    completed: CollaborationEvent;
  }> = [];
  for (const [key, created] of createdByObject) {
    const completed = periodEvents.find(
      (event) =>
        event.type === 'task.done' &&
        eventObjectRef(event) === key &&
        Date.parse(event.timestamp) >= Date.parse(created.timestamp),
    );
    if (completed) completedPairs.push({ created, completed });
  }

  const createdEvidence = [
    ...queryEvidence,
    ...[...createdByObject.values()].map((event) => eventRef(event)),
  ];
  const completedEvidence = [
    ...queryEvidence,
    ...completedPairs.flatMap(({ created, completed }) => [eventRef(created), eventRef(completed)]),
  ];
  const averageCycleHours =
    completedPairs.length === 0
      ? unknown<number | null>(
          null,
          'No task.created/task.done pair was recorded in the selected period.',
        )
      : observed(
          completedPairs.reduce(
            (total, pair) =>
              total +
              (Date.parse(pair.completed.timestamp) - Date.parse(pair.created.timestamp)) /
                3_600_000,
            0,
          ) / completedPairs.length,
          completedEvidence,
          { unit: 'hours', note: 'Cycle time uses task.done paired to task.created by object ID.' },
        );
  const completionRate =
    createdByObject.size === 0
      ? unknown<number | null>(null, 'No task.created cohort exists in the selected period.')
      : observed(completedPairs.length / createdByObject.size, completedEvidence, {
          unit: 'ratio',
          note: 'Completed items are task.done events paired to this period task.created cohort.',
        });

  const prDoctorEvents = periodEvents.filter(
    (event) => event.type === 'pr.doctor.ready' || event.type === 'pr.doctor.blocked',
  );
  const firstPrObservation = new Map<string, CollaborationEvent>();
  const reworkEvents: CollaborationEvent[] = [];
  for (const event of prDoctorEvents) {
    const key = eventObjectRef(event);
    if (!firstPrObservation.has(key)) firstPrObservation.set(key, event);
    else if (event.type === 'pr.doctor.blocked') reworkEvents.push(event);
  }
  const firstPassEvents = [...firstPrObservation.values()];
  const readyFirstPass = firstPassEvents.filter((event) => event.type === 'pr.doctor.ready');
  const prFirstPassRate =
    firstPassEvents.length === 0
      ? unknown<number | null>(
          null,
          'No first recorded PRMS ready/blocked observation exists in the selected period.',
        )
      : observed(
          readyFirstPass.length / firstPassEvents.length,
          [...queryEvidence, ...firstPassEvents.map(eventRef)],
          {
            unit: 'ratio',
            note: 'Recorded first-pass rate; it is not a claim about global PR quality.',
          },
        );

  const humanCollaborationEvents = periodEvents.filter(
    (event) =>
      event.actor.kind === 'human' &&
      (event.type.startsWith('handoff.') || event.type.startsWith('decision.')),
  );
  const suppliedApprovalInput = snapshot.observed?.currentHeadHumanApprovals;
  const suppliedReviewInput = snapshot.observed?.reviewsExcludingApprovals;
  const approvalInput = validObservedCount(suppliedApprovalInput)
    ? suppliedApprovalInput
    : undefined;
  const reviewInputCandidate = validObservedCount(suppliedReviewInput)
    ? suppliedReviewInput
    : undefined;
  const approvalEvidence = new Set(
    approvalInput?.evidenceRefs.map((reference) => reference.trim()) ?? [],
  );
  const reviewEvidenceOverlapsApproval =
    reviewInputCandidate?.evidenceRefs.some((reference) =>
      approvalEvidence.has(reference.trim()),
    ) ?? false;
  const reviewInterventions = reviewEvidenceOverlapsApproval ? undefined : reviewInputCandidate;
  const excludedInterventionInputs = [
    suppliedApprovalInput !== undefined && approvalInput === undefined
      ? 'The approval input was excluded because it was not a non-negative integer with evidence.'
      : undefined,
    suppliedReviewInput !== undefined && reviewInputCandidate === undefined
      ? 'The review intervention input was excluded because it was not a non-negative integer with evidence.'
      : undefined,
    reviewEvidenceOverlapsApproval
      ? 'The review intervention input was excluded because its evidence overlaps current-head approval evidence.'
      : undefined,
  ].filter((message): message is string => message !== undefined);
  const approvals = approvalInput
    ? observed<number | null>(approvalInput.value, approvalInput.evidenceRefs, {
        ...(approvalInput.unit ? { unit: approvalInput.unit } : {}),
        ...(approvalInput.note ? { note: approvalInput.note } : {}),
      })
    : unknown<number | null>(
        null,
        'No valid evidence-backed non-negative integer current-head PRMS approval snapshot was supplied.',
      );
  const humanInterventionEvidence = unique([
    ...humanCollaborationEvents.map(eventRef),
    ...(reviewInterventions?.evidenceRefs ?? []),
    ...(approvalInput?.evidenceRefs ?? []),
  ]);
  const humanInterventions =
    humanInterventionEvidence.length === 0
      ? unknown<number | null>(
          null,
          'No explicit human-owned handoff, decision, or authoritative review evidence was supplied.',
        )
      : observed(
          humanCollaborationEvents.length +
            (reviewInterventions?.value ?? 0) +
            (approvalInput?.value ?? 0),
          humanInterventionEvidence,
          {
            note:
              excludedInterventionInputs.length > 0
                ? excludedInterventionInputs.join(' ')
                : 'Review interventions exclude current-head approvals; OpenSlack confirmations and pr.review.commented are not GitHub human approvals.',
          },
        );

  const agentActions = periodEvents.filter(
    (event) => event.type === 'operator.execution.completed' && event.actor.kind === 'agent',
  );
  const agentRuns = periodEvents.filter((event) => event.type === 'agent.conversation.started');
  const failedRuns = periodEvents.filter((event) => event.type === 'agent.conversation.failed');
  const workflowRuns = periodEvents.filter((event) => event.type === 'workflow.started');

  const directNotificationEvents = periodEvents.filter(
    (event) => event.type === 'notification.sent' || event.type === 'notification.failed',
  );
  const approvalNotifications = directNotificationEvents.filter(
    (event) => notificationSubject(event) === 'approval.required',
  );
  const blockerNotifications = directNotificationEvents.filter(
    (event) => notificationSubject(event) === 'workflow.blocked',
  );

  const runtimeCost =
    snapshot.observed?.agentRuntimeCost !== undefined
      ? observedInput<number | null>(
          snapshot.observed.agentRuntimeCost,
          null,
          'Agent runtime cost evidence is invalid.',
        )
      : estimateInput<number | null>(
          snapshot.estimates?.agentRuntimeCost,
          null,
          'No authoritative runtime-cost evidence or versioned estimate was supplied.',
        );
  const manualHours = estimateInput<number | null>(
    snapshot.estimates?.estimatedManualHours,
    null,
    'No versioned manual-hours assumption was supplied.',
  );
  const costPerCompletedItem =
    runtimeCost.value === null || completedPairs.length === 0
      ? unknown<number | null>(
          null,
          'Runtime cost and at least one paired completed item are required.',
        )
      : {
          value: runtimeCost.value / completedPairs.length,
          basis: weakestBasis(runtimeCost.basis, 'observed'),
          unit: runtimeCost.unit ? `${runtimeCost.unit}/completed_item` : 'per_completed_item',
          evidenceRefs: unique([...runtimeCost.evidenceRefs, ...completedEvidence]),
          note: 'Combines runtime cost with an observed completed cohort. The observed denominator does not strengthen a configured-estimate numerator; the ratio uses the weaker basis.',
        };

  const reusedRuns = normalizedObservedIds(snapshot.reuse?.reusedWorkflowRunIds);
  const exportedSkills = normalizedObservedIds(snapshot.reuse?.exportedSkillIds);

  const groups: MetricGroup = {
    work: {
      created: observed(createdByObject.size, createdEvidence, { unit: 'items' }),
      completed: observed(completedPairs.length, completedEvidence, {
        unit: 'items',
        note: 'Only task.done closes work; task.completed is not a valid event.',
      }),
      completionRate,
      averageCycleHours,
      blockedHours: observedInput<number | null>(
        snapshot.observed?.blockedHours,
        null,
        'Blocker events have no close/unblock duration evidence.',
      ),
    },
    governance: {
      humanApprovals: approvals,
      humanInterventions,
      prFirstPassRate,
      reworkCount: observed(
        reworkEvents.length,
        [...queryEvidence, ...reworkEvents.map(eventRef)],
        {
          unit: 'recorded_observations',
          note: 'Counts later blocked PRMS observations after the first observation for each PR.',
        },
      ),
    },
    agents: {
      agentActions: observed(
        agentActions.length,
        [...queryEvidence, ...agentActions.map(eventRef)],
        {
          unit: 'actions',
          note: 'Counts successful agent-owned operator executions, not workflow runs.',
        },
      ),
      agentRuns: observed(agentRuns.length, [...queryEvidence, ...agentRuns.map(eventRef)], {
        unit: 'runs',
        note: 'Counts agent.conversation.started lifecycle events.',
      }),
      failedRuns: observed(failedRuns.length, [...queryEvidence, ...failedRuns.map(eventRef)], {
        unit: 'runs',
        note: 'Counts agent.conversation.failed lifecycle events.',
      }),
      activeAgents: observedInput(
        snapshot.observed?.activeAgents,
        0,
        'No point-in-time active-agent registry snapshot was supplied.',
      ),
    },
    economics: {
      agentRuntimeCost: runtimeCost,
      estimatedManualHours: manualHours,
      costPerCompletedItem,
    },
    reuse: {
      workflowRuns: observed(
        workflowRuns.length,
        [...queryEvidence, ...workflowRuns.map(eventRef)],
        {
          unit: 'runs',
          note: 'Counts workflow.started events in the selected period.',
        },
      ),
      workflowReuseCount:
        reusedRuns && reusedRuns.evidenceRefs.length > 0
          ? observed(reusedRuns.value.length, reusedRuns.evidenceRefs, {
              unit: 'runs',
              ...(reusedRuns.note ? { note: reusedRuns.note } : {}),
            })
          : unknown(0, 'No saved/exported workflow reuse evidence was supplied.'),
      exportedSkills:
        exportedSkills && exportedSkills.evidenceRefs.length > 0
          ? observed(exportedSkills.value.length, exportedSkills.evidenceRefs, {
              unit: 'skills',
              ...(exportedSkills.note ? { note: exportedSkills.note } : {}),
            })
          : unknown(0, 'No exported-skill evidence was supplied.'),
    },
    notifications: {
      approvalNotifications: observed(
        approvalNotifications.length,
        [...queryEvidence, ...approvalNotifications.map(eventRef)],
        {
          unit: 'direct_attempts',
          note: 'Counts direct notification.sent/failed attempts with subject approval.required.',
        },
      ),
      blockerNotifications: observed(
        blockerNotifications.length,
        [...queryEvidence, ...blockerNotifications.map(eventRef)],
        {
          unit: 'direct_attempts',
          note: 'Counts direct notification.sent/failed attempts with subject workflow.blocked.',
        },
      ),
      accepted: observedInput<number | null>(
        snapshot.observed?.notificationAccepted,
        null,
        'No durable queue/receipt acceptance evidence was supplied.',
      ),
      delivered: observedInput<number | null>(
        snapshot.observed?.notificationDelivered,
        null,
        'No authoritative remote delivery or reconciliation evidence was supplied.',
      ),
    },
  };

  const metricEntries = collectMetricEntries(groups);
  const gaps = metricEntries
    .filter(([, metric]) => metric.basis === 'unknown')
    .map(([path]) => path);
  const evidenceRefs = unique(metricEntries.flatMap(([, metric]) => metric.evidenceRefs));

  const projection: BusinessOutcomeProjection = {
    schema: 'openslack.business_outcome.v1',
    generatedAt: snapshot.generatedAt,
    period: snapshot.period,
    ...(snapshot.scenario ? { scenario: snapshot.scenario } : {}),
    ...groups,
    gaps,
    evidenceRefs,
  };
  const validation = validateBusinessOutcomeProjection(projection);
  if (!validation.valid) {
    throw new Error(`Invalid business outcome projection: ${validation.errors.join(' ')}`);
  }
  return projection;
}

function displayMetric(metric: BusinessOutcomeMetric): string {
  const value = metric.value === null ? 'unknown' : String(metric.value);
  const unit = metric.unit ? ` ${metric.unit}` : '';
  return `${value}${unit} [${metric.basis}]`;
}

function headingLabel(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

export function renderBusinessOutcomeProjection(projection: BusinessOutcomeProjection): string {
  const lines = [
    'OpenSlack Business Outcomes',
    '===========================',
    `Period: ${projection.period.from} to ${projection.period.to}`,
    `Generated: ${projection.generatedAt}`,
  ];
  if (projection.scenario) lines.push(`Scenario: ${projection.scenario}`);

  const groups: MetricGroup = {
    work: projection.work,
    governance: projection.governance,
    agents: projection.agents,
    economics: projection.economics,
    reuse: projection.reuse,
    notifications: projection.notifications,
  };
  for (const [groupName, group] of Object.entries(groups)) {
    const metrics = Object.entries(group).filter(
      ([, value]) => value && typeof value === 'object' && 'basis' in value,
    );
    if (metrics.length === 0) continue;
    lines.push('', headingLabel(groupName));
    for (const [name, metric] of metrics) {
      const typedMetric = metric as BusinessOutcomeMetric;
      lines.push(`- ${name}: ${displayMetric(typedMetric)}`);
      lines.push(
        `  Evidence: ${typedMetric.evidenceRefs.length > 0 ? typedMetric.evidenceRefs.join(', ') : 'none'}`,
      );
      if (typedMetric.note) lines.push(`  Note: ${typedMetric.note}`);
    }
  }
  lines.push('', `Evidence refs: ${projection.evidenceRefs.length}`);
  lines.push(
    projection.gaps.length > 0
      ? `Evidence gaps: ${projection.gaps.join(', ')}`
      : 'Evidence gaps: none',
  );
  return lines.join('\n');
}

export function renderBusinessOutcomeMarkdown(projection: BusinessOutcomeProjection): string {
  const lines = [
    '# OpenSlack Business Outcomes',
    '',
    `> **Period:** ${projection.period.from} to ${projection.period.to} | **Generated:** ${projection.generatedAt}`,
  ];
  if (projection.scenario) lines.push(`> **Scenario:** \`${projection.scenario}\``);

  const groups: MetricGroup = {
    work: projection.work,
    governance: projection.governance,
    agents: projection.agents,
    economics: projection.economics,
    reuse: projection.reuse,
    notifications: projection.notifications,
  };
  for (const [groupName, group] of Object.entries(groups)) {
    lines.push('', `## ${headingLabel(groupName)}`, '');
    lines.push('| Metric | Value | Basis | Evidence |', '|---|---:|---|---|');
    for (const [name, metric] of Object.entries(group)) {
      const typedMetric = metric as BusinessOutcomeMetric;
      const value = typedMetric.value === null ? 'unknown' : String(typedMetric.value);
      const unit = typedMetric.unit ? ` ${typedMetric.unit}` : '';
      const evidence =
        typedMetric.evidenceRefs.length > 0
          ? typedMetric.evidenceRefs.map((ref) => `\`${ref}\``).join('<br>')
          : 'none';
      lines.push(`| ${name} | ${value}${unit} | ${typedMetric.basis} | ${evidence} |`);
    }
  }
  lines.push('', '## Evidence gaps', '');
  if (projection.gaps.length === 0) lines.push('- None.');
  else for (const gap of projection.gaps) lines.push(`- \`${gap}\``);
  return lines.join('\n');
}

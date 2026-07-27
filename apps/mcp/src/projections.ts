import type { OpenSlackReadToolName } from '@openslack/qoder-adapter';

type Row = Record<string, unknown>;

function row(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | null | undefined {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
    ? value
    : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function texts(value: unknown, max = 100): string[] {
  return Array.isArray(value)
    ? value.slice(0, max).filter((item): item is string => typeof item === 'string')
    : [];
}

function rows(value: unknown, max = 100): Row[] {
  return Array.isArray(value) ? value.slice(0, max).map(row) : [];
}

function counts(value: unknown): Row {
  const result: Row = {};
  for (const [key, item] of Object.entries(row(value)).slice(0, 100)) {
    if (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0) result[key] = item;
  }
  return result;
}

function event(value: unknown): Row {
  const source = row(row(value).source);
  const actor = row(row(value).actor);
  const object = row(row(value).object);
  const owner = row(row(value).owner);
  const nextAction = row(row(value).nextAction);
  const item = row(value);
  return {
    id: text(item.id),
    timestamp: text(item.timestamp),
    type: text(item.type),
    actor: { id: text(actor.id), kind: text(actor.kind) },
    object: { id: text(object.id), kind: text(object.kind), url: text(object.url) },
    source: { kind: text(source.kind), ref: text(source.ref) },
    summary: text(item.summary),
    owner:
      Object.keys(owner).length > 0 ? { id: text(owner.id), kind: text(owner.kind) } : undefined,
    nextAction:
      Object.keys(nextAction).length > 0
        ? {
            owner: text(nextAction.owner),
            action: text(nextAction.action),
            url: text(nextAction.url),
          }
        : undefined,
    risk: text(item.risk),
    severity: text(item.severity),
    visibility: text(item.visibility),
    correlationId: text(item.correlationId),
    parentEventId: text(item.parentEventId),
    redacted: boolean(item.redacted),
    evidenceRef: text(item.evidenceRef),
  };
}

function handoff(value: unknown): Row {
  const item = row(value);
  return {
    id: text(item.id),
    status: text(item.status),
    from: text(item.from),
    to: text(item.to),
    createdAt: text(item.createdAt),
    issueRef: text(item.issueRef),
    prRef: text(item.prRef),
    context: text(item.context),
    nextSteps: texts(item.nextSteps, 20),
    evidenceRef: text(item.evidenceRef),
  };
}

function decision(value: unknown): Row {
  const item = row(value);
  return {
    id: text(item.id),
    status: text(item.status),
    topic: text(item.topic),
    decision: text(item.decision),
    decidedBy: text(item.decidedBy),
    createdAt: text(item.createdAt),
    tags: texts(item.tags, 20),
    evidenceRef: text(item.evidenceRef),
  };
}

function blocker(value: unknown): Row {
  const item = row(value);
  return {
    object: text(item.object),
    summary: text(item.summary),
    owner: text(item.owner),
    nextAction: text(item.nextAction),
    severity: text(item.severity),
    evidenceRef: text(item.evidenceRef),
  };
}

function module(value: unknown): Row {
  const item = row(value);
  return {
    id: text(item.id),
    name: text(item.name),
    status: text(item.status),
    maturity: text(item.maturity),
    operatorConfigured: boolean(item.operatorConfigured),
    externalBlockers: texts(item.externalBlockers, 50),
    evidenceRefs: texts(item.evidenceRefs, 50),
    phase: text(item.phase),
    cli: texts(item.cli, 100),
    packages: texts(item.packages, 100),
    notes: text(item.notes),
  };
}

function dashboard(value: unknown): Row {
  const item = row(value);
  return {
    generatedAt: text(item.generatedAt),
    sinceHours: number(item.sinceHours),
    taskCounts: counts(item.taskCounts),
    prCounts: counts(item.prCounts),
    blockerCount: number(item.blockerCount),
    blockers: rows(item.blockers, 100).map(blocker),
    openHandoffs: number(item.openHandoffs),
    activeDecisions: number(item.activeDecisions),
    recentEvents: rows(item.recentEvents, 100).map(event),
    openHandoffDetails: rows(item.openHandoffDetails, 100).map(handoff),
    activeDecisionDetails: rows(item.activeDecisionDetails, 100).map(decision),
  };
}

function workflowAgent(value: unknown): Row {
  const item = row(value);
  return {
    id: text(item.id),
    label: text(item.label),
    phase: text(item.phase),
    status: text(item.status),
    cached: boolean(item.cached),
    agentRunId: text(item.agentRunId),
    model: text(item.model),
    runtimeProvider: text(item.runtimeProvider),
    bridgeMode: text(item.bridgeMode),
    isolation: text(item.isolation),
    terminalReason: text(item.terminalReason),
    tokensUsed: number(item.tokensUsed),
    tokensRemaining: number(item.tokensRemaining),
    recentTools: rows(item.recentTools, 8).map((tool) => ({
      type: text(tool.type),
      name: text(tool.name),
      timestamp: text(tool.timestamp),
    })),
    warnings: texts(item.warnings, 20),
  };
}

function workflow(value: unknown): Row {
  const item = row(value);
  const budget = row(item.budget);
  return {
    runId: text(item.runId),
    workflowName: text(item.workflowName),
    mode: text(item.mode),
    status: text(item.status),
    startedAt: text(item.startedAt),
    updatedAt: text(item.updatedAt),
    elapsedMs: number(item.elapsedMs),
    currentPhase: text(item.currentPhase),
    phaseCount: number(item.phaseCount),
    agentCount: number(item.agentCount),
    pendingApprovalCount: number(item.pendingApprovalCount),
    budget: {
      tokenBudget: number(budget.tokenBudget),
      tokensUsed: number(budget.tokensUsed),
      tokensRemaining: number(budget.tokensRemaining),
      costEstimateUsd: number(budget.costEstimateUsd),
      costSource: text(budget.costSource),
      status: text(budget.status),
      warnings: texts(budget.warnings, 20),
      agentCalls: number(budget.agentCalls),
      maxAgents: number(budget.maxAgents),
      maxConcurrency: number(budget.maxConcurrency),
    },
    phases: rows(item.phases, 100).map((phase) => ({
      phase: text(phase.phase),
      status: text(phase.status),
      timestamp: text(phase.timestamp),
      agentCount: number(phase.agentCount),
      tokenTotal: number(phase.tokenTotal),
      cachedCount: number(phase.cachedCount),
      liveCount: number(phase.liveCount),
      failedCount: number(phase.failedCount),
      agents: rows(phase.agents, 100).map(workflowAgent),
    })),
    warnings: texts(item.warnings, 50),
    evidenceRef: text(item.evidenceRef),
  };
}

function metric(value: unknown): Row {
  const item = row(value);
  const metricValue = item.value;
  return {
    value:
      metricValue === null ||
      typeof metricValue === 'string' ||
      typeof metricValue === 'number' ||
      typeof metricValue === 'boolean'
        ? metricValue
        : undefined,
    basis: text(item.basis),
    unit: text(item.unit),
    evidenceRefs: texts(item.evidenceRefs, 50),
    note: text(item.note),
  };
}

const OUTCOME_GROUPS: Readonly<Record<string, readonly string[]>> = {
  work: ['created', 'completed', 'completionRate', 'averageCycleHours', 'blockedHours'],
  governance: ['humanApprovals', 'humanInterventions', 'prFirstPassRate', 'reworkCount'],
  agents: ['agentActions', 'agentRuns', 'failedRuns', 'activeAgents'],
  economics: ['agentRuntimeCost', 'estimatedManualHours', 'costPerCompletedItem'],
  reuse: ['workflowRuns', 'workflowReuseCount', 'exportedSkills'],
  notifications: ['approvalNotifications', 'blockerNotifications', 'accepted', 'delivered'],
};

function outcomes(value: unknown): Row {
  const item = row(value);
  const period = row(item.period);
  const result: Row = {
    schema: text(item.schema),
    generatedAt: text(item.generatedAt),
    period: { from: text(period.from), to: text(period.to) },
    scenario: text(item.scenario),
    gaps: texts(item.gaps, 100),
    evidenceRefs: texts(item.evidenceRefs, 50),
  };
  for (const [groupName, names] of Object.entries(OUTCOME_GROUPS)) {
    const group = row(item[groupName]);
    result[groupName] = Object.fromEntries(names.map((name) => [name, metric(group[name])]));
  }
  return result;
}

function notification(value: unknown): Row {
  const item = row(value);
  const config = row(item.config);
  const queue = row(item.localQueue);
  const lifecycle = row(item.lifecycle);
  const lifecycleMetric = (name: string) => {
    const value = row(lifecycle[name]);
    return {
      value: number(value.value),
      basis: text(value.basis),
      scope: text(value.scope),
      evidenceRefs: texts(value.evidenceRefs, 50),
    };
  };
  return {
    generatedAt: text(item.generatedAt),
    config: {
      valid: boolean(config.valid),
      errors: texts(config.errors, 20),
      notificationServiceConfigured: boolean(config.notificationServiceConfigured),
      routes: rows(config.routes, 100).map((route) => ({
        repository: text(route.repository),
        id: text(route.id),
        sink: text(route.sink),
        backend: text(route.backend),
      })),
    },
    localQueue: {
      status: text(queue.status),
      reason: text(queue.reason),
      count: number(queue.count),
      pending: number(queue.pending),
      processing: number(queue.processing),
      retryable: number(queue.retryable),
      accepted: number(queue.accepted),
      rejected: number(queue.rejected),
      quarantined: number(queue.quarantined),
      handoffDead: number(queue.handoffDead),
      completed: number(queue.completed),
      failed: number(queue.failed),
      legacyOwned: number(queue.legacyOwned),
      pendingReceiptLedgers: number(queue.pendingReceiptLedgers),
    },
    lifecycle: {
      accepted: lifecycleMetric('accepted'),
      delivered: lifecycleMetric('delivered'),
      remoteDelivered: lifecycleMetric('remoteDelivered'),
    },
    nonClaims: texts(item.nonClaims, 20),
    evidenceRefs: texts(item.evidenceRefs, 50),
  };
}

export function projectToolData(name: OpenSlackReadToolName, value: unknown): Row | null {
  if (value === null || value === undefined) return null;
  const item = row(value);
  switch (name) {
    case 'openslack_get_executive_overview':
      return {
        generatedAt: text(item.generatedAt),
        modules: rows(item.modules, 100).map(module),
        dashboard: dashboard(item.dashboard),
        evidenceRefs: texts(item.evidenceRefs, 50),
      };
    case 'openslack_list_work_items':
      return {
        generatedAt: text(item.generatedAt),
        freshness: text(item.freshness),
        items: rows(item.items, 100).map((work) => ({
          id: text(work.id),
          status: text(work.status),
          summary: text(work.summary),
          owner: text(work.owner),
          observedAt: text(work.observedAt),
          evidenceRef: text(work.evidenceRef),
        })),
        evidenceRefs: texts(item.evidenceRefs, 50),
      };
    case 'openslack_get_work_room':
      return {
        roomId: text(item.roomId),
        objectKind: text(item.objectKind),
        objectId: text(item.objectId),
        sourceUrl: text(item.sourceUrl),
        owner: text(item.owner),
        nextAction: text(item.nextAction),
        recentEvents: rows(item.recentEvents, 100).map(event),
        blockers: rows(item.blockers, 100).map(event),
        linkedDecisions: rows(item.linkedDecisions, 100).map(decision),
        linkedHandoffs: rows(item.linkedHandoffs, 100).map(handoff),
        evidenceRefs: texts(item.evidenceRefs, 50),
      };
    case 'openslack_get_activity':
      return {
        generatedAt: text(item.generatedAt),
        events: rows(item.events, 100).map(event),
        evidenceRefs: texts(item.evidenceRefs, 50),
      };
    case 'openslack_get_workflow_progress':
      return workflow(item);
    case 'openslack_get_pr_readiness': {
      const readiness = row(item.readiness);
      const summary = row(item.summary);
      return {
        generatedAt: text(item.generatedAt),
        headSha: text(item.headSha),
        summary: {
          prNumber: number(summary.prNumber),
          title: text(summary.title),
          decision: text(summary.decision),
          canMerge: boolean(summary.canMerge),
          blockerCategory: text(summary.blockerCategory),
          owner: text(summary.owner),
          nextAction: text(summary.nextAction),
        },
        readiness: {
          prNumber: number(readiness.prNumber),
          title: text(readiness.title),
          state: text(readiness.state),
          draft: boolean(readiness.draft),
          baseRef: text(readiness.baseRef),
          headSha: text(readiness.headSha),
          riskZone: text(readiness.riskZone),
          decision: text(readiness.decision),
          reason: text(readiness.reason),
          recommendation: text(readiness.recommendation),
          mergeable: boolean(readiness.mergeable),
          checks: rows(readiness.checks, 100).map((check) => ({
            name: text(check.name),
            status: text(check.status),
            conclusion: text(check.conclusion),
          })),
          humanApprovalCount: number(readiness.humanApprovalCount),
        },
      };
    }
    case 'openslack_list_pending_approvals':
      return {
        generatedAt: text(item.generatedAt),
        openSlackConfirmations: rows(item.openSlackConfirmations, 100).map((approval) => ({
          planId: text(approval.planId),
          actorId: text(approval.actorId),
          goal: text(approval.goal),
          risk: text(approval.risk),
          createdAt: text(approval.createdAt),
          expiresAt: text(approval.expiresAt),
          evidenceRef: text(approval.evidenceRef),
        })),
        workflowTrust: rows(item.workflowTrust, 100).map((approval) => ({
          object: text(approval.object),
          summary: text(approval.summary),
          owner: text(approval.owner),
          observedAt: text(approval.observedAt),
          evidenceRef: text(approval.evidenceRef),
        })),
        githubHumanReviews: rows(item.githubHumanReviews, 100).map((approval) => ({
          object: text(approval.object),
          requirement: text(approval.requirement),
          owner: text(approval.owner),
          observedAt: text(approval.observedAt),
          evidenceRef: text(approval.evidenceRef),
        })),
        semantics: {
          qoderPermissionIsOpenSlackConfirmation: boolean(
            row(item.semantics).qoderPermissionIsOpenSlackConfirmation,
          ),
          openSlackConfirmationIsGithubReview: boolean(
            row(item.semantics).openSlackConfirmationIsGithubReview,
          ),
        },
        evidenceRefs: texts(item.evidenceRefs, 50),
      };
    case 'openslack_get_business_outcomes':
      return outcomes(item);
    case 'openslack_get_notification_status':
      return notification(item);
    case 'openslack_list_scenarios':
      return {
        generatedAt: text(item.generatedAt),
        scenarios: rows(item.scenarios, 50).map((scenario) => ({
          id: text(scenario.id),
          version: text(scenario.version),
          title: text(scenario.title),
          description: text(scenario.description),
          definitionHash: text(scenario.definitionHash),
          projectorIds: texts(scenario.projectorIds, 20),
          viewIds: texts(scenario.viewIds, 20),
          evidenceRef: text(scenario.evidenceRef),
        })),
        evidenceRefs: texts(item.evidenceRefs, 50),
      };
    case 'openslack_query_graph':
    case 'openslack_explain_graph':
      return item;
  }
}

import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  readEvents, filterEvents, renderActivityFeed, buildDigest, renderDigest,
  createHandoff, listHandoffs, getHandoff, acceptHandoff, closeHandoff,
  renderHandoffList, renderHandoff,
  recordDecision, listDecisions, getDecision, supersedeDecision,
  renderDecisionList, renderDecision,
  buildRoomView, renderRoom, renderRoomPlain, renderRoomChat,
  previewWorkflowTemplate, executeWorkflowTemplate, renderWorkflowPreview,
  validateWorkflowTemplate,
  buildDashboardProjection, renderDashboardProjection, renderDashboardMarkdown, BLOCKER_TYPES,
  recordEvent,
} from '@openslack/collaboration';
import type { WorkflowTemplate } from '@openslack/collaboration';
import { resolveAgentPrincipal, renderFindingsPlain } from '@openslack/runtime';
import type { PlainFinding } from '@openslack/runtime';
import {
  buildDashboardCard, buildDigestCard, buildActivityCard,
  buildWorkflowCard, cardToText,
} from '@openslack/chat-gateway';
import {
  discoverJsWorkflows,
  discoverYamlTemplates,
  findWorkflow as findJsWorkflow,
  loadWorkflow,
  executePreview,
  executeDryRun,
  executeRun,
  executeResume,
  WorkflowBudgetPausedError,
  WorkflowPausedError,
  RunStore,
  checkResumable,
  prepareResume,
  renderRunHtml,
  renderRunJson,
  renderRunMarkdown,
  listWorkflowPatterns,
  getWorkflowPattern,
  renderWorkflowPattern,
  generateWorkflowDraft,
  previewWorkflowDraft,
  renderWorkflowDraftPreview,
  readWorkflowPolicy,
  writeWorkflowPolicy,
  renderWorkflowPolicy,
  listWorkflowRuns,
  showWorkflowRun,
  controlWorkflowRun,
  renderWorkflowRuns,
  renderWorkflowRun,
  getWorkflowRunProgress,
  renderWorkflowRunProgress,
  listWorkflowCatalog,
  getWorkflowCatalogEntry,
  renderWorkflowCatalogList,
  renderWorkflowCatalogEntry,
  saveWorkflow,
  saveWorkflowRunScript,
  exportWorkflowSkill,
} from '@openslack/workflows';
import { recommendWorkflowForQuery } from '@openslack/operator';
import type {
  DryRunResult,
  SimulatedEffect,
  AgentEventEmitter,
  AgentConversationEvent,
  RunStatus,
  WorkflowRunControlAction,
  WorkflowRunControlTarget,
} from '@openslack/workflows';
import {
  publishWorkflowProposal,
  publishWorkflowReviewRequest,
  publishWorkflowRunAudit,
  publishWorkflowImprovement,
  publishWorkflowSplit,
  bootstrapWorkflowLabels,
  finalizeWorkflowPR,
} from '@openslack/github';

type AgentAuthOptions = {
  principal?: import('@openslack/kernel').AgentPrincipal;
  snapshot?: import('@openslack/kernel').AgentPermissionSnapshot;
};

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'openslack.yaml'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function resolveAgentAuthOptions(agentId: string | undefined): AgentAuthOptions {
  if (!agentId) return {};
  const root = findRepoRoot();
  const resolved = resolveAgentPrincipal({ root, agentId, provider: 'cli' });
  if ('error' in resolved) {
    console.error(`Authorization failed: ${resolved.error}`);
    process.exit(1);
  }
  return { principal: resolved.principal, snapshot: resolved.snapshot };
}

/**
 * Create an AgentEventEmitter bridge that records agent conversation lifecycle
 * events into the collaboration event store. Converts the lightweight
 * AgentConversationEvent from the workflow runtime into a full CollaborationEvent
 * via recordEvent().
 */
function createCollaborationEventEmitter(): AgentEventEmitter {
  return (event: AgentConversationEvent) => {
    const severity = event.type === 'agent.conversation.failed' ? 'critical' : undefined;
    const summary = event.type === 'agent.conversation.started'
      ? `Agent ${event.agentId} started conversation in phase "${event.phase}" (run ${event.runId})`
      : event.type === 'agent.conversation.completed'
        ? `Agent ${event.agentId} completed conversation in phase "${event.phase}" (run ${event.runId})`
        : `Agent ${event.agentId} failed in phase "${event.phase}" (run ${event.runId}): ${event.error ?? 'unknown error'}`;

    recordEvent({
      type: event.type,
      actor: { id: event.agentId, kind: 'agent' },
      object: { kind: 'agent', id: event.resolvedAgentId ?? event.agentId },
      source: { kind: 'openslack', ref: event.runId },
      summary,
      visibility: 'local',
      redacted: false,
      containsSensitiveData: false,
      correlationId: event.runId,
      ...(severity ? { severity } : {}),
    });
  };
}

function parseInputs(items: string[] | undefined): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const item of items ?? []) {
    const [key, ...rest] = item.split('=');
    if (!key || rest.length === 0) continue;
    const value = rest.join('=');
    if (/^-?\d+$/.test(value)) inputs[key] = Number(value);
    else if (value === 'true' || value === 'false') inputs[key] = value === 'true';
    else inputs[key] = value;
  }
  return inputs;
}

function ensureWorkflowEnabled(action: string): void {
  const policy = readWorkflowPolicy({ rootDir: findRepoRoot() });
  if (!policy.enabled) {
    console.error(`Workflow ${action} is disabled.`);
    console.error(policy.reason ?? 'Enable workflows with: openslack collaboration workflow config enable');
    process.exit(1);
  }
}

const WORKFLOW_RUN_STATUSES = [
  'created',
  'previewed',
  'confirmed',
  'running',
  'paused',
  'paused_waiting_approval',
  'resuming',
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly RunStatus['status'][];

const WORKFLOW_RUN_CONTROL_ACTIONS = [
  'pause',
  'resume',
  'stopRun',
  'stopAgent',
  'restartAgent',
  'saveScript',
] as const satisfies readonly WorkflowRunControlAction[];

const WORKFLOW_RUN_SHOW_DETAILS = ['summary', 'progress'] as const;
const WORKFLOW_RUN_SHOW_FORMATS = ['plain', 'json'] as const;
const WORKFLOW_SAVE_TARGETS = ['project', 'user', 'claude-project'] as const;

function parseWorkflowRunStatus(value: string | undefined): RunStatus['status'] | undefined {
  if (value === undefined) return undefined;
  if ((WORKFLOW_RUN_STATUSES as readonly string[]).includes(value)) return value as RunStatus['status'];
  console.error(`Invalid workflow run status: ${value}`);
  console.error(`Allowed values: ${WORKFLOW_RUN_STATUSES.join(', ')}`);
  process.exit(1);
}

function parseWorkflowRunShowDetail(value: string | undefined): typeof WORKFLOW_RUN_SHOW_DETAILS[number] {
  const resolved = value ?? 'summary';
  if ((WORKFLOW_RUN_SHOW_DETAILS as readonly string[]).includes(resolved)) return resolved as typeof WORKFLOW_RUN_SHOW_DETAILS[number];
  console.error(`Invalid workflow run detail: ${resolved}`);
  console.error(`Allowed values: ${WORKFLOW_RUN_SHOW_DETAILS.join(', ')}`);
  process.exit(1);
}

function parseWorkflowRunShowFormat(value: string | undefined): typeof WORKFLOW_RUN_SHOW_FORMATS[number] {
  const resolved = value ?? 'plain';
  if ((WORKFLOW_RUN_SHOW_FORMATS as readonly string[]).includes(resolved)) return resolved as typeof WORKFLOW_RUN_SHOW_FORMATS[number];
  console.error(`Invalid workflow run format: ${resolved}`);
  console.error(`Allowed values: ${WORKFLOW_RUN_SHOW_FORMATS.join(', ')}`);
  process.exit(1);
}

function parseWorkflowRunControlAction(value: string): WorkflowRunControlAction {
  if ((WORKFLOW_RUN_CONTROL_ACTIONS as readonly string[]).includes(value)) return value as WorkflowRunControlAction;
  console.error(`Invalid workflow run control action: ${value}`);
  console.error(`Allowed values: ${WORKFLOW_RUN_CONTROL_ACTIONS.join(', ')}`);
  process.exit(1);
}

function parseWorkflowSaveTarget(value: string): typeof WORKFLOW_SAVE_TARGETS[number] {
  if ((WORKFLOW_SAVE_TARGETS as readonly string[]).includes(value)) return value as typeof WORKFLOW_SAVE_TARGETS[number];
  console.error(`--to must be one of: ${WORKFLOW_SAVE_TARGETS.join(', ')}`);
  process.exit(1);
}

async function markRunFailedIfActive(store: RunStore, runId: string): Promise<void> {
  try {
    const status = await store.loadStatus(runId);
    if (status?.status === 'running' || status?.status === 'resuming') {
      await store.transitionStatus(runId, 'failed');
    }
  } catch {
    // executeResume owns the primary state transition. This fallback must not
    // mask the original resume error reported to the operator.
  }
}

function resolveBuiltinTemplatePath(id: string): string | undefined {
  const builtinPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'templates', 'workflows', `${id}.yaml`);
  return existsSync(builtinPath) ? builtinPath : undefined;
}

function loadWorkflowTemplate(pathOrId: string): WorkflowTemplate {
  const builtinPath = resolveBuiltinTemplatePath(pathOrId);
  const resolvedPath = builtinPath ?? pathOrId;
  return parseYaml(readFileSync(resolvedPath, 'utf-8')) as WorkflowTemplate;
}

interface BuiltinTemplateSummary {
  id: string;
  name: string;
  phases: number;
  inputs: number;
  file: string;
}

function listBuiltinTemplates(): BuiltinTemplateSummary[] {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'templates', 'workflows');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  const templates: BuiltinTemplateSummary[] = [];
  for (const file of files) {
    const template = parseYaml(readFileSync(join(dir, file), 'utf-8')) as WorkflowTemplate;
    const errors = validateWorkflowTemplate(template);
    if (errors.length > 0) continue;
    templates.push({
      id: template.id,
      name: template.name,
      phases: template.phases.length,
      inputs: (template.inputs ?? []).length,
      file,
    });
  }
  return templates;
}

export function collaborationCommands(): Command {
  const cmd = new Command('collaboration').description('OpenSlack Collaboration Layer');

  cmd
    .command('dashboard')
    .description('Show projection-only team dashboard')
    .option('--since <hours>', 'Window in hours; use 0 for all events', '24')
    .option('--owner <actorId>', 'Filter by actor ID')
    .option('--module <sourceKind>', 'Filter by source module (operator, prms, github, chat, governance)')
    .option('--risk <level>', 'Filter by risk level (none, low, medium, high)')
    .option('--blocker', 'Show only blocker events')
    .option('--type <eventType>', 'Filter by event type')
    .option('--format <format>', 'Output format: standard, plain, json, chat, markdown, or tui', 'standard')
    .action(async (options: { since: string; owner?: string; module?: string; risk?: string; blocker?: boolean; type?: string; format: string }) => {
      const sinceHours = parseInt(options.since, 10);
      const filters: Record<string, unknown> = {};
      if (options.owner) filters.actorId = options.owner;
      if (options.module) filters.sourceKind = options.module;
      if (options.risk) filters.risk = options.risk;
      if (options.type) filters.type = options.type;
      if (options.blocker) filters.type = [...BLOCKER_TYPES];
      const dashboard = buildDashboardProjection({
        sinceHours: Number.isFinite(sinceHours) ? sinceHours : 24,
        filters: Object.keys(filters).length > 0 ? filters : undefined,
      });
      if (options.format === 'tui') {
        try {
          const { renderDashboardTui } = await import('@openslack/tui');
          await renderDashboardTui(dashboard);
        } catch (error) {
          console.error('TUI unavailable. Falling back to standard output.');
          console.log(renderDashboardProjection(dashboard));
        }
      } else if (options.format === 'json') {
        console.log(JSON.stringify(dashboard, null, 2));
      } else if (options.format === 'chat') {
        const card = buildDashboardCard({
          sinceHours: dashboard.sinceHours,
          blockerCount: dashboard.blockerCount,
          openHandoffs: dashboard.openHandoffs,
          activeDecisions: dashboard.activeDecisions,
          blockers: dashboard.blockers.map((b) => ({ object: b.object, summary: b.summary, owner: b.owner })),
        });
        console.log(cardToText(card));
      } else if (options.format === 'plain') {
        const findings: PlainFinding[] = [];
        for (const b of dashboard.blockers) {
          findings.push({ status: 'FAIL', title: `Blocker: ${b.object}`, detail: b.summary, nextAction: b.nextAction });
        }
        for (const [type, count] of Object.entries(dashboard.taskCounts)) {
          findings.push({ status: 'informational', title: `Task: ${type}`, detail: `${count} event(s)` });
        }
        for (const [type, count] of Object.entries(dashboard.prCounts)) {
          findings.push({ status: 'informational', title: `PR: ${type}`, detail: `${count} event(s)` });
        }
        if (dashboard.openHandoffs > 0) findings.push({ status: 'informational', title: 'Open handoffs', detail: `${dashboard.openHandoffs} open` });
        if (dashboard.activeDecisions > 0) findings.push({ status: 'informational', title: 'Active decisions', detail: `${dashboard.activeDecisions} active` });
        if (dashboard.blockerCount === 0) findings.push({ status: 'PASS', title: 'No blockers', detail: `No blockers in the last ${dashboard.sinceHours}h` });
        console.log(renderFindingsPlain(findings));
      } else if (options.format === 'markdown') {
        console.log(renderDashboardMarkdown(dashboard));
      } else {
        console.log(renderDashboardProjection(dashboard));
      }
    });

  cmd
    .command('activity')
    .description('Show collaboration activity feed')
    .option('--since <hours>', 'Filter events from last N hours', '24')
    .option('--object <ref>', 'Filter by object (e.g., pr:42, issue:21)')
    .option('--actor <id>', 'Filter by actor ID')
    .option('--type <type>', 'Filter by event type')
    .option('--format <format>', 'Output format: standard, plain, json, or chat', 'standard')
    .action(async (options: { since: string; object?: string; actor?: string; type?: string; format: string }) => {
      const hours = parseInt(options.since, 10);
      const events = readEvents();

      let filtered = events;

      if (hours > 0) {
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
        filtered = filterEvents(filtered, { since: cutoff });
      }

      if (options.object) {
        const [kind, id] = options.object.split(':');
        if (kind && id) {
          filtered = filterEvents(filtered, { objectKind: kind as never, objectId: id });
        } else {
          filtered = filterEvents(filtered, { objectId: options.object });
        }
      }

      if (options.actor) {
        filtered = filterEvents(filtered, { actorId: options.actor });
      }

      if (options.type) {
        filtered = filterEvents(filtered, { type: options.type as never });
      }

      if (options.format === 'json') {
        console.log(JSON.stringify(filtered, null, 2));
      } else if (options.format === 'chat') {
        const card = buildActivityCard({
          eventCount: filtered.length,
          sinceHours: hours,
          events: filtered.map((e) => ({ type: e.type, object: `${e.object.kind}:${e.object.id}`, summary: e.summary })),
        });
        console.log(cardToText(card));
      } else if (options.format === 'plain') {
        const findings: PlainFinding[] = filtered.map((event) => {
          let status: PlainFinding['status'] = 'informational';
          if (BLOCKER_TYPES.has(event.type)) status = 'FAIL';
          else if (event.nextAction?.owner === 'human') status = 'requires_human_approval';
          return { status, title: `${event.type} (${event.object.kind}:${event.object.id})`, detail: event.summary, nextAction: event.nextAction?.action };
        });
        console.log(renderFindingsPlain(findings));
      } else if (options.format === 'tui') {
        try {
          const { renderActivityTui } = await import('@openslack/tui');
          await renderActivityTui(filtered, { periodHours: hours });
        } catch (error) {
          console.error('TUI unavailable. Falling back to standard output.');
          console.log(renderActivityFeed(filtered));
        }
      } else {
        console.log(renderActivityFeed(filtered));
      }
    });

  cmd
    .command('digest')
    .description('Show collaboration digest (grouped summary)')
    .option('--since <hours>', 'Period in hours', '24')
    .option('--format <format>', 'Output format: standard, plain, json, or chat', 'standard')
    .option('--post <target>', 'Post digest to external target (e.g., slack)', undefined)
    .option('--channel <channelId>', 'Slack channel ID for --post slack', undefined)
    .action(async (options: { since: string; format: string; post?: string; channel?: string }) => {
      const hours = parseInt(options.since, 10);
      const events = readEvents();

      let filtered = events;
      if (hours > 0) {
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
        filtered = filterEvents(filtered, { since: cutoff });
      }

      const digest = buildDigest(filtered, hours);

      // Render to text first (used for --post slack fallback and stdout)
      const digestCard = buildDigestCard({
        sinceHours: digest.periodHours,
        totalEvents: digest.totalEvents,
        groups: digest.groups.map((g) => ({ label: g.label, count: g.events.length, items: g.events.map((e) => e.summary) })),
      });

      // Post to Slack if requested
      if (options.post === 'slack') {
        const channelId = options.channel ?? process.env.SLACK_DIGEST_CHANNEL;
        if (!channelId) {
          console.error('Slack channel ID required. Use --channel or set SLACK_DIGEST_CHANNEL env var.');
          process.exit(1);
        }
        const botToken = process.env.SLACK_BOT_TOKEN;
        if (!botToken) {
          console.error('Slack bot token required. Set SLACK_BOT_TOKEN env var.');
          process.exit(1);
        }
        try {
          const { SlackAdapter } = await import('@openslack/chat-gateway');
          const adapter = new SlackAdapter({ port: 0, signingSecret: '', botToken });
          const text = cardToText(digestCard);
          await adapter.send(channelId, { text });
          console.log(`Digest posted to Slack channel ${channelId}`);
        } catch (err) {
          console.error(`Failed to post digest to Slack: ${(err as Error).message}`);
          process.exit(1);
        }
        return;
      }

      if (options.format === 'json') {
        console.log(JSON.stringify(digest, null, 2));
      } else if (options.format === 'chat') {
        console.log(cardToText(digestCard));
      } else if (options.format === 'plain') {
        const groupStatusMap: Record<string, PlainFinding['status']> = {
          'Needs Human': 'requires_human_approval',
          'Blocked': 'FAIL',
          'Completed': 'PASS',
          'Agent Activity': 'informational',
          'Governance': 'informational',
        };
        const findings: PlainFinding[] = [];
        for (const group of digest.groups) {
          const status = groupStatusMap[group.label] ?? 'informational';
          for (const event of group.events) {
            findings.push({ status, title: `${group.label}: ${event.type}`, detail: event.summary, nextAction: event.nextAction?.action });
          }
        }
        for (const event of digest.recommendedNext) {
          findings.push({ status: 'fixable_by_command', title: `Next: ${event.object.kind}:${event.object.id}`, detail: event.summary, nextAction: event.nextAction?.action });
        }
        console.log(renderFindingsPlain(findings));
      } else if (options.format === 'tui') {
        try {
          const { renderDigestTui } = await import('@openslack/tui');
          await renderDigestTui(digest);
        } catch (error) {
          console.error('TUI unavailable. Falling back to standard output.');
          console.log(renderDigest(digest));
        }
      } else {
        console.log(renderDigest(digest));
      }
    });

  const handoff = new Command('handoff').description('Collaboration handoffs');

  handoff
    .command('create')
    .description('Create a new handoff')
    .requiredOption('--from <agent>', 'Source agent')
    .requiredOption('--to <agent>', 'Target agent')
    .option('--issue <number>', 'Linked issue number')
    .option('--pr <number>', 'Linked PR number')
    .requiredOption('--context <text>', 'Handoff context')
    .option('--steps <steps>', 'Comma-separated next steps')
    .option('--notes <text>', 'Additional notes')
    .action((options: {
      from: string;
      to: string;
      issue?: string;
      pr?: string;
      context: string;
      steps?: string;
      notes?: string;
    }) => {
      const handoff = createHandoff({
        from: options.from,
        to: options.to,
        issueRef: options.issue,
        prRef: options.pr,
        context: options.context,
        nextSteps: options.steps ? options.steps.split(',').map((s) => s.trim()) : [],
        notes: options.notes,
      });
      console.log(`Created handoff: ${handoff.id}`);
      console.log(`Status: ${handoff.status}`);
      console.log(`From: ${handoff.from} → To: ${handoff.to}`);
    });

  handoff
    .command('list')
    .description('List all handoffs')
    .option('--format <format>', 'Output format: standard, plain, json, or tui', 'standard')
    .action(async (options: { format: string }) => {
      const handoffs = listHandoffs();
      if (options.format === 'json') {
        console.log(JSON.stringify(handoffs, null, 2));
      } else if (options.format === 'tui') {
        try {
          const { renderHandoffListTui } = await import('@openslack/tui');
          await renderHandoffListTui(handoffs);
        } catch (error) {
          console.error('TUI unavailable. Falling back to standard output.');
          console.log(renderHandoffList(handoffs));
        }
      } else {
        console.log(renderHandoffList(handoffs));
      }
    });

  handoff
    .command('show <id>')
    .description('Show a specific handoff')
    .option('--format <format>', 'Output format: standard, plain, json, or tui', 'standard')
    .action(async (id: string, options: { format: string }) => {
      const h = getHandoff(id);
      if (!h) {
        console.log(`Handoff ${id} not found.`);
        process.exit(1);
      }
      if (options.format === 'json') {
        console.log(JSON.stringify(h, null, 2));
      } else if (options.format === 'tui') {
        try {
          const { renderHandoffDetailTui } = await import('@openslack/tui');
          await renderHandoffDetailTui(h);
        } catch (error) {
          console.error('TUI unavailable. Falling back to standard output.');
          console.log(renderHandoff(h));
        }
      } else {
        console.log(renderHandoff(h));
      }
    });

  handoff
    .command('accept <id>')
    .description('Accept a handoff')
    .action((id: string) => {
      const h = acceptHandoff(id);
      if (!h) {
        console.log(`Handoff ${id} not found or not in open status.`);
        process.exit(1);
      }
      console.log(`Handoff ${id} accepted.`);
    });

  handoff
    .command('close <id>')
    .description('Close a handoff')
    .action((id: string) => {
      const h = closeHandoff(id);
      if (!h) {
        console.log(`Handoff ${id} not found or already closed.`);
        process.exit(1);
      }
      console.log(`Handoff ${id} closed.`);
    });

  cmd.addCommand(handoff);

  const decision = new Command('decision').description('Collaboration decision records');

  decision
    .command('record')
    .description('Record a new decision')
    .requiredOption('--topic <text>', 'Decision topic')
    .requiredOption('--decision <text>', 'The decision made')
    .requiredOption('--rationale <text>', 'Why this decision was made')
    .requiredOption('--by <agent>', 'Who made the decision')
    .option('--alternatives <items>', 'Comma-separated alternatives considered')
    .option('--consequences <items>', 'Comma-separated consequences')
    .option('--tags <items>', 'Comma-separated tags')
    .action((options: {
      topic: string;
      decision: string;
      rationale: string;
      by: string;
      alternatives?: string;
      consequences?: string;
      tags?: string;
    }) => {
      const d = recordDecision({
        topic: options.topic,
        decision: options.decision,
        rationale: options.rationale,
        decidedBy: options.by,
        alternatives: options.alternatives ? options.alternatives.split(',').map((s) => s.trim()) : [],
        consequences: options.consequences ? options.consequences.split(',').map((s) => s.trim()) : [],
        tags: options.tags ? options.tags.split(',').map((s) => s.trim()) : [],
      });
      console.log(`Recorded decision: ${d.id}`);
      console.log(`Topic: ${d.topic}`);
      console.log(`Status: ${d.status}`);
    });

  decision
    .command('list')
    .description('List all decisions')
    .option('--format <format>', 'Output format: standard, plain, json, or tui', 'standard')
    .action(async (options: { format: string }) => {
      const decisions = listDecisions();
      if (options.format === 'json') {
        console.log(JSON.stringify(decisions, null, 2));
      } else if (options.format === 'tui') {
        try {
          const { renderDecisionListTui } = await import('@openslack/tui');
          await renderDecisionListTui(decisions);
        } catch (error) {
          console.error('TUI unavailable. Falling back to standard output.');
          console.log(renderDecisionList(decisions));
        }
      } else {
        console.log(renderDecisionList(decisions));
      }
    });

  decision
    .command('show <id>')
    .description('Show a specific decision')
    .option('--format <format>', 'Output format: standard, plain, json, or tui', 'standard')
    .action(async (id: string, options: { format: string }) => {
      const d = getDecision(id);
      if (!d) {
        console.log(`Decision ${id} not found.`);
        process.exit(1);
      }
      if (options.format === 'json') {
        console.log(JSON.stringify(d, null, 2));
      } else if (options.format === 'tui') {
        try {
          const { renderDecisionDetailTui } = await import('@openslack/tui');
          await renderDecisionDetailTui(d);
        } catch (error) {
          console.error('TUI unavailable. Falling back to standard output.');
          console.log(renderDecision(d));
        }
      } else {
        console.log(renderDecision(d));
      }
    });

  decision
    .command('supersede <id>')
    .description('Supersede a decision with a new one')
    .requiredOption('--by <id>', 'New decision ID that supersedes this one')
    .action((id: string, options: { by: string }) => {
      const d = supersedeDecision(id, options.by);
      if (!d) {
        console.log(`Decision ${id} not found or not active.`);
        process.exit(1);
      }
      console.log(`Decision ${id} superseded by ${options.by}.`);
    });

  cmd.addCommand(decision);

  const room = new Command('room').description('Collaboration room views');

  room
    .command('show <roomId>')
    .description('Show room summary (e.g., pr:42, issue:21, module:operator)')
    .option('--format <format>', 'Output format: standard, plain, json, chat, or tui', 'standard')
    .action(async (roomId: string, options: { format: string }) => {
      const events = readEvents();
      const view = buildRoomView(roomId, events);
      if (!view) {
        console.log(`Invalid room ID: ${roomId}. Use format: pr:42, issue:21, module:operator`);
        process.exit(1);
      }
      if (options.format === 'tui') {
        try {
          const { renderRoomTui } = await import('@openslack/tui');
          await renderRoomTui(view);
        } catch (error) {
          console.error('TUI unavailable. Falling back to standard output.');
          console.log(renderRoom(view));
        }
      } else if (options.format === 'json') {
        console.log(JSON.stringify(view, null, 2));
      } else if (options.format === 'chat') {
        console.log(renderRoomChat(view));
      } else if (options.format === 'plain') {
        console.log(renderRoomPlain(view));
      } else {
        console.log(renderRoom(view));
      }
    });

  cmd.addCommand(room);

  const workflow = new Command('workflow').description('Collaboration workflow templates');

  workflow
    .command('preview <file>')
    .description('Preview a workflow template without executing it')
    .option('--input <key=value>', 'Template input value', (value, previous: string[]) => [...previous, value], [])
    .option('--format <format>', 'Output format: standard, plain, json, chat, or tui', 'standard')
    .action(async (file: string, options: { input: string[]; format: string }) => {
      const template = loadWorkflowTemplate(file);
      const preview = previewWorkflowTemplate(template, parseInputs(options.input));
      if (options.format === 'tui') {
        try {
          const { renderWorkflowPreviewTui } = await import('@openslack/tui');
          await renderWorkflowPreviewTui(preview);
        } catch (error) {
          console.error('TUI unavailable. Falling back to standard output.');
          console.log(renderWorkflowPreview(preview));
        }
      } else if (options.format === 'json') {
        console.log(JSON.stringify(preview, null, 2));
      } else if (options.format === 'chat') {
        const card = buildWorkflowCard(preview);
        console.log(cardToText(card));
      } else {
        console.log(renderWorkflowPreview(preview));
      }
      if (preview.errors.length > 0) process.exit(1);
    });

  workflow
    .command('execute <file>')
    .description('Execute a workflow template after validation')
    .option('--input <key=value>', 'Template input value', (value, previous: string[]) => [...previous, value], [])
    .option('--dry-run', 'Validate and execute registered actions in dry-run mode')
    .option('--agent-id <id>', 'Agent ID for authorization')
    .action(async (file: string, options: { input: string[]; dryRun?: boolean; agentId?: string }) => {
      ensureWorkflowEnabled('execution');
      const template = loadWorkflowTemplate(file);
      const result = await executeWorkflowTemplate(template, parseInputs(options.input), {
        dryRun: options.dryRun,
        ...resolveAgentAuthOptions(options.agentId),
      });
      console.log(renderWorkflowPreview(result.preview));
      console.log('');
      console.log(`Status: ${result.status}`);
      console.log(`Correlation: ${result.correlationId}`);
      if (result.errors.length > 0) {
        for (const error of result.errors) console.log(`Error: ${error}`);
        process.exit(1);
      }
    });

  workflow
    .command('list')
    .description('List all available workflows (YAML templates and JS modules)')
    .action(async () => {
      // Gather YAML templates
      const yamlDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'templates', 'workflows');
      const yamlWorkflows = await discoverYamlTemplates(yamlDir);

      // Gather JS/TS workflow modules
      const root = findRepoRoot();
      const jsWorkflows = await discoverJsWorkflows(root);

      if (yamlWorkflows.length === 0 && jsWorkflows.length === 0) {
        console.log('No workflows found.');
        return;
      }

      // Render YAML templates section
      if (yamlWorkflows.length > 0) {
        console.log('YAML Templates:');
        console.log('| ID | Name | Phases | Inputs | File |');
        console.log('|----|------|---------|--------|------|');
        for (const t of yamlWorkflows) {
          console.log(`| ${t.name} | ${t.displayName} | ${t.phases} | ${t.inputs} | ${t.file} |`);
        }
        console.log('');
      }

      // Render JS modules section
      if (jsWorkflows.length > 0) {
        console.log('JS/TS Modules:');
        console.log('| Name | Display Name | Phases | Inputs | File | Description |');
        console.log('|------|-------------|--------|--------|------|-------------|');
        for (const m of jsWorkflows) {
          const desc = m.description ?? '-';
          console.log(`| ${m.name} | ${m.displayName} | ${m.phases} | ${m.inputs} | ${m.file} | ${desc} |`);
        }
        console.log('');
      }

      console.log('Use: openslack collaboration workflow preview <id> --input key=value');
      console.log('     openslack collaboration workflow validate <name>');
      console.log('     openslack collaboration workflow show <name>');
    });

  const patterns = new Command('patterns').description('List or inspect dynamic workflow patterns');

  patterns
    .command('list')
    .description('List dynamic workflow patterns')
    .action(() => {
      const items = listWorkflowPatterns();
      console.log('| Pattern | Risk | Description |');
      console.log('|---------|------|-------------|');
      for (const pattern of items) {
        console.log(`| ${pattern.id} | ${pattern.defaultRisk} | ${pattern.description} |`);
      }
    });

  patterns
    .command('show <pattern>')
    .description('Show a dynamic workflow pattern')
    .action((patternId: string) => {
      const pattern = getWorkflowPattern(patternId);
      if (!pattern) {
        console.error(`Unknown workflow pattern: ${patternId}`);
        process.exit(1);
      }
      console.log(renderWorkflowPattern(pattern));
    });

  workflow.addCommand(patterns);

  const catalog = new Command('catalog').description('List or preview workflow use-case catalog entries');

  catalog
    .command('list')
    .description('List Dynamic Workflow catalog entries')
    .action(() => {
      console.log(renderWorkflowCatalogList(listWorkflowCatalog()));
    });

  catalog
    .command('show <id>')
    .description('Show a workflow catalog entry')
    .action((id: string) => {
      const entry = getWorkflowCatalogEntry(id);
      if (!entry) {
        console.error(`Unknown workflow catalog entry: ${id}`);
        process.exit(1);
      }
      console.log(renderWorkflowCatalogEntry(entry));
    });

  catalog
    .command('preview <id>')
    .description('Preview a catalog entry as a workflow draft plan without writing a draft')
    .action((id: string) => {
      const entry = getWorkflowCatalogEntry(id);
      if (!entry) {
        console.error(`Unknown workflow catalog entry: ${id}`);
        process.exit(1);
      }
      const pattern = getWorkflowPattern(entry.pattern);
      if (!pattern) {
        console.error(`Catalog entry ${id} references unknown pattern: ${entry.pattern}`);
        process.exit(1);
      }
      console.log(renderWorkflowCatalogEntry(entry));
      console.log('');
      console.log('Draft preview:')
      console.log(`  Pattern: ${pattern.id}`);
      console.log(`  Budget: 100000 tokens, max agents ${pattern.id === 'loop-until-done' ? 100 : 1000}, concurrency 16`);
      console.log('  Phases:');
      for (const phase of pattern.phases) console.log(`    - ${phase.title}: ${phase.detail}`);
      console.log('');
      console.log(`Generate: openslack collaboration workflow generate --pattern ${entry.pattern} --prompt "${entry.prompt.replace(/"/g, '\\"')}"`);
    });

  workflow.addCommand(catalog);

  workflow
    .command('start')
    .description('Start the Dynamic Workflow path from a prompt, pattern, or saved workflow')
    .option('--prompt <text>', 'Task prompt to evaluate and draft')
    .option('--pattern <pattern>', 'Pattern id to draft from')
    .option('--saved <name>', 'Saved workflow name to preview next')
    .action(async (options: { prompt?: string; pattern?: string; saved?: string }) => {
      ensureWorkflowEnabled('start');
      const selected = [options.prompt, options.pattern, options.saved].filter(Boolean).length;
      if (selected !== 1 && !(options.prompt && options.pattern && !options.saved)) {
        console.error('Use exactly one start path: --prompt, --pattern, or --saved. You may combine --prompt with --pattern.');
        process.exit(1);
      }
      try {
        if (options.saved) {
          const found = await findJsWorkflow(options.saved);
          if (!found) {
            console.error(`Saved workflow not found: ${options.saved}`);
            process.exit(1);
          }
          const mod = await loadWorkflow(found.path);
          console.log('Dynamic Workflow start: saved workflow');
          console.log(`Workflow: ${mod.meta.name}`);
          console.log(`Risk: ${mod.meta.risk ?? 'not recorded'}`);
          console.log(`Pattern: ${mod.meta.dynamicPattern ?? 'not recorded'}`);
          console.log(`Budget: ${mod.meta.budgetPolicy?.tokenBudget ?? 'unlimited'} tokens`);
          console.log('');
          console.log(`Preview: openslack collaboration workflow preview-js ${mod.meta.name}`);
          console.log(`Dry-run: openslack collaboration workflow dry-run ${mod.meta.name}`);
          console.log(`Run: openslack collaboration workflow run ${mod.meta.name}`);
          return;
        }

        const prompt = options.prompt ?? `use a workflow for ${options.pattern}`;
        const recommendation = recommendWorkflowForQuery(prompt, { allowDraft: true });
        const pattern = options.pattern ?? recommendation.suggestedPattern;
        console.log('Dynamic Workflow start: recommendation');
        console.log(`Decision: ${recommendation.decision}`);
        console.log(`Reason: ${recommendation.reason}`);
        console.log(`Confidence: ${recommendation.confidence}`);
        console.log(`Pattern: ${pattern ?? 'fanout-synthesize'}`);
        console.log(`Risk: ${recommendation.risk}`);
        console.log('Budget: draft defaults apply; review preview before any run.');
        console.log('');

        const draft = await generateWorkflowDraft({
          prompt,
          pattern,
          rootDir: findRepoRoot(),
        });
        const preview = await previewWorkflowDraft({ draftIdOrPath: draft.path, rootDir: findRepoRoot() });
        console.log(renderWorkflowDraftPreview(preview));
        console.log('');
        console.log(`Next: openslack collaboration workflow preview-draft ${draft.draftId}`);
      } catch (err) {
        console.error(`Workflow start failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  workflow
    .command('generate')
    .description('Generate a dynamic workflow draft without executing it')
    .option('--prompt <text>', 'Task prompt for the dynamic workflow')
    .option('--pattern <pattern>', 'Pattern id, such as fanout-synthesize or tournament')
    .option('--input <key=value>', 'Draft input hint', (value, previous: string[]) => [...previous, value], [])
    .action(async (options: { prompt?: string; pattern?: string; input: string[] }) => {
      ensureWorkflowEnabled('generation');
      if (!options.prompt) {
        console.error('Workflow draft generation requires --prompt.');
        process.exit(1);
      }
      try {
        const draft = await generateWorkflowDraft({
          prompt: options.prompt,
          pattern: options.pattern,
          inputs: parseInputs(options.input),
          rootDir: findRepoRoot(),
        });
        const preview = await previewWorkflowDraft({ draftIdOrPath: draft.path, rootDir: findRepoRoot() });
        console.log('Dynamic workflow draft created.');
        console.log(renderWorkflowDraftPreview(preview));
        console.log('');
        console.log(`Preview with: openslack collaboration workflow preview-draft ${draft.draftId}`);
      } catch (err) {
        console.error(`Workflow draft generation failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  workflow
    .command('preview-draft <draftIdOrPath>')
    .description('Preview a generated dynamic workflow draft')
    .action(async (draftIdOrPath: string) => {
      try {
        const preview = await previewWorkflowDraft({ draftIdOrPath, rootDir: findRepoRoot() });
        console.log(renderWorkflowDraftPreview(preview));
      } catch (err) {
        console.error(`Workflow draft preview failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  const runs = new Command('runs').description('Inspect and control workflow runs');

  runs
    .command('list')
    .description('List workflow runs')
    .option('--status <status>', 'Filter by run status')
    .action(async (options: { status?: string }) => {
      const result = await listWorkflowRuns({ rootDir: findRepoRoot(), status: parseWorkflowRunStatus(options.status) });
      console.log(renderWorkflowRuns(result));
    });

  runs
    .command('show <runId>')
    .description('Show workflow run detail')
    .option('--detail <detail>', 'summary or progress', 'summary')
    .option('--format <format>', 'plain or json', 'plain')
    .action(async (runId: string, options: { detail?: string; format?: string }) => {
      const detail = parseWorkflowRunShowDetail(options.detail);
      const format = parseWorkflowRunShowFormat(options.format);
      if (detail === 'progress') {
        const progress = await getWorkflowRunProgress(runId, { rootDir: findRepoRoot() });
        if (!progress) {
          console.error(`Workflow run not found: ${runId}`);
          process.exit(1);
        }
        console.log(format === 'json' ? JSON.stringify(progress, null, 2) : renderWorkflowRunProgress(progress));
        return;
      }
      const run = await showWorkflowRun(runId, { rootDir: findRepoRoot() });
      if (!run) {
        console.error(`Workflow run not found: ${runId}`);
        process.exit(1);
      }
      console.log(format === 'json' ? JSON.stringify(run, null, 2) : renderWorkflowRun(run));
    });

  runs
    .command('control <runId>')
    .description('Record a workflow run control action')
    .requiredOption('--action <action>', 'pause, resume, stopRun, stopAgent, restartAgent, or saveScript')
    .option('--agent-run-id <id>', 'Target AgentRun ID for stopAgent/restartAgent')
    .option('--phase <phase>', 'Target workflow phase for agent-level controls')
    .option('--agent <agent>', 'Target workflow agent label/type for agent-level controls')
    .action(async (runId: string, options: { action: string; agentRunId?: string; phase?: string; agent?: string }) => {
      const action = parseWorkflowRunControlAction(options.action);
      const target: WorkflowRunControlTarget | undefined =
        options.agentRunId || options.phase || options.agent
          ? {
              runId,
              agentRunId: options.agentRunId,
              phase: options.phase,
              agentId: options.agent,
            }
          : undefined;
      const result = await controlWorkflowRun(runId, action, { rootDir: findRepoRoot(), target });
      console.log(result.message);
      if (result.status === 'rejected') process.exit(1);
    });

  workflow.addCommand(runs);

  const config = new Command('config').description('Show or change workflow policy');

  config
    .command('show')
    .description('Show workflow policy')
    .action(() => {
      console.log(renderWorkflowPolicy(readWorkflowPolicy({ rootDir: findRepoRoot() })));
    });

  config
    .command('enable')
    .description('Enable workflow generation and execution')
    .option('--ultracode', 'Also enable ultracode workflow draft triggers')
    .action((options: { ultracode?: boolean }) => {
      console.log(renderWorkflowPolicy(writeWorkflowPolicy({ enabled: true, ...(options.ultracode ? { ultracode: true } : {}) }, { rootDir: findRepoRoot() })));
    });

  config
    .command('disable')
    .description('Disable workflow generation and execution')
    .action(() => {
      console.log(renderWorkflowPolicy(writeWorkflowPolicy({ enabled: false, reason: 'disabled by operator command' }, { rootDir: findRepoRoot() })));
    });

  workflow.addCommand(config);

  workflow
    .command('save <name>')
    .description('Save a reusable workflow to project or user workflow storage')
    .requiredOption('--to <target>', 'project, user, or claude-project')
    .action(async (name: string, options: { to: string }) => {
      const target = parseWorkflowSaveTarget(options.to);
      try {
        const result = await saveWorkflow(name, { rootDir: findRepoRoot(), to: target });
        console.log(`Saved workflow "${result.workflowName}" to ${result.source}.`);
        console.log(`Path: ${result.path}`);
        console.log(`Hash: ${result.scriptHash}`);
      } catch (err) {
        console.error(`Workflow save failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  workflow
    .command('save-run <runId>')
    .description('Save the workflow script associated with a recorded run')
    .requiredOption('--to <target>', 'project, user, or claude-project')
    .action(async (runId: string, options: { to: string }) => {
      const target = parseWorkflowSaveTarget(options.to);
      try {
        const result = await saveWorkflowRunScript(runId, { rootDir: findRepoRoot(), to: target });
        console.log(`Saved workflow "${result.workflowName}" from run ${runId} to ${result.source}.`);
        console.log(`Source: ${result.sourcePath}`);
        console.log(`Path: ${result.path}`);
        console.log(`Hash: ${result.scriptHash}`);
      } catch (err) {
        console.error(`Workflow save-run failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  workflow
    .command('export-skill <name>')
    .description('Export a workflow as a skill-style package')
    .requiredOption('--out <path>', 'Output skill directory')
    .action(async (name: string, options: { out: string }) => {
      try {
        const result = await exportWorkflowSkill(name, { rootDir: findRepoRoot(), outDir: options.out });
        console.log(`Exported workflow "${result.workflowName}" as a skill package.`);
        console.log(`Skill: ${result.skillPath}`);
        console.log(`Workflow: ${result.workflowPath}`);
      } catch (err) {
        console.error(`Workflow skill export failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  workflow
    .command('validate <name>')
    .description('Validate a workflow template or JS module by name')
    .action(async (name: string) => {
      // Try YAML template first
      const builtinPath = resolveBuiltinTemplatePath(name);
      if (builtinPath) {
        const template = parseYaml(readFileSync(builtinPath, 'utf-8')) as WorkflowTemplate;
        const errors = validateWorkflowTemplate(template);
        if (errors.length === 0) {
          console.log(`Workflow template "${name}" is valid.`);
          console.log(`  Schema: ${template.schema}`);
          console.log(`  ID: ${template.id}`);
          console.log(`  Name: ${template.name}`);
          console.log(`  Phases: ${template.phases.length}`);
          console.log(`  Inputs: ${(template.inputs ?? []).length}`);
        } else {
          console.log(`Workflow template "${name}" has validation errors:`);
          for (const error of errors) console.log(`  - ${error}`);
          process.exit(1);
        }
        return;
      }

      // Try JS module
      const found = await findJsWorkflow(name);
      if (found) {
        try {
          const mod = await loadWorkflow(found.path);
          console.log(`Workflow module "${name}" is valid.`);
          console.log(`  Name: ${mod.meta.name}`);
          console.log(`  Description: ${mod.meta.description}`);
          console.log(`  Format: ${mod.format}`);
          console.log(`  Phases: ${mod.meta.phases.length}`);
          console.log(`  Hash: ${mod.hash}`);
          if (mod.meta.version) console.log(`  Version: ${mod.meta.version}`);
          if (mod.meta.risk) console.log(`  Risk: ${mod.meta.risk}`);
        } catch (err) {
          console.log(`Workflow module "${name}" failed validation:`);
          console.log(`  ${(err as Error).message}`);
          process.exit(1);
        }
        return;
      }

      // Not found anywhere
      console.log(`Workflow "${name}" not found.`);
      console.log('Use "openslack collaboration workflow list" to see available workflows.');
      process.exit(1);
    });

  workflow
    .command('preview-js <name>')
    .description('Preview a JS workflow module in read-only mode')
    .option('--input <key=value>', 'Workflow input value', (value, previous: string[]) => [...previous, value], [])
    .option('--budget-tokens <number>', 'Token budget for preview', '10000')
    .action(async (name: string, options: { input: string[]; budgetTokens: string }) => {
      const found = await findJsWorkflow(name);
      if (!found) {
        console.log(`JS workflow module "${name}" not found.`);
        console.log('Use "openslack collaboration workflow list" to see available workflows.');
        process.exit(1);
      }

      try {
        const mod = await loadWorkflow(found.path);
        const args = parseInputs(options.input);
        const budgetTokens = parseInt(options.budgetTokens, 10);

        console.log(`Previewing workflow: ${mod.meta.name}`);
        console.log(`  Mode: preview (read-only)`);
        console.log(`  Format: ${mod.format}`);
        console.log(`  Budget: ${budgetTokens} tokens`);
        console.log('');

        const result = await executePreview(mod, {
          manifest: mod.meta,
          args,
          budget: { tokens: Number.isFinite(budgetTokens) ? budgetTokens : 10000, costUsd: 0 },
        });

        console.log('Preview Result:');
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.log(`Preview failed for workflow "${name}":`);
        console.log(`  ${(err as Error).message}`);
        process.exit(1);
      }
    });

  workflow
    .command('show <name>')
    .description('Show detailed information about a workflow')
    .action(async (name: string) => {
      // Try YAML template first
      const builtinPath = resolveBuiltinTemplatePath(name);
      if (builtinPath) {
        const template = parseYaml(readFileSync(builtinPath, 'utf-8')) as WorkflowTemplate;
        console.log(`Workflow Template: ${template.name}`);
        console.log(`  Schema: ${template.schema}`);
        console.log(`  ID: ${template.id}`);
        console.log('');
        if (template.inputs && template.inputs.length > 0) {
          console.log('Inputs:');
          for (const input of template.inputs) {
            const required = input.required ? ' (required)' : '';
            const def = input.default !== undefined ? ` [default: ${input.default}]` : '';
            console.log(`  - ${input.name} (${input.type})${required}${def}`);
          }
          console.log('');
        }
        console.log('Phases:');
        for (const phase of template.phases) {
          console.log(`  ${phase.name}:`);
          for (const step of phase.steps) {
            if (step.type === 'action') {
              console.log(`    - [action] ${step.title ?? step.actionId} (${step.actionId})`);
            } else if (step.type === 'decision-gate') {
              console.log(`    - [decision-gate] ${step.title} (role: ${step.requiredRole})`);
            } else if (step.type === 'handoff') {
              console.log(`    - [handoff] ${step.from} -> ${step.to}: ${step.context}`);
            } else if (step.type === 'record-decision') {
              console.log(`    - [record-decision] ${step.topic}`);
            } else if (step.type === 'wait') {
              console.log(`    - [wait] ${step.title}`);
            }
          }
        }
        return;
      }

      // Try JS module
      const found = await findJsWorkflow(name);
      if (found) {
        try {
          const mod = await loadWorkflow(found.path);
          const meta = mod.meta;
          console.log(`Workflow Module: ${meta.name}`);
          console.log(`  Description: ${meta.description}`);
          console.log(`  Format: ${mod.format}`);
          console.log(`  Hash: ${mod.hash}`);
          if (meta.version) console.log(`  Version: ${meta.version}`);
          if (meta.risk) console.log(`  Risk: ${meta.risk}`);
          if (meta.whenToUse) console.log(`  When to use: ${meta.whenToUse}`);
          console.log('');
          console.log('Phases:');
          for (const phase of meta.phases) {
            console.log(`  - ${phase.title}: ${phase.detail}`);
          }
          if (meta.inputs && Object.keys(meta.inputs).length > 0) {
            console.log('');
            console.log('Inputs:');
            for (const [key, input] of Object.entries(meta.inputs)) {
              const def = input.default !== undefined ? ` [default: ${input.default}]` : '';
              console.log(`  - ${key} (${input.type}): ${input.description}${def}`);
            }
          }
          if (meta.permissions) {
            console.log('');
            console.log('Permissions:');
            for (const [cat, actions] of Object.entries(meta.permissions)) {
              console.log(`  ${cat}: ${(actions as string[]).join(', ')}`);
            }
          }
          if (meta.sideEffects && meta.sideEffects.length > 0) {
            console.log('');
            console.log('Side Effects:');
            for (const se of meta.sideEffects) console.log(`  - ${se}`);
          }
          console.log('');
          console.log(`  Preview: ${mod.preview ? 'available' : 'not available'}`);
          console.log(`  Run: ${mod.run ? 'available' : 'not available'}`);
        } catch (err) {
          console.log(`Error loading workflow "${name}":`);
          console.log(`  ${(err as Error).message}`);
          process.exit(1);
        }
        return;
      }

      // Not found anywhere
      console.log(`Workflow "${name}" not found.`);
      console.log('Use "openslack collaboration workflow list" to see available workflows.');
      process.exit(1);
    });

  workflow
    .command('dry-run <name>')
    .description('Simulate workflow execution without real side effects')
    .option('--input <key=value>', 'Workflow input value', (value, previous: string[]) => [...previous, value], [])
    .option('--budget-tokens <number>', 'Token budget for dry-run', '50000')
    .option('--agent-id <id>', 'Agent ID for authorization')
    .action(async (name: string, options: { input: string[]; budgetTokens: string; agentId?: string }) => {
      ensureWorkflowEnabled('dry-run');
      // Try YAML template first
      const builtinPath = resolveBuiltinTemplatePath(name);
      if (builtinPath) {
        const template = loadWorkflowTemplate(name);
        const result = await executeWorkflowTemplate(template, parseInputs(options.input), {
          dryRun: true,
          ...resolveAgentAuthOptions(options.agentId),
        });
        console.log(renderWorkflowPreview(result.preview));
        console.log('');
        console.log(`Status: ${result.status}`);
        console.log(`Correlation: ${result.correlationId}`);
        if (result.errors.length > 0) {
          for (const error of result.errors) console.log(`Error: ${error}`);
          process.exit(1);
        }
        return;
      }

      // Try JS module
      const found = await findJsWorkflow(name);
      if (!found) {
        console.log(`Workflow "${name}" not found.`);
        console.log('Use "openslack collaboration workflow list" to see available workflows.');
        process.exit(1);
      }

      try {
        const mod = await loadWorkflow(found.path);
        const args = parseInputs(options.input);
        const budgetTokens = parseInt(options.budgetTokens, 10);

        console.log(`Dry-run: ${mod.meta.name}`);
        console.log(`  Mode: dry-run (simulated side effects)`);
        console.log(`  Budget: ${budgetTokens} tokens`);
        console.log('');

        const result = await executeDryRun(mod, {
          manifest: mod.meta,
          args,
          budget: { tokens: Number.isFinite(budgetTokens) ? budgetTokens : 50000, costUsd: 0 },
        });

        console.log('Dry-Run Result:');
        console.log(`  Run ID: ${result.runId}`);
        console.log(`  Workflow: ${result.workflowName}`);
        console.log(`  Simulated Effects: ${result.simulatedEffects.length}`);
        for (const effect of result.simulatedEffects) {
          console.log(`    - [${effect.timestamp}] ${effect.operation}: ${effect.detail}`);
        }
        if (result.result) {
          console.log('');
          console.log('  Workflow Result:');
          console.log(JSON.stringify(result.result, null, 2));
        }
        if (result.errors.length > 0) {
          console.log('');
          console.log('  Errors:');
          for (const error of result.errors) console.log(`    - ${error}`);
        }
      } catch (err) {
        console.log(`Dry-run failed for workflow "${name}":`);
        console.log(`  ${(err as Error).message}`);
        process.exit(1);
      }
    });

  workflow
    .command('run <name>')
    .description('Execute a workflow with real side effects')
    .option('--input <key=value>', 'Workflow input value', (value, previous: string[]) => [...previous, value], [])
    .option('--budget-tokens <number>', 'Token budget for execution', '100000')
    .option('--yes', 'Auto-approve all side effects without interactive confirmation')
    .option('--agent-id <id>', 'Agent ID for authorization')
    .option('--audit-issue', 'Create a GitHub issue to audit this workflow run', false)
    .action(async (name: string, options: { input: string[]; budgetTokens: string; yes?: boolean; agentId?: string; auditIssue?: boolean }) => {
      ensureWorkflowEnabled('execution');
      const found = await findJsWorkflow(name);
      if (!found) {
        console.log(`JS workflow module "${name}" not found.`);
        console.log('Use "openslack collaboration workflow list" to see available workflows.');
        process.exit(1);
      }

      try {
        const mod = await loadWorkflow(found.path);
        const args = parseInputs(options.input);
        const budgetTokens = parseInt(options.budgetTokens, 10);

        if (!mod.run && mod.format !== 'claude-ambient') {
          console.log(`Workflow "${name}" has no run function. Use preview or dry-run instead.`);
          process.exit(1);
        }

        // Confirmation gate: --yes auto-approves, otherwise interactive prompt required
        const onConfirm = options.yes
          ? async (operation: string, detail: string): Promise<boolean> => {
              console.log(`[AUTO-APPROVE] ${operation}: ${detail}`);
              return true;
            }
          : async (operation: string, detail: string): Promise<boolean> => {
              // Refuse to execute interactively if not in a TTY
              if (!process.stdin.isTTY) {
                console.error(`[ERROR] Cannot prompt for confirmation: not a TTY.`);
                console.error(`  Use --yes to auto-approve, or run in an interactive terminal.`);
                return false;
              }
              console.log(`[CONFIRM] ${operation}: ${detail}`);
              const { createInterface } = await import('readline');
              const rl = createInterface({ input: process.stdin, output: process.stdout });
              const answer = await new Promise<string>(resolve => {
                rl.question('Proceed? [y/N] ', resolve);
              });
              rl.close();
              return answer.toLowerCase() === 'y';
            };

        console.log(`Executing: ${mod.meta.name}`);
        console.log(`  Mode: execute`);
        console.log(`  Budget: ${budgetTokens} tokens`);
        if (options.yes) {
          console.log(`  Confirmation: auto-approve (--yes)`);
        }
        if (mod.meta.sideEffects && mod.meta.sideEffects.length > 0) {
          console.log(`  Declared side effects:`);
          for (const se of mod.meta.sideEffects) console.log(`    - ${se}`);
        }
        if (mod.meta.risk) console.log(`  Risk: ${mod.meta.risk}`);
        console.log('');

        const result = await executeRun(mod, {
          manifest: mod.meta,
          args,
          budget: { tokens: Number.isFinite(budgetTokens) ? budgetTokens : 100000, costUsd: 1.0 },
          onConfirm,
          allowUnattended: options.yes,
          agentEventEmitter: createCollaborationEventEmitter(),
          rootDir: findRepoRoot(),
          ...resolveAgentAuthOptions(options.agentId),
        });

        console.log('Execution Result:');
        console.log(JSON.stringify(result, null, 2));

        if (options.auditIssue) {
          try {
            const { publishWorkflowRunAudit } = await import('@openslack/github')
            const auditResult = await publishWorkflowRunAudit(
              {
                runId: (result as Record<string, unknown>).runId as string ?? 'unknown',
                workflowName: mod.meta.name,
                workflowHash: mod.hash,
                mode: 'execute',
                status: result.status,
                startedAt: new Date().toISOString(),
                actor: options.agentId ?? 'openslack-agent-operator',
              },
              { createIssue: true },
            )
            console.log(`  Audit issue created: #${auditResult.issueNumber} (${auditResult.url})`)
          } catch (auditErr) {
            console.log(`  [WARNING] Failed to create audit issue: ${(auditErr as Error).message}`)
          }
        }
      } catch (err) {
        if (err instanceof WorkflowPausedError) {
          console.log(`Workflow paused for approval: ${err.operation}`);
          console.log(`  Run ID: ${err.runId}`);
          console.log(`  Detail: ${err.detail}`);
          process.exit(1);
        }
        if (err instanceof WorkflowBudgetPausedError) {
          console.log('Workflow paused for budget approval.');
          console.log(`  Run ID: ${err.runId}`);
          console.log(`  Detail: ${err.detail}`);
          process.exit(1);
        }
        console.log(`Execution failed for workflow "${name}":`);
        console.log(`  ${(err as Error).message}`);
        process.exit(1);
      }
    });

  workflow
    .command('resume <runId>')
    .description('Resume a paused workflow run from its last checkpoint')
    .option('--yes', 'Auto-approve all side effects without interactive confirmation')
    .option('--agent-id <id>', 'Agent ID for authorization')
    .action(async (runId: string, options: { yes?: boolean; agentId?: string }) => {
      ensureWorkflowEnabled('resume');
      const root = findRepoRoot();
      const store = new RunStore({
        baseDir: join(root, '.openslack.local', 'workflows'),
      });

      // Load run metadata
      const meta = await store.loadMeta(runId);
      if (!meta) {
        console.log(`Run ${runId} not found.`);
        process.exit(1);
      }

      // Find the workflow module
      const found = await findJsWorkflow(meta.workflowName);
      if (!found) {
        console.log(`Workflow module "${meta.workflowName}" not found for run ${runId}.`);
        process.exit(1);
      }

      try {
        const mod = await loadWorkflow(found.path);

        if (!mod.run && mod.format !== 'claude-ambient') {
          console.log(`Workflow "${meta.workflowName}" has no run function.`);
          process.exit(1);
        }

        // Check resumability
        const check = await checkResumable(store, runId, mod.meta);
        if (!check.canResume) {
          console.log(`Cannot resume run ${runId}: ${check.reason}`);
          if (check.manifestMatch === false && check.storedManifestHash && check.currentManifestHash) {
            console.log(`  Stored hash: ${check.storedManifestHash}`);
            console.log(`  Current hash: ${check.currentManifestHash}`);
            console.log('  Use --force to override (not recommended).');
          }
          process.exit(1);
        }

        // Prepare resume state
        const resumeState = await prepareResume(store, runId, mod.meta);

        console.log(`Resuming: ${mod.meta.name}`);
        console.log(`  Run ID: ${runId}`);
        console.log(`  Completed phases: ${resumeState.completedPhases.map(p => p.phase).join(', ')}`);
        console.log(`  Next phase index: ${resumeState.nextPhaseIndex}`);
        console.log('');

        const onConfirm = options.yes
          ? async (operation: string, detail: string): Promise<boolean> => {
              console.log(`[AUTO-APPROVE] ${operation}: ${detail}`);
              return true;
            }
          : async (operation: string, detail: string): Promise<boolean> => {
              if (!process.stdin.isTTY) {
                console.error(`[ERROR] Cannot prompt for confirmation: not a TTY.`);
                console.error(`  Use --yes to auto-approve, or run in an interactive terminal.`);
                return false;
              }
              console.log(`[CONFIRM] ${operation}: ${detail}`);
              const { createInterface } = await import('readline');
              const rl = createInterface({ input: process.stdin, output: process.stdout });
              const answer = await new Promise<string>(resolve => {
                rl.question('Proceed? [y/N] ', resolve);
              });
              rl.close();
              return answer.toLowerCase() === 'y';
            };

        const result = await executeResume(mod, {
          runId,
          manifest: mod.meta,
          args: meta.args,
          onConfirm,
          allowUnattended: options.yes,
          agentEventEmitter: createCollaborationEventEmitter(),
          rootDir: findRepoRoot(),
        });

        console.log('Resume Result:');
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        if (err instanceof WorkflowPausedError) {
          console.log(`Workflow paused for approval: ${err.operation}`);
          console.log(`  Run ID: ${err.runId}`);
          console.log(`  Detail: ${err.detail}`);
          process.exit(1);
        }
        if (err instanceof WorkflowBudgetPausedError) {
          console.log('Workflow paused for budget approval.');
          console.log(`  Run ID: ${err.runId}`);
          console.log(`  Detail: ${err.detail}`);
          process.exit(1);
        }
        await markRunFailedIfActive(store, runId);
        console.log(`Resume failed for run ${runId}:`);
        console.log(`  ${(err as Error).message}`);
        process.exit(1);
      }
    });

  workflow
    .command('trust <name>')
    .description('Set or view the trust level for a workflow')
    .option('--level <level>', 'Trust level to assign: untrusted, trusted, or core')
    .action(async (name: string, options: { level?: string }) => {
      const validLevels = ['untrusted', 'trusted', 'core'] as const
      type TrustLevel = typeof validLevels[number]

      const { TrustStore, resolveTrustLevel, getPermissionsForTrustLevel } = await import('@openslack/workflows')
      const root = findRepoRoot()
      const trustStore = new TrustStore({ rootDir: root })

      // If no level specified, show current trust level
      if (!options.level) {
        const found = await findJsWorkflow(name)
        if (!found) {
          console.log(`Workflow "${name}" not found.`)
          console.log('Use "openslack collaboration workflow list" to see available workflows.')
          process.exit(1)
        }
        // Check TrustStore first, then fall back to default
        const isBuiltin = found.path.includes('/builtins/') || found.path.includes('\\builtins\\')
        const persistedLevel = trustStore.get(name)
        const currentLevel = persistedLevel !== 'untrusted'
          ? persistedLevel
          : resolveTrustLevel({ isBuiltin })
        console.log(`Workflow: ${name}`)
        console.log(`Current trust level: ${currentLevel}`)
        if (isBuiltin) {
          console.log('  (Core workflows are always at core trust level)')
        }
        if (persistedLevel !== 'untrusted') {
          const record = trustStore.list()[name]
          if (record) {
            console.log(`  Set at: ${record.setAt}`)
            console.log(`  Set by: ${record.setBy}`)
          }
        }
        console.log('')
        console.log('To set a trust level: openslack collaboration workflow trust <name> --level <level>')
        console.log('Valid levels: untrusted, trusted, core')
        return
      }

      // Validate the requested level
      const requestedLevel = options.level.toLowerCase()
      if (!validLevels.includes(requestedLevel as TrustLevel)) {
        console.log(`Invalid trust level: "${options.level}"`)
        console.log('Valid levels: untrusted, trusted, core')
        process.exit(1)
      }

      // Look up the workflow
      const found = await findJsWorkflow(name)
      if (!found) {
        console.log(`Workflow "${name}" not found.`)
        console.log('Use "openslack collaboration workflow list" to see available workflows.')
        process.exit(1)
      }

      // Check if this is a builtin workflow (cannot change trust level)
      const isBuiltin = found.path.includes('/builtins/') || found.path.includes('\\builtins\\')
      if (isBuiltin) {
        console.log(`Cannot change trust level for builtin workflow "${name}".`)
        console.log('Core workflows are always at core trust level.')
        process.exit(1)
      }

      // Check if trying to set to core (requires human authorization)
      if (requestedLevel === 'core') {
        console.log('Cannot manually set a workflow to core trust level.')
        console.log('Core trust is reserved for workflows shipped with @openslack/workflows.')
        process.exit(1)
      }

      // Persist the trust level assignment via TrustStore
      trustStore.set(name, requestedLevel as TrustLevel)
      const perms = getPermissionsForTrustLevel(requestedLevel as TrustLevel)
      console.log(`Trust level for workflow "${name}" set to: ${requestedLevel}`)
      console.log(`Available permissions (${perms.size}):`)
      for (const perm of perms) {
        console.log(`  - ${perm}`)
      }
    })

  // ── Inspect command ────────────────────────────────────────────────────────

  cmd
    .command('inspect <runId>')
    .description('Inspect a workflow run with HTML, JSON, or Markdown output')
    .option('--format <format>', 'Output format: html, json, or markdown', 'markdown')
    .option('--out <file>', 'Write output to file instead of stdout')
    .option('--no-run-output', 'Exclude the run output section from the report')
    .option('--no-log', 'Exclude log entries from the report')
    .action(async (runId: string, options: { format: string; out?: string; noRunOutput?: boolean; noLog?: boolean }) => {
      const validFormats = ['html', 'json', 'markdown']
      const format = options.format.toLowerCase()
      if (!validFormats.includes(format)) {
        console.error(`Invalid format: "${options.format}". Use: html, json, or markdown`)
        process.exit(1)
      }

      const root = findRepoRoot()
      const store = new RunStore({
        baseDir: join(root, '.openslack.local', 'workflows'),
      })

      // Load run data
      const runStatus = await store.getRunStatus(runId)
      if (!runStatus) {
        console.error(`Run ${runId} not found.`)
        process.exit(1)
      }

      // Load phases
      const phases = []
      if (runStatus.phases) {
        for (const phase of runStatus.phases) {
          phases.push(phase)
        }
      }

      // Load log entries
      const logEntries: Array<Record<string, unknown>> = []
      try {
        const logs = await store.readLog(runId)
        for (const entry of logs) {
          logEntries.push(entry as unknown as Record<string, unknown>)
        }
      } catch {
        // Log file may not exist; continue without logs
      }

      // Load output
      let output: unknown = null
      try {
        output = await store.loadOutput(runId)
      } catch {
        // Output may not exist; continue without output
      }

      const renderOptions = {
        repoRoot: root,
        includeOutput: !options.noRunOutput,
        includeLog: !options.noLog,
      }

      let rendered: string

      if (format === 'html') {
        rendered = renderRunHtml(runStatus, phases, logEntries, output, renderOptions)
      } else if (format === 'json') {
        rendered = renderRunJson(runStatus, phases, logEntries, output, renderOptions)
      } else {
        rendered = renderRunMarkdown(runStatus, phases, logEntries, output, renderOptions)
      }

      // Output result
      if (options.out) {
        const { writeFile: fsWriteFile } = await import('node:fs/promises')
        const targetPath = options.out
        await fsWriteFile(targetPath, rendered, 'utf-8')
        console.log(`Written to ${targetPath}`)
      } else {
        console.log(rendered)
      }
    })

  // ── Workflow Issue Commands ────────────────────────────────────────────────

  workflow
    .command('publish <name>')
    .description('Publish a workflow as a GitHub proposal issue')
    .option('--as-issue', 'Create a GitHub issue for the workflow proposal', true)
    .option('--label <label>', 'Additional labels (can be used multiple times)', (value: string, previous: string[]) => [...previous, value], [])
    .action(async (name: string, options: { asIssue: boolean; label: string[] }) => {
      const found = await findJsWorkflow(name)
      if (!found) {
        console.log(`Workflow "${name}" not found.`)
        console.log('Use "openslack collaboration workflow list" to see available workflows.')
        process.exit(1)
      }

      try {
        const mod = await loadWorkflow(found.path)
        const result = await publishWorkflowProposal(mod, {
          requestedBy: 'openslack-agent-operator',
          extraLabels: options.label,
        })
        console.log(`Workflow proposal issue created: #${result.issueNumber}`)
        console.log(`URL: ${result.url}`)
      } catch (err) {
        console.log(`Failed to publish workflow proposal:`)
        console.log(`  ${(err as Error).message}`)
        process.exit(1)
      }
    })

  workflow
    .command('review-request <name>')
    .description('Create a security review issue for a workflow')
    .action(async (name: string) => {
      const found = await findJsWorkflow(name)
      if (!found) {
        console.log(`Workflow "${name}" not found.`)
        console.log('Use "openslack collaboration workflow list" to see available workflows.')
        process.exit(1)
      }

      try {
        const mod = await loadWorkflow(found.path)
        const { TrustStore, resolveTrustLevel } = await import('@openslack/workflows')
        const root = findRepoRoot()
        const trustStore = new TrustStore({ rootDir: root })
        const isBuiltin = found.path.includes('/builtins/') || found.path.includes('\\builtins\\')
        const persistedLevel = trustStore.get(name)
        const trustLevel = persistedLevel !== 'untrusted'
          ? persistedLevel
          : resolveTrustLevel({ isBuiltin })

        const result = await publishWorkflowReviewRequest(mod, {
          requestedBy: 'openslack-agent-operator',
          trustLevel,
        })
        console.log(`Workflow review issue created: #${result.issueNumber}`)
        console.log(`URL: ${result.url}`)
      } catch (err) {
        console.log(`Failed to create workflow review:`)
        console.log(`  ${(err as Error).message}`)
        process.exit(1)
      }
    })

  workflow
    .command('audit-run <runId>')
    .description('Publish or append a workflow run audit to a GitHub issue')
    .option('--issue <number>', 'Append as comment to existing issue')
    .option('--create-issue', 'Create a new run audit issue', false)
    .option('--agent-id <id>', 'Agent ID that performed the run')
    .action(async (runId: string, options: { issue?: string; createIssue: boolean; agentId?: string }) => {
      const root = findRepoRoot()
      const { RunStore } = await import('@openslack/workflows')
      const store = new RunStore({ baseDir: join(root, '.openslack.local', 'workflows') })

      const meta = await store.loadMeta(runId)
      if (!meta) {
        console.log(`Run ${runId} not found.`)
        process.exit(1)
      }

      const runStatus = await store.getRunStatus(runId)
      if (!runStatus) {
        console.log(`Run status for ${runId} not found.`)
        process.exit(1)
      }

      // Load workflow module to get the current hash for correlation
      let workflowHash = ''
      try {
        const found = await findJsWorkflow(meta.workflowName)
        if (found) {
          const mod = await loadWorkflow(found.path)
          workflowHash = mod.hash
        }
      } catch {
        // Ignore workflow lookup failure; workflowHash stays empty
      }

      try {
        const issueNum = options.issue ? parseInt(options.issue, 10) : undefined
        if (options.issue !== undefined && !Number.isFinite(issueNum)) {
          console.log(`Invalid issue number: "${options.issue}". Must be a positive integer.`)
          process.exit(1)
        }
        const result = await publishWorkflowRunAudit(
          {
            ...runStatus,
            workflowHash,
            actor: options.agentId ?? 'openslack-agent-operator',
          },
          {
            issueNumber: issueNum,
            createIssue: options.createIssue,
          },
        )
        if (result.isComment) {
          console.log(`Run audit appended to issue #${result.issueNumber}`)
        } else {
          console.log(`Run audit issue created: #${result.issueNumber}`)
        }
        console.log(`URL: ${result.url}`)
      } catch (err) {
        console.log(`Failed to publish run audit:`)
        console.log(`  ${(err as Error).message}`)
        process.exit(1)
      }
    })

  workflow
    .command('split <name>')
    .description('Split a workflow into phase sub-issues')
    .requiredOption('--issue <parentIssue>', 'Parent issue number to link sub-issues to')
    .option('--no-native-subissues', 'Skip native GitHub sub-issue linking and use fallback comments')
    .option('--dependencies <mode>', 'Link phase dependencies: linear (each phase blocked by previous)', undefined)
    .action(async (name: string, options: { issue: string; nativeSubissues: boolean; dependencies?: string }) => {
      const found = await findJsWorkflow(name)
      if (!found) {
        console.log(`Workflow "${name}" not found.`)
        console.log('Use "openslack collaboration workflow list" to see available workflows.')
        process.exit(1)
      }

      try {
        const mod = await loadWorkflow(found.path)
        const parentIssue = parseInt(options.issue, 10)
        if (!Number.isFinite(parentIssue) || parentIssue <= 0) {
          console.log(`Invalid issue number: "${options.issue}". Must be a positive integer.`)
          process.exit(1)
        }
        const result = await publishWorkflowSplit(mod, {
          parentIssue,
          nativeSubIssues: options.nativeSubissues,
          linearDependencies: options.dependencies === 'linear',
        })
        console.log(`Workflow split parent issue: #${result.parentIssueNumber}`)
        console.log('Phase sub-issues:')
        for (const sub of result.subIssues) {
          console.log(`  - ${sub.phase}: #${sub.issueNumber} (${sub.url})`)
        }
        console.log(`Native sub-issues linked: ${result.links.nativeSubIssues}`)
        console.log(`Fallback dependency links: ${result.links.fallbackDependencies}`)
        if (result.links.fallbackReasons.length > 0) {
          console.log('Fallback reasons:')
          for (const reason of result.links.fallbackReasons) {
            console.log(`  - ${reason.kind}${reason.issueNumber ? ` #${reason.issueNumber}` : ''}: ${reason.reason}`)
          }
        }
      } catch (err) {
        console.log(`Failed to split workflow:`)
        console.log(`  ${(err as Error).message}`)
        process.exit(1)
      }
    })

  workflow
    .command('improvement <name>')
    .description('Create a workflow improvement issue')
    .requiredOption('--problem <text>', 'Description of the problem or limitation')
    .requiredOption('--change <text>', 'Proposed change or improvement')
    .option('--phase <phaseName>', 'Affected phase name (can be used multiple times)', (value: string, previous: string[]) => [...previous, value], [])
    .option('--breaking', 'Mark as a breaking change', false)
    .action(async (name: string, options: { problem: string; change: string; phase: string[]; breaking: boolean }) => {
      const found = await findJsWorkflow(name)
      if (!found) {
        console.log(`Workflow "${name}" not found.`)
        console.log('Use "openslack collaboration workflow list" to see available workflows.')
        process.exit(1)
      }

      try {
        const result = await publishWorkflowImprovement({
          schema: 'openslack.workflow_improvement.v1',
          workflowId: name,
          problem: options.problem,
          proposedChange: options.change,
          affectedPhases: options.phase,
          backwardCompatible: !options.breaking,
        })
        console.log(`Workflow improvement issue created: #${result.issueNumber}`)
        console.log(`URL: ${result.url}`)
      } catch (err) {
        console.log(`Failed to create workflow improvement:`)
        console.log(`  ${(err as Error).message}`)
        process.exit(1)
      }
    })

  workflow
    .command('finalize-pr <prNumber>')
    .description('Finalize workflow lifecycle after a PR is merged')
    .option('--proposal-issue <number>', 'Workflow proposal issue to close')
    .option('--review-issue <number>', 'Workflow review issue to comment on')
    .option('--phase-issues <numbers>', 'Comma-separated phase issue numbers to close')
    .option('--hash <hash>', 'Workflow hash to record')
    .option('--trust <level>', 'Trust decision: trusted, untrusted, or core')
    .action(async (prNumber: string, options: { proposalIssue?: string; reviewIssue?: string; phaseIssues?: string; hash?: string; trust?: string }) => {
      const pr = parseInt(prNumber, 10)
      if (!Number.isFinite(pr) || pr <= 0) {
        console.log(`Invalid PR number: "${prNumber}". Must be a positive integer.`)
        process.exit(1)
      }

      const proposalIssue = options.proposalIssue ? parseInt(options.proposalIssue, 10) : undefined
      const reviewIssue = options.reviewIssue ? parseInt(options.reviewIssue, 10) : undefined
      const phaseIssues = options.phaseIssues
        ? options.phaseIssues.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n))
        : undefined

      const validTrust = options.trust === 'trusted' || options.trust === 'untrusted' || options.trust === 'core'
        ? options.trust
        : undefined

      try {
        const result = await finalizeWorkflowPR(pr, {
          proposalIssue,
          reviewIssue,
          phaseIssues,
          workflowHash: options.hash,
          trustDecision: validTrust as 'trusted' | 'untrusted' | 'core' | undefined,
        })

        console.log(`Workflow PR finalize complete for #${pr}:`)
        console.log(`  Closed issues: ${result.closedIssues.length > 0 ? result.closedIssues.join(', ') : 'none'}`)
        console.log(`  Commented issues: ${result.commentedIssues.length > 0 ? result.commentedIssues.join(', ') : 'none'}`)
        console.log(`  Updated labels: ${result.updatedLabels.length > 0 ? result.updatedLabels.join(', ') : 'none'}`)
        if (result.errors.length > 0) {
          console.log('  Errors:')
          for (const err of result.errors) console.log(`    - ${err}`)
        }
      } catch (err) {
        console.log(`Failed to finalize workflow PR:`)
        console.log(`  ${(err as Error).message}`)
        process.exit(1)
      }
    })

  workflow
    .command('labels')
    .description('Manage workflow labels in the repository')
    .option('--bootstrap', 'Create all required workflow labels if they do not exist', false)
    .action(async (options: { bootstrap: boolean }) => {
      if (!options.bootstrap) {
        console.log('Usage: openslack collaboration workflow labels --bootstrap')
        console.log('Creates all required workflow labels in the repository.')
        return
      }

      try {
        const result = await bootstrapWorkflowLabels()
        console.log(`Label bootstrap complete:`)
        console.log(`  Created: ${result.created.length}`)
        if (result.created.length > 0) {
          for (const name of result.created) console.log(`    - ${name}`)
        }
        console.log(`  Existing: ${result.existing.length}`)
        if (result.failed.length > 0) {
          console.log(`  Failed: ${result.failed.length}`)
          for (const f of result.failed) console.log(`    - ${f.name}: ${f.reason}`)
        }
      } catch (err) {
        console.log(`Failed to bootstrap labels:`)
        console.log(`  ${(err as Error).message}`)
        process.exit(1)
      }
    })

  // ── Profile Sync subcommand ─────────────────────────────────────────────────

  const profileSync = new Command('profile-sync')
    .description('Organization profile synchronization shortcuts')

  // Helper to build config from file + CLI overrides
  async function resolveProfileSyncConfig(options: Record<string, unknown>): Promise<{
    config: import('@openslack/github').ProfileSyncConfig
    overrides: string[]
  }> {
    const { loadProfileSyncConfig } = await import('@openslack/github')
    const root = findRepoRoot()
    const config = loadProfileSyncConfig(root)
    const overrides: string[] = []

    const source = typeof options.source === 'string' ? options.source : undefined
    const target = typeof options.target === 'string' ? options.target : undefined
    const path = typeof options.path === 'string' ? options.path : undefined
    const posts = typeof options.posts === 'string' ? options.posts : undefined
    const marker = typeof options.marker === 'string' ? options.marker : undefined
    const max = typeof options.max === 'string' ? options.max : undefined
    const onExistingPr = typeof options.onExistingPr === 'string' ? options.onExistingPr : undefined

    if (source && source !== config.source.repo) {
      config.source.repo = source
      overrides.push(`source.repo = ${source}`)
    }
    if (target && target !== config.target.repo) {
      config.target.repo = target
      overrides.push(`target.repo = ${target}`)
    }
    if (path && path !== config.target.path) {
      config.target.path = path
      overrides.push(`target.path = ${path}`)
    }
    if (posts && posts !== config.source.path) {
      config.source.path = posts
      overrides.push(`source.path = ${posts}`)
    }
    if (marker && marker !== config.target.marker) {
      config.target.marker = marker
      overrides.push(`target.marker = ${marker}`)
    }
    if (max) {
      const n = parseInt(max, 10)
      if (!isNaN(n) && n !== config.max_posts) {
        config.max_posts = n
        overrides.push(`max_posts = ${n}`)
      }
    }
    if (onExistingPr && ['skip', 'update', 'create_new'].includes(onExistingPr)) {
      config.on_existing_pr = onExistingPr as 'skip' | 'update' | 'create_new'
      overrides.push(`on_existing_pr = ${onExistingPr}`)
    }

    return { config, overrides }
  }

  profileSync
    .command('check')
    .description('Check profile sync readiness without side effects')
    .option('--source <repo>', 'Source whitepapers repo')
    .option('--target <repo>', 'Target profile repo')
    .option('--path <path>', 'Target README path')
    .option('--posts <dir>', 'Posts directory in source repo')
    .option('--marker <name>', 'HTML comment marker name')
    .option('--max <n>', 'Maximum posts to include')
    .action(async (options: {
      source?: string
      target?: string
      path?: string
      posts?: string
      marker?: string
      max?: string
    }) => {
      try {
        const { checkProfileSync } = await import('@openslack/github')
        const { config, overrides } = await resolveProfileSyncConfig(options)

        if (overrides.length > 0) {
          console.log(`Config overrides: ${overrides.join(', ')}`)
        }

        const result = await checkProfileSync(config)
        console.log(JSON.stringify(result, null, 2))
        process.exit(result.ok ? 0 : 1)
      } catch (err) {
        console.error(`Check failed: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  profileSync
    .command('preview')
    .description('Preview profile sync without side effects')
    .option('--source <repo>', 'Source whitepapers repo')
    .option('--target <repo>', 'Target profile repo')
    .option('--path <path>', 'Target README path')
    .option('--posts <dir>', 'Posts directory in source repo')
    .option('--marker <name>', 'HTML comment marker name')
    .option('--max <n>', 'Maximum posts to include')
    .option('--format <format>', 'Output format: diff, json, markdown', 'diff')
    .action(async (options: {
      source?: string
      target?: string
      path?: string
      posts?: string
      marker?: string
      max?: string
      format?: string
    }) => {
      try {
        const { previewProfileSync } = await import('@openslack/github')
        const { config, overrides } = await resolveProfileSyncConfig(options)

        if (overrides.length > 0) {
          console.log(`Config overrides: ${overrides.join(', ')}`)
        }

        const result = await previewProfileSync(config)
        const format = options.format || 'diff'

        if (format === 'diff') {
          console.log(result.diff || '// No diff available')
        } else if (format === 'markdown') {
          console.log(renderProfileSyncPreviewMarkdown(result))
        } else {
          console.log(JSON.stringify(result, null, 2))
        }

        process.exit(result.ok ? 0 : 1)
      } catch (err) {
        console.error(`Preview failed: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  profileSync
    .command('run')
    .description('Run profile sync with real side effects')
    .option('--source <repo>', 'Source whitepapers repo')
    .option('--target <repo>', 'Target profile repo')
    .option('--path <path>', 'Target README path')
    .option('--posts <dir>', 'Posts directory in source repo')
    .option('--marker <name>', 'HTML comment marker name')
    .option('--max <n>', 'Maximum posts to include')
    .option('--on-existing-pr <action>', 'Action when open profile-sync PR exists: skip, update, create_new')
    .option('--yes', 'Auto-approve side effects')
    .option('--agent-id <id>', 'Agent ID for authorization')
    .action(async (options: {
      source?: string
      target?: string
      path?: string
      posts?: string
      marker?: string
      max?: string
      onExistingPr?: string
      yes?: boolean
      agentId?: string
    }) => {
      const found = await findJsWorkflow('profile-sync')
      if (!found) {
        console.log('Profile-sync workflow not found.')
        process.exit(1)
      }

      try {
        const { config, overrides } = await resolveProfileSyncConfig(options)

        if (overrides.length > 0) {
          console.log(`Config overrides: ${overrides.join(', ')}`)
        }

        const mod = await loadWorkflow(found.path)
        const onConfirm = options.yes
          ? async (_operation: string, _detail: string): Promise<boolean> => true
          : async (operation: string, detail: string): Promise<boolean> => {
              if (!process.stdin.isTTY) {
                console.error(`[ERROR] Not a TTY. Use --yes to auto-approve.`)
                return false
              }
              console.log(`[CONFIRM] ${operation}: ${detail}`)
              const { createInterface } = await import('readline')
              const rl = createInterface({ input: process.stdin, output: process.stdout })
              const answer = await new Promise<string>((resolve) => {
                rl.question('Proceed? [y/N] ', resolve)
              })
              rl.close()
              return answer.toLowerCase() === 'y'
            }

        const result = await executeRun(mod, {
          manifest: mod.meta,
          args: {
            sourceRepo: config.source.repo,
            targetRepo: config.target.repo,
            targetPath: config.target.path,
            sourcePostsPath: config.source.path,
            marker: config.target.marker,
            maxPosts: config.max_posts,
          },
          budget: { tokens: 100000, costUsd: 1.0 },
          onConfirm,
          allowUnattended: options.yes,
          agentEventEmitter: createCollaborationEventEmitter(),
          rootDir: findRepoRoot(),
          ...resolveAgentAuthOptions(options.agentId),
        })

        console.log(JSON.stringify(result, null, 2))
      } catch (err) {
        console.log(`Run failed: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  profileSync
    .command('status')
    .description('Show profile sync status')
    .action(async () => {
      try {
        const { buildProfileSyncStatus } = await import('@openslack/collaboration')
        const { loadProfileSyncConfig } = await import('@openslack/github')
        const config = loadProfileSyncConfig()

        const status = buildProfileSyncStatus({
          targetRepo: config.target.repo,
          targetPath: config.target.path,
          marker: config.target.marker,
        })

        console.log('Profile Sync Status')
        console.log('-------------------')
        console.log(`State: ${status.state}`)
        if (status.lastSyncDate) {
          console.log(`Last sync: ${new Date(status.lastSyncDate).toISOString()}`)
        }
        if (status.lastPrUrl) {
          console.log(`PR: ${status.lastPrUrl}`)
        }
        if (status.lastSourceSha) {
          console.log(`Source commit: ${status.lastSourceSha}`)
        }
        console.log(`Posts synced: ${status.postsSynced}`)
        console.log(`Out of date: ${status.isOutOfDate ? 'yes' : 'no'}`)

        if (status.failures.length > 0) {
          console.log('')
          console.log('Recent failures:')
          for (const f of status.failures.slice(-3)) {
            console.log(`  - ${f.date}: ${f.error.slice(0, 80)}`)
            if (f.issueUrl) console.log(`    Issue: ${f.issueUrl}`)
          }
        }

        if (status.state === 'never') {
          console.log('')
          console.log('Run `openslack collaboration workflow profile-sync run` to perform a sync.')
        }
      } catch (err) {
        console.log(`Status check failed: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  workflow.addCommand(profileSync)

  cmd.addCommand(workflow);

  return cmd;
}

// ── Profile Sync helpers ──────────────────────────────────────────────────────

function renderProfileSyncPreviewMarkdown(
  result: import('@openslack/github').ProfileSyncPreviewResult,
): string {
  const lines: string[] = []
  lines.push('# Profile Sync Preview')
  lines.push('')

  if (!result.ok) {
    lines.push('## Status: FAILED')
    lines.push('')
    for (const err of result.checkResult.errors) {
      lines.push(`- ❌ ${err}`)
    }
    lines.push('')
  } else {
    lines.push('## Status: OK')
    lines.push('')
  }

  lines.push('## Source')
  lines.push(`- Repo: ${result.checkResult.source.repo}`)
  lines.push(`- Branch: ${result.checkResult.source.branch}`)
  lines.push(`- Path: ${result.checkResult.source.path}`)
  lines.push(`- Accessible: ${result.checkResult.source.accessible ? '✅' : '❌'}`)
  lines.push(`- Posts found: ${result.checkResult.source.postCount}`)
  lines.push('')

  lines.push('## Target')
  lines.push(`- Repo: ${result.checkResult.target.repo}`)
  lines.push(`- Branch: ${result.checkResult.target.branch}`)
  lines.push(`- Path: ${result.checkResult.target.path}`)
  lines.push(`- Accessible: ${result.checkResult.target.accessible ? '✅' : '❌'}`)
  lines.push(`- Marker exists: ${result.checkResult.target.markerExists ? '✅' : '❌'}`)
  lines.push('')

  lines.push('## Posts')
  lines.push(`- Total valid: ${result.checkResult.posts.total}`)
  lines.push(`- Published: ${result.checkResult.posts.published}`)
  lines.push(`- Failed: ${result.checkResult.posts.failed}`)
  if (result.checkResult.posts.failures.length > 0) {
    lines.push('')
    lines.push('### Failures')
    for (const f of result.checkResult.posts.failures) {
      lines.push(`- **${f.file}**:`)
      for (const e of f.errors) {
        lines.push(`  - ${e.field}: ${e.message}`)
      }
    }
  }
  lines.push('')

  lines.push('## Diff')
  lines.push('```diff')
  lines.push(result.diff || '// No diff available')
  lines.push('```')
  lines.push('')

  lines.push(`## Would create branch: \`${result.wouldCreateBranch}\``)

  return lines.join('\n')
}

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
  buildRoomView, renderRoom,
  previewWorkflowTemplate, executeWorkflowTemplate, renderWorkflowPreview,
  validateWorkflowTemplate,
  buildDashboardProjection, renderDashboardProjection, BLOCKER_TYPES,
} from '@openslack/collaboration';
import type { WorkflowTemplate } from '@openslack/collaboration';
import { resolveAgentPrincipal, renderFindingsPlain } from '@openslack/runtime';
import type { PlainFinding } from '@openslack/runtime';
import {
  buildDashboardCard, buildDigestCard, buildRoomCard, buildActivityCard,
  cardToText,
} from '@openslack/chat-gateway';

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
    .option('--format <format>', 'Output format: standard, plain, json, chat, or tui', 'standard')
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
      } else {
        console.log(renderActivityFeed(filtered));
      }
    });

  cmd
    .command('digest')
    .description('Show collaboration digest (grouped summary)')
    .option('--since <hours>', 'Period in hours', '24')
    .option('--format <format>', 'Output format: standard, plain, json, or chat', 'standard')
    .action(async (options: { since: string; format: string }) => {
      const hours = parseInt(options.since, 10);
      const events = readEvents();

      let filtered = events;
      if (hours > 0) {
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
        filtered = filterEvents(filtered, { since: cutoff });
      }

      const digest = buildDigest(filtered, hours);
      if (options.format === 'json') {
        console.log(JSON.stringify(digest, null, 2));
      } else if (options.format === 'chat') {
        const card = buildDigestCard({
          sinceHours: digest.periodHours,
          totalEvents: digest.totalEvents,
          groups: digest.groups.map((g) => ({ label: g.label, count: g.events.length, items: g.events.map((e) => e.summary) })),
        });
        console.log(cardToText(card));
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
    .action(() => {
      console.log(renderHandoffList(listHandoffs()));
    });

  handoff
    .command('show <id>')
    .description('Show a specific handoff')
    .action((id: string) => {
      const h = getHandoff(id);
      if (!h) {
        console.log(`Handoff ${id} not found.`);
        process.exit(1);
      }
      console.log(renderHandoff(h));
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
    .action(() => {
      console.log(renderDecisionList(listDecisions()));
    });

  decision
    .command('show <id>')
    .description('Show a specific decision')
    .action((id: string) => {
      const d = getDecision(id);
      if (!d) {
        console.log(`Decision ${id} not found.`);
        process.exit(1);
      }
      console.log(renderDecision(d));
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
    .option('--format <format>', 'Output format: standard, plain, json, or chat', 'standard')
    .action((roomId: string, options: { format: string }) => {
      const events = readEvents();
      const view = buildRoomView(roomId, events);
      if (!view) {
        console.log(`Invalid room ID: ${roomId}. Use format: pr:42, issue:21, module:operator`);
        process.exit(1);
      }
      if (options.format === 'json') {
        console.log(JSON.stringify(view, null, 2));
      } else if (options.format === 'chat') {
        const card = buildRoomCard({
          roomId: view.roomId,
          eventCount: view.recentEvents.length,
          blockerCount: view.blockers.length,
          handoffCount: view.linkedHandoffs.length,
          decisionCount: view.linkedDecisions.length,
          blockers: view.blockers.map((b) => ({ object: b.type, summary: b.summary })),
        });
        console.log(cardToText(card));
      } else if (options.format === 'plain') {
        const findings: PlainFinding[] = [];
        for (const blocker of view.blockers) {
          findings.push({ status: 'FAIL', title: `Blocker: ${blocker.type}`, detail: blocker.summary, nextAction: blocker.nextAction?.action });
        }
        if (view.owner) findings.push({ status: 'informational', title: 'Owner', detail: view.owner });
        if (view.nextAction) findings.push({ status: 'informational', title: 'Next action', detail: view.nextAction });
        for (const h of view.linkedHandoffs) {
          findings.push({ status: 'informational', title: `Handoff: ${h.id}`, detail: `${h.from} → ${h.to} (${h.status})` });
        }
        for (const d of view.linkedDecisions) {
          findings.push({ status: 'informational', title: `Decision: ${d.id}`, detail: `${d.topic}: ${d.decision} (${d.status})` });
        }
        if (view.blockers.length === 0) findings.push({ status: 'PASS', title: 'No blockers', detail: `No blockers for room ${view.roomId}` });
        console.log(renderFindingsPlain(findings));
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
    .action((file: string, options: { input: string[] }) => {
      const template = loadWorkflowTemplate(file);
      const preview = previewWorkflowTemplate(template, parseInputs(options.input));
      console.log(renderWorkflowPreview(preview));
      if (preview.errors.length > 0) process.exit(1);
    });

  workflow
    .command('execute <file>')
    .description('Execute a workflow template after validation')
    .option('--input <key=value>', 'Template input value', (value, previous: string[]) => [...previous, value], [])
    .option('--dry-run', 'Validate and execute registered actions in dry-run mode')
    .option('--agent-id <id>', 'Agent ID for authorization')
    .action(async (file: string, options: { input: string[]; dryRun?: boolean; agentId?: string }) => {
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
    .description('List built-in workflow templates')
    .action(() => {
      const templates = listBuiltinTemplates();
      if (templates.length === 0) {
        console.log('No built-in workflow templates found.');
        return;
      }
      console.log('| ID | Name | Phases | Inputs |');
      console.log('|----|------|---------|--------|');
      for (const t of templates) {
        console.log(`| ${t.id} | ${t.name} | ${t.phases} | ${t.inputs} |`);
      }
      console.log('');
      console.log(`Use: openslack collaboration workflow preview <id> --input key=value`);
    });

  cmd.addCommand(workflow);

  return cmd;
}

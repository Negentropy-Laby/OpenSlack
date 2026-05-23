import { Command } from 'commander';
import {
  readEvents, filterEvents, renderActivityFeed, buildDigest, renderDigest,
  createHandoff, listHandoffs, getHandoff, acceptHandoff, closeHandoff,
  renderHandoffList, renderHandoff,
  recordDecision, listDecisions, getDecision, supersedeDecision,
  renderDecisionList, renderDecision,
  buildRoomView, renderRoom,
} from '@openslack/collaboration';

export function collaborationCommands(): Command {
  const cmd = new Command('collaboration').description('OpenSlack Collaboration Layer');

  cmd
    .command('activity')
    .description('Show collaboration activity feed')
    .option('--since <hours>', 'Filter events from last N hours', '24')
    .option('--object <ref>', 'Filter by object (e.g., pr:42, issue:21)')
    .option('--actor <id>', 'Filter by actor ID')
    .option('--type <type>', 'Filter by event type')
    .action(async (options: { since: string; object?: string; actor?: string; type?: string }) => {
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

      console.log(renderActivityFeed(filtered));
    });

  cmd
    .command('digest')
    .description('Show collaboration digest (grouped summary)')
    .option('--since <hours>', 'Period in hours', '24')
    .action(async (options: { since: string }) => {
      const hours = parseInt(options.since, 10);
      const events = readEvents();

      let filtered = events;
      if (hours > 0) {
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
        filtered = filterEvents(filtered, { since: cutoff });
      }

      const digest = buildDigest(filtered, hours);
      console.log(renderDigest(digest));
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
    .action((roomId: string) => {
      const events = readEvents();
      const view = buildRoomView(roomId, events);
      if (!view) {
        console.log(`Invalid room ID: ${roomId}. Use format: pr:42, issue:21, module:operator`);
        process.exit(1);
      }
      console.log(renderRoom(view));
    });

  cmd.addCommand(room);

  return cmd;
}

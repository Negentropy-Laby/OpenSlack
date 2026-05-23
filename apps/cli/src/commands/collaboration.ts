import { Command } from 'commander';
import {
  readEvents, filterEvents, renderActivityFeed, buildDigest, renderDigest,
  createHandoff, listHandoffs, getHandoff, acceptHandoff, closeHandoff,
  renderHandoffList, renderHandoff,
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

  return cmd;
}

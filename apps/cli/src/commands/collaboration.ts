import { Command } from 'commander';
import { readEvents, filterEvents, renderActivityFeed, buildDigest, renderDigest } from '@openslack/collaboration';

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

  return cmd;
}

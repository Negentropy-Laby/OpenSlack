import { Command } from 'commander';
import { WebhookAdapter, SlackAdapter, routeMessage } from '@openslack/chat-gateway';
import type { GatewayConfig } from '@openslack/chat-gateway';

export function chatCommands(): Command {
  const cmd = new Command('chat').description('OpenSlack Chat Gateway');

  cmd
    .command('start')
    .description('Start the chat gateway adapter')
    .requiredOption('--adapter <type>', 'Adapter type (webhook, slack)')
    .option('--port <number>', 'Port for adapter', '3000')
    .option('--secret <string>', 'Shared secret (webhook) or Slack signing secret')
    .action(async (options: { adapter: string; port: string; secret?: string }) => {
      const secret = options.secret || process.env.OPENSLACK_WEBHOOK_SECRET || process.env.OPENSLACK_SLACK_SIGNING_SECRET || '';
      const config: GatewayConfig = {
        webhookSecret: secret,
        readOnlyByDefault: true,
      };

      if (options.adapter === 'webhook') {
        const adapter = new WebhookAdapter({
          port: Number(options.port),
          secret: secret || undefined,
        });

        adapter.onMessage(async (message) => {
          const result = await routeMessage(message, config, {
            payload: JSON.stringify({
              text: message.text,
              user: message.user.id,
              channel: message.channel.id,
            }),
            signature: undefined,
          });

          console.log(`[${message.id}] ${message.user.id}: ${message.text}`);
          if (result.text) {
            console.log(`→ ${result.text.slice(0, 200)}${result.text.length > 200 ? '...' : ''}`);
            await adapter.send(message.channel.id, result);
          }
        });

        await adapter.connect();
      } else if (options.adapter === 'slack') {
        if (!secret) {
          console.error('Slack signing secret required. Set OPENSLACK_SLACK_SIGNING_SECRET or use --secret');
          process.exit(1);
        }

        const botToken = process.env.OPENSLACK_SLACK_BOT_TOKEN;
        const allowedWorkspaces = process.env.OPENSLACK_CHAT_ALLOWED_WORKSPACE?.split(',') || undefined;

        const adapter = new SlackAdapter({
          port: Number(options.port),
          signingSecret: secret,
          botToken,
          allowedWorkspaces,
        });

        adapter.onMessage(async (message) => {
          const result = await routeMessage(message, config, {
            payload: JSON.stringify({
              text: message.text,
              user: message.user.id,
              channel: message.channel.id,
            }),
            signature: undefined,
          });

          console.log(`[${message.id}] ${message.user.id}: ${message.text}`);
          if (result.text) {
            console.log(`→ ${result.text.slice(0, 200)}${result.text.length > 200 ? '...' : ''}`);
            await adapter.send(message.channel.id, result);
          }
        });

        await adapter.connect();
      } else {
        console.error(`Unsupported adapter: ${options.adapter}`);
        console.error('Supported: webhook, slack');
        process.exit(1);
      }

      console.log(`Chat Gateway (${options.adapter}) running on port ${options.port}`);
      console.log('Press Ctrl+C to stop');
    });

  return cmd;
}

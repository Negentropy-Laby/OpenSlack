import { Command } from 'commander';
import { WebhookAdapter, routeMessage } from '@openslack/chat-gateway';
import type { GatewayConfig } from '@openslack/chat-gateway';

export function chatCommands(): Command {
  const cmd = new Command('chat').description('OpenSlack Chat Gateway');

  cmd
    .command('start')
    .description('Start the chat gateway adapter')
    .requiredOption('--adapter <type>', 'Adapter type (webhook)')
    .option('--port <number>', 'Port for webhook adapter', '3000')
    .option('--secret <string>', 'Webhook shared secret (env: OPENSLACK_WEBHOOK_SECRET)')
    .action(async (options: { adapter: string; port: string; secret?: string }) => {
      if (options.adapter !== 'webhook') {
        console.error(`Unsupported adapter: ${options.adapter}`);
        console.error('Supported: webhook');
        process.exit(1);
      }

      const secret = options.secret || process.env.OPENSLACK_WEBHOOK_SECRET;
      const config: GatewayConfig = {
        webhookSecret: secret,
        readOnlyByDefault: true,
      };

      const adapter = new WebhookAdapter({
        port: Number(options.port),
        secret,
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

      console.log(`Chat Gateway (${options.adapter}) running on port ${options.port}`);
      console.log('Press Ctrl+C to stop');
    });

  return cmd;
}

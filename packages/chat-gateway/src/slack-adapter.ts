import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ChatAdapter, ChatMessage, ChatResponse, ChatUser, ChatChannel } from './types.js';

interface SlackAdapterOptions {
  port: number;
  signingSecret: string;
  botToken?: string;
  allowedWorkspaces?: string[];
}

interface SlackEvent {
  type: string;
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  team?: string;
  actions?: Array<{ action_id: string; value: string; block_id: string }>;
  container?: { channel_id: string; thread_ts?: string };
  response_url?: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  const base = `v0:${timestamp}:${body}`;
  const expected = `v0=${createHmac('sha256', signingSecret).update(base).digest('hex')}`;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function extractMentionText(text: string, botUserId?: string): string {
  if (!botUserId) return text.trim();
  // Remove @bot mention
  const mention = new RegExp(`<@${botUserId}>\\s*`, 'g');
  return text.replace(mention, '').trim();
}

export class SlackAdapter implements ChatAdapter {
  readonly name = 'slack';
  private server?: ReturnType<typeof createServer>;
  private handlers: Array<(msg: ChatMessage) => void> = [];
  private options: SlackAdapterOptions;

  constructor(options: SlackAdapterOptions) {
    this.options = options;
  }

  connect(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer(async (req, res) => {
        await this.handleRequest(req, res);
      });

      this.server.listen(this.options.port, () => {
        console.log(`Slack adapter listening on port ${this.options.port}`);
        resolve();
      });
    });
  }

  disconnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async send(channelId: string, message: ChatResponse): Promise<void> {
    if (!this.options.botToken) {
      console.error('Slack bot token not configured');
      return;
    }

    const payload: Record<string, unknown> = {
      channel: channelId,
      text: message.text,
    };

    if (message.blocks) {
      payload.blocks = message.blocks;
    }

    try {
      const resp = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.options.botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        console.error(`Slack API error: ${resp.status} ${resp.statusText}`);
      }
    } catch (err) {
      console.error('Failed to send Slack message:', err);
    }
  }

  onMessage(handler: (msg: ChatMessage) => void): void {
    this.handlers.push(handler);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Failed to read body' }));
      return;
    }

    // Verify Slack signature
    const timestamp = req.headers['x-slack-request-timestamp'] as string | undefined;
    const signature = req.headers['x-slack-signature'] as string | undefined;

    if (!timestamp || !signature) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Missing Slack signature headers' }));
      return;
    }

    // Reject requests older than 5 minutes (replay protection)
    const now = Math.floor(Date.now() / 1000);
    const reqTime = Number(timestamp);
    if (Number.isNaN(reqTime) || now - reqTime > 300) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Request too old' }));
      return;
    }

    const valid = verifySlackSignature(this.options.signingSecret, timestamp, body, signature);
    if (!valid) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Invalid Slack signature' }));
      return;
    }

    let payload: Record<string, unknown>;
    const contentType = req.headers['content-type'] || '';

    try {
      if (contentType.startsWith('application/x-www-form-urlencoded')) {
        const params = new URLSearchParams(body);
        const payloadStr = params.get('payload');
        if (!payloadStr) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing payload field in form data' }));
          return;
        }
        payload = JSON.parse(payloadStr);
      } else {
        payload = JSON.parse(body);
      }
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    // URL verification challenge (Slack app setup)
    if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
      res.writeHead(200);
      res.end(JSON.stringify({ challenge: payload.challenge }));
      return;
    }

    // Handle events
    const event = payload.event as SlackEvent | undefined;
    if (event) {
      await this.handleSlackEvent(event, payload);
    }

    // Handle block actions (button clicks)
    if (payload.type === 'block_actions') {
      await this.handleBlockActions(payload as Record<string, unknown>);
    }

    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
  }

  private async handleSlackEvent(event: SlackEvent, payload: Record<string, unknown>): Promise<void> {
    // Skip bot messages
    if ((payload as Record<string, unknown>).bot_id) return;
    if (event.user && event.user.startsWith('B')) return;

    // Workspace restriction
    const team = event.team || (payload.team_id as string);
    if (this.options.allowedWorkspaces?.length && !this.options.allowedWorkspaces.includes(team)) {
      console.log(`Blocked workspace: ${team}`);
      return;
    }

    // Only process app_mention and direct messages
    if (event.type !== 'app_mention' && event.type !== 'message') return;

    // Ignore message subtypes (edits, deletions)
    if ((payload as Record<string, unknown>).subtype) return;

    const text = extractMentionText(event.text || '', undefined);
    if (!text) return;

    const message: ChatMessage = {
      id: event.ts || `${Date.now()}`,
      text,
      user: { id: event.user || 'unknown', name: undefined },
      channel: { id: event.channel || 'unknown', type: event.type === 'app_mention' ? 'channel' : 'dm' },
      threadId: event.thread_ts,
      timestamp: new Date().toISOString(),
    };

    for (const handler of this.handlers) {
      handler(message);
    }
  }

  private async handleBlockActions(payload: Record<string, unknown>): Promise<void> {
    const user = payload.user as { id: string } | undefined;
    const actions = payload.actions as Array<{ action_id: string; value: string }> | undefined;
    const container = payload.container as { channel_id: string; thread_ts?: string } | undefined;

    if (!actions?.length || !container) return;

    const action = actions[0];
    const message: ChatMessage = {
      id: `${Date.now()}`,
      text: `action:${action.action_id}:${action.value}`,
      user: { id: user?.id || 'unknown' },
      channel: { id: container.channel_id, type: 'channel' },
      threadId: container.thread_ts,
      timestamp: new Date().toISOString(),
    };

    for (const handler of this.handlers) {
      handler(message);
    }
  }
}

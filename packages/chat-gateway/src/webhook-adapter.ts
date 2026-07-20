import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ChatAdapter, ChatMessage, ChatResponse, ChatUser, ChatChannel } from './types.js';

interface WebhookAdapterOptions {
  port: number;
  secret?: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export class WebhookAdapter implements ChatAdapter {
  readonly name = 'webhook';
  private server?: ReturnType<typeof createServer>;
  private handlers: Array<(msg: ChatMessage) => void | Promise<void>> = [];
  private responses: ChatResponse[] = [];
  private options: WebhookAdapterOptions;

  constructor(options: WebhookAdapterOptions) {
    this.options = options;
  }

  connect(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer(async (req, res) => {
        await this.handleRequest(req, res);
      });

      this.server.listen(this.options.port, () => {
        console.log(`Webhook adapter listening on port ${this.options.port}`);
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

  send(_channelId: string, response: ChatResponse): Promise<void> {
    this.responses.push(response);
    return Promise.resolve();
  }

  onMessage(handler: (msg: ChatMessage) => void | Promise<void>): void {
    this.handlers.push(handler);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-OpenSlack-Signature');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read body' }));
      return;
    }

    // Parse JSON payload
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    // Validate payload shape
    const p = payload as Record<string, unknown>;
    if (typeof p.text !== 'string' || typeof p.user !== 'string' || typeof p.channel !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required fields: text, user, channel' }));
      return;
    }

    const message: ChatMessage = {
      id: (p.id as string) || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      text: p.text,
      user: { id: p.user, name: (p.userName as string) || undefined },
      channel: { id: p.channel, name: (p.channelName as string) || undefined, type: 'webhook' },
      threadId: (p.threadId as string) || undefined,
      timestamp: new Date().toISOString(),
    };

    // Signature verification + replay protection
    const signature = req.headers['x-openslack-signature'] as string | undefined;
    const timestamp = req.headers['x-openslack-timestamp'] as string | undefined;

    if (this.options.secret) {
      const { verifyRequestSignature, verifyRequestTimestamp } = await import('./authz.js');

      if (!signature) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing X-OpenSlack-Signature header' }));
        return;
      }

      if (!verifyRequestTimestamp(timestamp)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request too old or missing timestamp' }));
        return;
      }

      if (!verifyRequestSignature(body, signature, this.options.secret)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid signature' }));
        return;
      }
    }

    // Reset responses and await all handlers
    this.responses = [];
    await Promise.all(this.handlers.map((h) => h(message)));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        messageId: message.id,
        responses: this.responses.map((r) => r.text),
      }),
    );
  }
}

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { SlackAdapter } from '../slack-adapter.js';

function signSlackRequest(signingSecret: string, timestamp: string, body: string): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${createHmac('sha256', signingSecret).update(base).digest('hex')}`;
}

describe('SlackAdapter', () => {
  it('has name "slack"', () => {
    const adapter = new SlackAdapter({ port: 9999, signingSecret: 'test' });
    expect(adapter.name).toBe('slack');
  });

  it('starts and stops', async () => {
    const adapter = new SlackAdapter({ port: 9998, signingSecret: 'test' });
    await adapter.connect();
    await adapter.disconnect();
  });

  it('receives messages via handler', () => {
    const adapter = new SlackAdapter({ port: 9997, signingSecret: 'test' });
    const messages: string[] = [];
    adapter.onMessage((msg) => {
      messages.push(msg.text);
    });
    // Handlers are registered; actual HTTP testing requires mock server
    expect(messages.length).toBe(0);
  });

  it('parses form-encoded block_actions payload', async () => {
    const port = 9996;
    const signingSecret = 'test-secret';
    const adapter = new SlackAdapter({ port, signingSecret });
    const received: Array<{ text: string; user: string; channel: string }> = [];

    adapter.onMessage((msg) => {
      received.push({ text: msg.text, user: msg.user.id, channel: msg.channel.id });
    });

    await adapter.connect();

    const payloadObj = {
      type: 'block_actions',
      user: { id: 'U123' },
      actions: [{ action_id: 'approve_merge', value: 'pr-42' }],
      container: { channel_id: 'C456', thread_ts: '1234567890.123456' },
      team: { id: 'T789' },
    };
    const body = `payload=${encodeURIComponent(JSON.stringify(payloadObj))}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signSlackRequest(signingSecret, timestamp, body);

    const resp = await fetch(`http://localhost:${port}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Slack-Request-Timestamp': timestamp,
        'X-Slack-Signature': signature,
      },
      body,
    });

    expect(resp.status).toBe(200);

    // Give handler a tick to fire
    await new Promise((r) => setTimeout(r, 50));

    expect(received.length).toBe(1);
    expect(received[0].text).toBe('action:approve_merge:pr-42');
    expect(received[0].user).toBe('U123');
    expect(received[0].channel).toBe('C456');

    await adapter.disconnect();
  });

  it('rejects form-encoded request missing payload field', async () => {
    const port = 9995;
    const signingSecret = 'test-secret';
    const adapter = new SlackAdapter({ port, signingSecret });
    await adapter.connect();

    const body = 'other_field=value';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signSlackRequest(signingSecret, timestamp, body);

    const resp = await fetch(`http://localhost:${port}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Slack-Request-Timestamp': timestamp,
        'X-Slack-Signature': signature,
      },
      body,
    });

    expect(resp.status).toBe(400);
    const data = (await resp.json()) as { error: string };
    expect(data.error).toBe('Missing payload field in form data');

    await adapter.disconnect();
  });
});

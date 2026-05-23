import { describe, it, expect } from 'vitest';
import { SlackAdapter } from '../slack-adapter.js';

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
});

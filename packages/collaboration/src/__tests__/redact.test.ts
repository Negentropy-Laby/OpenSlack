import { describe, it, expect } from 'vitest';
import { sanitizeEvent, getSecretPatterns } from '../redact.js';
import type { CollaborationEvent } from '../types.js';

describe('redact', () => {
  function makeEvent(partial: Partial<CollaborationEvent> = {}): CollaborationEvent {
    return {
      id: 'EV-20260524-TEST0001',
      schema: 'openslack.collaboration_event.v1',
      timestamp: new Date().toISOString(),
      type: 'pr.doctor.ready',
      actor: { id: 'test', kind: 'system' },
      object: { kind: 'pr', id: '42' },
      source: { kind: 'prms', ref: 'doctor' },
      summary: 'PR #42 is ready',
      visibility: 'local',
      redacted: false,
      containsSensitiveData: false,
      ...partial,
    } as CollaborationEvent;
  }

  it('allows safe events', () => {
    const event = makeEvent();
    const result = sanitizeEvent(event);
    expect(result.safe).toBe(true);
  });

  it('rejects events with Slack token in summary', () => {
    const token = 'xox' + 'b-1234567890-ABCDEFGHIJKLMNOPQRSTUVWX';
    const event = makeEvent({ summary: 'Token: ' + token });
    const result = sanitizeEvent(event);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('Slack token');
  });

  it('rejects events with GitHub token in summary', () => {
    const token = 'ghp_' + 'abcdef1234567890abcdef1234567890abcd';
    const event = makeEvent({ summary: 'Token: ' + token });
    const result = sanitizeEvent(event);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('GitHub token');
  });

  it('rejects events with private key in metadata', () => {
    const event = makeEvent({
      metadata: {
        key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQE...',
      },
    });
    const result = sanitizeEvent(event);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('Private key');
  });

  it('rejects events with AWS secret in metadata', () => {
    const event = makeEvent({
      metadata: {
        config: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
    });
    const result = sanitizeEvent(event);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('AWS secret');
  });

  it('rejects events with OpenSlack secret in metadata', () => {
    const event = makeEvent({
      metadata: {
        env: 'OPENSLACK_WEBHOOK_SECRET=shhh-do-not-share',
      },
    });
    const result = sanitizeEvent(event);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('OpenSlack secret');
  });

  it('rejects nested secrets in metadata', () => {
    const token = 'ghp_' + 'sneaky_token_here';
    const event = makeEvent({
      metadata: {
        nested: {
          deeper: {
            token,
          },
        },
      },
    });
    const result = sanitizeEvent(event);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('GitHub token');
  });

  it('rejects secrets in nextAction.command', () => {
    const token = 'ghp_' + 'badtoken123';
    const event = makeEvent({
      nextAction: {
        owner: 'test',
        action: 'run command',
        command: 'curl -H "Authorization: Bearer ' + token + '"',
      },
    });
    const result = sanitizeEvent(event);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('GitHub token');
  });

  it('allows safe metadata', () => {
    const event = makeEvent({
      metadata: {
        prNumber: 42,
        status: 'ready',
        labels: ['bugfix'],
      },
    });
    const result = sanitizeEvent(event);
    expect(result.safe).toBe(true);
  });

  it('exports secret patterns', () => {
    const patterns = getSecretPatterns();
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.some((p) => p.name === 'Slack token')).toBe(true);
    expect(patterns.some((p) => p.name === 'GitHub token')).toBe(true);
  });
});

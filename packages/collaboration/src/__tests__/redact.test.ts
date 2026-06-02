import { describe, it, expect } from 'vitest';
import { sanitizeEvent, getSecretPatterns, containsSecret, scanValue } from '../redact.js';
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

  // R1: Verify that removing /g flag fixes the lastIndex bug —
  // consecutive calls with the same pattern must both detect the secret.
  it('detects same pattern in consecutive calls to containsSecret', () => {
    const first = containsSecret('token: ghp_abcdef1234567890abcdef1234567890abcd');
    expect(first.found).toBe(true);

    // Second call with a different string containing the same pattern type
    const second = containsSecret('another: ghp_zyxwvut9876543210zyxwvut9876543210zyx');
    expect(second.found).toBe(true);
  });

  it('detects secrets after a previous match set lastIndex', () => {
    // First match at position 3 in a short string
    const first = containsSecret('a ghp_short0000 string');
    expect(first.found).toBe(true);

    // Second match at position 0 in a new string — must not be missed
    const second = containsSecret('ghp_atStart1111 of string');
    expect(second.found).toBe(true);
  });

  // M2: Circular reference guard — scanValue must not hang on circular objects
  it('does not hang on circular object references', () => {
    const circular: Record<string, unknown> = { key: 'safe value' };
    circular.self = circular;

    // Should return { found: false } without hanging
    const result = scanValue(circular, 'root');
    expect(result.found).toBe(false);
  });

  it('does not hang on deeply nested objects', () => {
    let obj: Record<string, unknown> = { deep: 'safe' };
    // Create a 20-level deep nesting — deeper than the depth limit of 10
    for (let i = 0; i < 20; i++) {
      obj = { child: obj };
    }

    const result = scanValue(obj, 'root');
    expect(result.found).toBe(false);
  });
});

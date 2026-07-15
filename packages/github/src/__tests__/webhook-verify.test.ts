import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyGitHubWebhookSignature } from '../webhook-verify.js';

describe('verifyGitHubWebhookSignature', () => {
  const secret = 'test-webhook-secret';
  const payload = '{"action":"opened","issue":{"number":42}}';

  function sign(payload: string, secret: string): string {
    return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  }

  it('accepts a valid signature', () => {
    const signature = sign(payload, secret);
    expect(verifyGitHubWebhookSignature(payload, signature, secret)).toBe(true);
  });

  it('verifies the exact raw bytes without UTF-8 replacement', () => {
    const raw = Buffer.from([0xff, 0x00, 0x7b, 0x7d]);
    const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

    expect(verifyGitHubWebhookSignature(raw, signature, secret)).toBe(true);
    expect(verifyGitHubWebhookSignature(raw.toString('utf8'), signature, secret)).toBe(false);
  });

  it('rejects an invalid signature', () => {
    expect(verifyGitHubWebhookSignature(payload, 'sha256=badsignature', secret)).toBe(false);
  });

  it('rejects missing signature header', () => {
    expect(verifyGitHubWebhookSignature(payload, undefined, secret)).toBe(false);
  });

  it('rejects when secret is empty', () => {
    const signature = sign(payload, secret);
    expect(verifyGitHubWebhookSignature(payload, signature, '')).toBe(false);
  });

  it('rejects wrong secret', () => {
    const signature = sign(payload, 'wrong-secret');
    expect(verifyGitHubWebhookSignature(payload, signature, secret)).toBe(false);
  });
});

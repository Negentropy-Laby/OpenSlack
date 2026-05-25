import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyGitHubWebhookSignature(
  payload: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!secret || !signatureHeader) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;

  if (signatureHeader.length !== expected.length) return false;

  try {
    return timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

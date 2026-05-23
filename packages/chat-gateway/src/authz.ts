import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ActorMapping, ChatMessage, GatewayConfig } from './types.js';

export function verifyRequestSignature(
  payload: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!secret || !signature) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function verifyRequestTimestamp(
  timestamp: string | undefined,
  maxAgeSeconds = 300,
): boolean {
  if (!timestamp) return false;
  const now = Math.floor(Date.now() / 1000);
  const reqTime = Number(timestamp);
  if (Number.isNaN(reqTime)) return false;
  return now - reqTime <= maxAgeSeconds;
}

export function mapActor(
  message: ChatMessage,
  mappings: ActorMapping[],
): { id: string; roles: string[] } | undefined {
  const mapped = mappings.find(
    (m) => m.providerUserId === message.user.id && m.provider === message.channel.type,
  );
  if (mapped) {
    return { id: mapped.openslackActorId, roles: mapped.roles };
  }
  return undefined;
}

export function canExecuteSideEffects(
  actor: { id: string; roles: string[] } | undefined,
  config: GatewayConfig,
): boolean {
  if (config.readOnlyByDefault) {
    // Mapped actors with 'write' role can execute side effects
    if (actor?.roles.includes('write')) return true;
    return false;
  }
  return true;
}

export function buildDefaultActor(message: ChatMessage): { id: string; provider: string } {
  return {
    id: `unmapped:${message.channel.type}:${message.user.id}`,
    provider: message.channel.type,
  };
}

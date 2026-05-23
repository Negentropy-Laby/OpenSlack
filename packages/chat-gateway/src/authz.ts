import { createHash, timingSafeEqual } from 'node:crypto';
import type { ActorMapping, ChatMessage, GatewayConfig } from './types.js';

function hmacSha256(secret: string, payload: string): string {
  return createHash('sha256').update(secret + payload).digest('hex');
}

export function verifyRequestSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  if (!secret || !signature) return false;
  const expected = `sha256=${hmacSha256(secret, payload)}`;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function mapActor(
  message: ChatMessage,
  mappings: ActorMapping[],
): { id: string; roles: string[] } | undefined {
  const key = `${message.user.id}@${message.channel.type}`;
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

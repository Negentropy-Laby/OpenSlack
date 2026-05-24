import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
  const provider = message.channel.type === 'webhook' ? 'webhook' : 'slack';
  const mapped = mappings.find(
    (m) => m.providerUserId === message.user.id && (m.provider === message.channel.type || m.provider === provider),
  );
  if (mapped) {
    return { id: mapped.openslackActorId, roles: mapped.roles };
  }
  return undefined;
}

function isActorMapping(value: unknown): value is ActorMapping {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.providerUserId === 'string' &&
    typeof item.provider === 'string' &&
    typeof item.openslackActorId === 'string' &&
    Array.isArray(item.roles) &&
    item.roles.every((role) => typeof role === 'string');
}

export function loadActorMappings(path: string | undefined): ActorMapping[] {
  if (!path || !existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (Array.isArray(parsed)) return parsed.filter(isActorMapping);
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { mappings?: unknown }).mappings)) {
      return (parsed as { mappings: unknown[] }).mappings.filter(isActorMapping);
    }
    return [];
  } catch {
    return [];
  }
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

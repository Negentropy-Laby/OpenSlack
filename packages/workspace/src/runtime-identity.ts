import { parse as parseYaml } from 'yaml';
import type { AgentRuntimeIdentity } from '@openslack/kernel';

const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const RUNTIME_PROVIDERS = new Set<AgentRuntimeIdentity['provider']>([
  'cli',
  'slack',
  'github',
  'webhook',
]);

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function validateRuntimeIdentity(value: unknown): AgentRuntimeIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (
    data.schema !== 'openslack.agent_runtime_identity.v1' ||
    typeof data.agent_id !== 'string' ||
    !SAFE_AGENT_ID.test(data.agent_id) ||
    typeof data.agent_uid !== 'string' ||
    !SAFE_RUNTIME_ID.test(data.agent_uid) ||
    typeof data.run_id !== 'string' ||
    !SAFE_RUNTIME_ID.test(data.run_id) ||
    typeof data.provider !== 'string' ||
    !RUNTIME_PROVIDERS.has(data.provider as AgentRuntimeIdentity['provider']) ||
    !canonicalTimestamp(data.started_at) ||
    !(
      data.public_key_jwk === null ||
      (typeof data.public_key_jwk === 'object' && !Array.isArray(data.public_key_jwk))
    ) ||
    !(data.key_id === null || typeof data.key_id === 'string') ||
    !(data.key_generated_at === null || canonicalTimestamp(data.key_generated_at))
  ) {
    return null;
  }
  if (data.authenticated_github_identity !== undefined) {
    const github = data.authenticated_github_identity;
    if (
      !github ||
      typeof github !== 'object' ||
      Array.isArray(github) ||
      typeof (github as Record<string, unknown>).login !== 'string' ||
      typeof (github as Record<string, unknown>).is_bot !== 'boolean'
    ) {
      return null;
    }
  }
  return data as unknown as AgentRuntimeIdentity;
}

export function parseRuntimeIdentityText(raw: string): AgentRuntimeIdentity | null {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 2 * 1024 * 1024) return null;
  try {
    return validateRuntimeIdentity(parseYaml(raw));
  } catch {
    return null;
  }
}

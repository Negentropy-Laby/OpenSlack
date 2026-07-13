import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const AGENT_RUNTIME_CONFIG_SCHEMA = 'openslack.agent_runtime.v1';

export function readRuntimeConfigForMerge(path: string): Record<string, unknown> {
  if (!existsSync(path)) return { schema: AGENT_RUNTIME_CONFIG_SCHEMA };
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  const record = readRecord(parsed);
  if (!record || containsRawSecretField(record)) throw new Error('unsafe runtime config');
  if (record.schema !== AGENT_RUNTIME_CONFIG_SCHEMA) {
    throw new Error(
      'runtime config schema migration required; run openslack setup migrate-state --apply',
    );
  }
  return record;
}

export function writeRuntimeConfigAtomic(path: string, value: Record<string, unknown>): void {
  if (value.schema !== AGENT_RUNTIME_CONFIG_SCHEMA) {
    throw new Error('runtime config must use openslack.agent_runtime.v1');
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const existingMode = existsSync(path) ? lstatSync(path).mode : undefined;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf-8',
      flag: 'wx',
    });
    if (existingMode !== undefined) chmodSync(temp, existingMode);
    renameSync(temp, path);
  } finally {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // Target publication is atomic; temp cleanup is best effort.
    }
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function containsRawSecretField(value: unknown, depth = 0): boolean {
  if (depth > 20 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsRawSecretField(item, depth + 1));
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const secretKey =
      key !== 'credentialRef' &&
      (normalized.endsWith('apikey') ||
        normalized.endsWith('token') ||
        normalized.endsWith('secret') ||
        normalized.endsWith('password') ||
        normalized.endsWith('privatekey') ||
        normalized === 'credential' ||
        normalized === 'credentials');
    return secretKey || containsRawSecretField(item, depth + 1);
  });
}

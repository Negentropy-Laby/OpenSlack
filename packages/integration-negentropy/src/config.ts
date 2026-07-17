import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';

const CONFIG_FIELDS = new Set(['endpoint', 'keyId', 'maxEvidenceAgeHours']);
const MAX_CONFIG_BYTES = 64 * 1024;

export interface NegentropyIntegrationConfig {
  readonly endpoint?: string;
  readonly keyId?: string;
  readonly maxEvidenceAgeHours: number;
}

export interface LoadNegentropyIntegrationConfigOptions {
  readonly workspaceRoot: string;
  readonly allowLoopbackHttp?: boolean;
}

export function negentropyConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.openslack', 'integrations', 'negentropy.yaml');
}

export function loadNegentropyIntegrationConfig(
  options: LoadNegentropyIntegrationConfigOptions,
): NegentropyIntegrationConfig {
  const path = negentropyConfigPath(options.workspaceRoot);
  assertContained(options.workspaceRoot, path);
  if (!existsSync(path)) return { maxEvidenceAgeHours: 168 };
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) {
    throw new Error('Negentropy integration config must be a bounded regular file.');
  }
  const parsed = parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Negentropy integration config must be a mapping.');
  }
  const record = parsed as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (!CONFIG_FIELDS.has(field)) throw new Error(`Unknown Negentropy config field: ${field}`);
  }
  const endpoint =
    record.endpoint === undefined
      ? undefined
      : validateEndpoint(record.endpoint, options.allowLoopbackHttp === true);
  const keyId =
    record.keyId === undefined ? undefined : requiredString(record.keyId, 'keyId', 256);
  const maxEvidenceAgeHours =
    record.maxEvidenceAgeHours === undefined
      ? 168
      : boundedInteger(record.maxEvidenceAgeHours, 'maxEvidenceAgeHours', 1, 720);
  return {
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(keyId === undefined ? {} : { keyId }),
    maxEvidenceAgeHours,
  };
}

function validateEndpoint(value: unknown, allowLoopbackHttp: boolean): string {
  const text = requiredString(value, 'endpoint', 2048);
  const url = new URL(text);
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(
    url.hostname.toLowerCase(),
  );
  if (url.protocol !== 'https:' && !(allowLoopbackHttp && loopback && url.protocol === 'http:')) {
    throw new Error('Negentropy endpoint must use HTTPS.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Negentropy endpoint must not contain credentials, query, or fragment.');
  }
  return url.toString().replace(/\/+$/u, '');
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`Negentropy ${field} must be a bounded non-empty string.`);
  }
  return value.trim();
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`Negentropy ${field} must be between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function assertContained(root: string, target: string): void {
  const relation = relative(resolve(root), resolve(target));
  if (relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..')) return;
  throw new Error('Negentropy integration config escapes the workspace.');
}

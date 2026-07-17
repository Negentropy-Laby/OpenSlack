import { createHash } from 'node:crypto';
import type { NegentropySlotContributionArtifactV1 } from './types.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_DEPTH = 64;
const MAX_KEYS = 20_000;

export function canonicalJson(value: unknown): string {
  let keys = 0;
  return encode(value, 0);

  function encode(item: unknown, depth: number): string {
    if (depth > MAX_DEPTH) throw new Error('Canonical JSON exceeds the depth limit.');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') {
      return JSON.stringify(item);
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Canonical JSON rejects non-finite numbers.');
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      return `[${item.map((entry) => encode(entry, depth + 1)).join(',')}]`;
    }
    if (!item || typeof item !== 'object') {
      throw new Error(`Canonical JSON rejects ${typeof item}.`);
    }
    const record = item as Record<string, unknown>;
    const names = Object.keys(record).sort();
    keys += names.length;
    if (keys > MAX_KEYS) throw new Error('Canonical JSON exceeds the key limit.');
    const encoded: string[] = [];
    for (const name of names) {
      if (FORBIDDEN_KEYS.has(name)) throw new Error(`Canonical JSON rejects key ${name}.`);
      if (record[name] === undefined) throw new Error('Canonical JSON rejects undefined values.');
      encoded.push(`${JSON.stringify(name)}:${encode(record[name], depth + 1)}`);
    }
    return `{${encoded.join(',')}}`;
  }
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function unsignedContribution(
  contribution: NegentropySlotContributionArtifactV1,
): NegentropySlotContributionArtifactV1 {
  const manifest = { ...contribution.manifest };
  delete manifest.signature;
  return {
    ...contribution,
    manifest,
  };
}

export function contributionArtifactHash(
  contribution: NegentropySlotContributionArtifactV1,
): string {
  return sha256Canonical(unsignedContribution(contribution));
}

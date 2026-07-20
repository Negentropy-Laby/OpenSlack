import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NegentropySchemaPin } from './types.js';

export const NEGENTROPY_SCHEMA_PIN = Object.freeze({
  repository: 'wsman/Negentropy-Lab',
  commit: '989c73a99ad5af94c6cad617bf34e2f400bafa9c',
  path: 'packages/core/src/slots/schema/negentropy.slot-contribution.v1.schema.json',
  sha256: '45ca9bec47d8427d59fee4a949a32677beba81a468193f0bed4c24a3381b1c1f',
  version: 'negentropy.slot-contribution.v1',
} as const satisfies NegentropySchemaPin);

export class NegentropySchemaPinError extends Error {
  readonly code = 'NEGENTROPY_SCHEMA_PIN_MISMATCH';
}

export function bundledNegentropySchemaBytes(): Buffer {
  const local = new URL('./schema/negentropy.slot-contribution.v1.schema.json', import.meta.url);
  if (existsSync(local)) return readFileSync(local);
  const installed = join(
    dirname(process.execPath),
    'assets',
    'product',
    'negentropy.slot-contribution.v1.schema.json',
  );
  return readFileSync(installed);
}

export function verifyNegentropySchemaPin(bytes = bundledNegentropySchemaBytes()): void {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== NEGENTROPY_SCHEMA_PIN.sha256) {
    throw new NegentropySchemaPinError(
      `Pinned Negentropy schema hash mismatch: expected ${NEGENTROPY_SCHEMA_PIN.sha256}, received ${actual}.`,
    );
  }
  const schema = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  if (
    schema.$id !==
    'https://schemas.negentropy.dev/slots/negentropy.slot-contribution.v1.schema.json'
  ) {
    throw new NegentropySchemaPinError('Pinned Negentropy schema identity is invalid.');
  }
}

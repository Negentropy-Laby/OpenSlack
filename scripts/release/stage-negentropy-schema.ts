import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const EXPECTED_SHA256 = 'd3220080e1200391f9d5c0b2e74df1306540d57ff922d0da4156b32675efffa2';
const root = resolve(import.meta.dirname, '..', '..');
const source = resolve(
  root,
  'packages',
  'integration-negentropy',
  'src',
  'schema',
  'negentropy.slot-contribution.v1.schema.json',
);
const destination = resolve(
  root,
  'packages',
  'integration-negentropy',
  'dist',
  'schema',
  'negentropy.slot-contribution.v1.schema.json',
);
const actual = createHash('sha256').update(readFileSync(source)).digest('hex');
if (actual !== EXPECTED_SHA256) {
  throw new Error(`Refusing to stage mismatched Negentropy schema: ${actual}`);
}
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);

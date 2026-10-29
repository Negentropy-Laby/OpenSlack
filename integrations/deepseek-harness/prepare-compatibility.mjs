/** Explicit, non-cleaning preparation. Vitest configuration never invokes this writer. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HARNESS_COMPATIBILITY_SHA, captureCompatibilityInputs, captureCompatibilityOutputs } from './compatibility-witness.mjs';
const root = resolve(import.meta.dirname, '../..');
if (process.env.OPENSLACK_BRIDGE_WIRE_MODULE !== undefined) throw new Error('Formal compatibility preparation rejects OPENSLACK_BRIDGE_WIRE_MODULE; overrides are only for isolated build fixtures.');
if (process.env.OPENSLACK_SCHEMA_STAGE_ROOT !== undefined) throw new Error('Formal compatibility preparation rejects OPENSLACK_SCHEMA_STAGE_ROOT; staging must target this exact checkout.');
const harness = process.env.DEEPSEEK_HARNESS_CHECKOUT;
if (!harness) throw new Error('Explicit compatibility preparation requires the built original Harness checkout.');
const head = spawnSync('git', ['-C', harness, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 30_000 });
if (head.status !== 0 || head.error) throw new Error('Original Harness Git identity could not be read; use its actual owning account or an explicitly scoped read-only Git configuration. No global configuration was changed.');
if (head.stdout.trim() !== HARNESS_COMPATIBILITY_SHA) throw new Error('Original Harness compatibility head drift.');
const before = captureCompatibilityInputs(root, harness);
for (const [command, args] of [
  ['node', [join(root, 'node_modules/typescript/bin/tsc'), '--build', '--force', '--pretty', 'false']],
  ['bun', [join(root, 'scripts/release/stage-schema-assets.ts')]],
  ['bun', [join(root, 'scripts/qualification/workflow-runner-bundle.ts'), 'build']],
  ['bun', [join(import.meta.dirname, 'build.mjs')]],
]) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0 || result.error) throw new Error('Explicit compatibility emission failed; no fresh witness was issued.');
}
const inputs = captureCompatibilityInputs(root, harness);
if (JSON.stringify(before) !== JSON.stringify(inputs)) throw new Error('Compatibility inputs changed during emission; preserve and prepare again after review.');
const outputs = captureCompatibilityOutputs(root), directory = join(import.meta.dirname, '.build');
mkdirSync(directory, { recursive: true });
const temporary = join(directory, `compatibility-witness.${randomUUID()}.tmp`);
writeFileSync(temporary, JSON.stringify({ schema: 'openslack.compatibility_witness.v1', harnessCommit: HARNESS_COMPATIBILITY_SHA, inputs, outputs }), { flag: 'wx' });
renameSync(temporary, join(directory, 'compatibility-witness.json'));
console.log('Fresh compatibility witness issued after actual OpenSlack and external-plugin emission.');

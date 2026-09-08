import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = 'packages/workflows/contracts/workflow-budget-authority/';
export function acceptedLedger(value) {
  if (
    !value ||
    value.schema !== 'openslack.workflow_budget_manifest_compatibility.v1' ||
    Object.keys(value).sort().join(',') !== 'accepted,current,schema' ||
    !Array.isArray(value.accepted) ||
    value.accepted.length < 2 ||
    value.accepted.some((v) => typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) ||
    new Set(value.accepted).size !== value.accepted.length ||
    value.current !== value.accepted.at(-1)
  )
    throw Error('Invalid budget compatibility history.');
  return value.accepted;
}
export async function verifyBudgetCompatibilityHistory(root, base) {
  if (!/^[0-9a-f]{40}$/.test(base ?? ''))
    throw Error('An exact PR target base commit is required.');
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const priorFile = (path) =>
    git('ls-tree', '--name-only', base, '--', path).trim()
      ? git('show', `${base}:${path}`)
      : undefined;
  const ledger = JSON.parse(
    await readFile(resolve(root, directory + 'compatibility.json'), 'utf8'),
  );
  const history = JSON.parse(
    await readFile(resolve(root, directory + 'compatibility-history.json'), 'utf8'),
  );
  const accepted = acceptedLedger(ledger);
  if (JSON.stringify(accepted) !== JSON.stringify(acceptedLedger(history)))
    throw Error('Ledger and reviewed history differ.');
  const previous = priorFile(directory + 'compatibility.json');
  let required;
  if (previous !== undefined) {
    required = acceptedLedger(JSON.parse(previous));
    const priorHistory = priorFile(directory + 'compatibility-history.json');
    if (
      priorHistory !== undefined &&
      JSON.stringify(required) !== JSON.stringify(acceptedLedger(JSON.parse(priorHistory)))
    )
      throw Error('PR base ledger and history differ.');
  } else {
    // First migration only: recover acceptance from reviewed pre-ledger source and exact manifest bytes.
    const source = priorFile('packages/workflows/src/workflow-budget-authority-contract.ts');
    const original = /WORKFLOW_BUDGET_PREVIOUS_MANIFEST_SHA256\s*=\s*'([0-9a-f]{64})'/.exec(
      source ?? '',
    )?.[1];
    const manifest = priorFile(directory + 'v1/manifest.json');
    if (!original || !manifest) throw Error('Missing reviewed bootstrap compatibility evidence.');
    required = [original, createHash('sha256').update(manifest).digest('hex')];
  }
  if (required.some((hash, i) => accepted[i] !== hash))
    throw Error('Removed or reordered manifest from the PR target base.');
  return accepted.length;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== '--base')
    throw Error('Usage: verify-budget-compatibility-history.mjs --base <commit>');
  console.log(
    `Budget compatibility history verified (${await verifyBudgetCompatibilityHistory(process.cwd(), process.argv[3])} digests).`,
  );
}

import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_BUDGET_CURRENT_MANIFEST_SHA256,
  WORKFLOW_BUDGET_ACCEPTED_MANIFEST_SHA256,
  isAcceptedWorkflowBudgetManifest,
} from '../internal/workflow-budget-compatibility.generated.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const script = resolve(root, 'scripts/workflow-budget-authority-contracts/compatibility.ts');
const {
  rotateBudgetManifestCompatibility,
  synchronizeBudgetCompatibility,
  validateBudgetManifestCompatibility,
} = await import(/* @vite-ignore */ script);
const ledgerPath = 'packages/workflows/contracts/workflow-budget-authority/compatibility.json';
const tsPath = 'packages/workflows/src/internal/workflow-budget-compatibility.generated.ts';
const goPath = 'services/workflow-control/budgetcontract/compatibility_generated.go';
const apiPath = 'services/workflow-control/docs/api/budget-authority-openapi.yaml';
const ledger = async () =>
  validateBudgetManifestCompatibility(
    JSON.parse(await readFile(resolve(root, ledgerPath), 'utf8')),
  );

describe('append-only budget manifest compatibility', () => {
  it('accepts every recorded manifest and rejects unknown digests', async () => {
    const value = await ledger();
    expect(value.accepted).toEqual(WORKFLOW_BUDGET_ACCEPTED_MANIFEST_SHA256);
    expect(value.current).toBe(WORKFLOW_BUDGET_CURRENT_MANIFEST_SHA256);
    for (const hash of value.accepted) expect(isAcceptedWorkflowBudgetManifest(hash)).toBe(true);
    for (const hash of ['0'.repeat(64), value.current.toUpperCase(), '', null])
      expect(isAcceptedWorkflowBudgetManifest(hash)).toBe(false);
  });

  it('rotates without deleting historical entries and is idempotent for the current digest', async () => {
    const original = await ledger();
    const rotated = rotateBudgetManifestCompatibility(original, 'a'.repeat(64));
    expect(rotated.accepted).toEqual([...original.accepted, 'a'.repeat(64)]);
    expect(rotateBudgetManifestCompatibility(rotated, rotated.current)).toBe(rotated);
    for (const bad of [
      original.accepted.slice(1),
      [...original.accepted].reverse(),
      [...original.accepted, original.current],
    ]) {
      expect(() =>
        validateBudgetManifestCompatibility({ ...original, accepted: bad }, original.accepted),
      ).toThrow();
    }
  });

  it('projects a rotation into all consumers, detects drift, and refuses dropped compatibility', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'openslack-compatibility-'));
    try {
      for (const path of [ledgerPath, tsPath, apiPath]) {
        await mkdir(resolve(temporary, path, '..'), { recursive: true });
        await writeFile(resolve(temporary, path), await readFile(resolve(root, path)));
      }
      const original = await ledger();
      const rotated = rotateBudgetManifestCompatibility(original, 'a'.repeat(64));
      await writeFile(resolve(temporary, ledgerPath), JSON.stringify(rotated));
      await synchronizeBudgetCompatibility(temporary, rotated.current, false);
      const first = await Promise.all(
        [tsPath, goPath, apiPath].map((path) => readFile(resolve(temporary, path), 'utf8')),
      );
      for (const hash of rotated.accepted)
        for (const output of first) expect(output).toContain(hash);
      await synchronizeBudgetCompatibility(temporary, rotated.current, true);
      await synchronizeBudgetCompatibility(temporary, rotated.current, false);
      expect(
        await Promise.all(
          [tsPath, goPath, apiPath].map((path) => readFile(resolve(temporary, path), 'utf8')),
        ),
      ).toEqual(first);
      await writeFile(resolve(temporary, ledgerPath), JSON.stringify(original));
      await expect(
        synchronizeBudgetCompatibility(temporary, original.current, false),
      ).rejects.toThrow('removed/reordered');
      await writeFile(resolve(temporary, tsPath), '// unreadable acceptance set');
      await expect(
        synchronizeBudgetCompatibility(temporary, original.current, false),
      ).rejects.toThrow('no readable acceptance set');
    } finally {
      // Only this newly created temporary fixture is removed.
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

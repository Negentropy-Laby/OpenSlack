import { execFileSync } from 'node:child_process';
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
const historyPath =
  'packages/workflows/contracts/workflow-budget-authority/compatibility-history.json';
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
      for (const path of [ledgerPath, historyPath, tsPath, apiPath]) {
        await mkdir(resolve(temporary, path, '..'), { recursive: true });
        await writeFile(resolve(temporary, path), await readFile(resolve(root, path)));
      }
      const original = await ledger();
      let rotated = original;
      for (const digit of ['a', 'b', 'c']) {
        const previous = rotated.current;
        rotated = rotateBudgetManifestCompatibility(rotated, digit.repeat(64));
        await writeFile(resolve(temporary, ledgerPath), JSON.stringify(rotated));
        await writeFile(resolve(temporary, historyPath), JSON.stringify(rotated));
        await synchronizeBudgetCompatibility(temporary, rotated.current, false);
        expect(await readFile(resolve(temporary, goPath), 'utf8')).toContain(
          'PreviousManifestSHA256 = "' + previous + '"',
        );
        expect(rotateBudgetManifestCompatibility(rotated, rotated.current)).toBe(rotated);
      }
      await writeFile(resolve(temporary, ledgerPath), JSON.stringify(rotated));
      await writeFile(resolve(temporary, historyPath), JSON.stringify(rotated));
      await synchronizeBudgetCompatibility(temporary, rotated.current, false);
      const first = await Promise.all(
        [tsPath, goPath, apiPath].map((path) => readFile(resolve(temporary, path), 'utf8')),
      );
      expect(first[0]).toMatch(new RegExp("PREVIOUS_MANIFEST_SHA256 =\\s*'" + 'b'.repeat(64)));
      expect(first[1]).toContain('PreviousManifestSHA256 = "' + 'b'.repeat(64) + '"');
      expect(first[1]).toContain('OriginalManifestSHA256 = "' + original.accepted[0] + '"');
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
      await rm(resolve(temporary, tsPath));
      await expect(
        synchronizeBudgetCompatibility(temporary, original.current, false),
      ).rejects.toThrow('removed/reordered');
      await writeFile(resolve(temporary, ledgerPath), JSON.stringify(rotated));
      await synchronizeBudgetCompatibility(temporary, rotated.current, false);
      await rm(resolve(temporary, historyPath));
      await expect(
        synchronizeBudgetCompatibility(temporary, rotated.current, false),
      ).rejects.toThrow();
    } finally {
      // Only this newly created temporary fixture is removed.
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

it('rejects deleting ledger and history together against the reviewed Git base', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'openslack-history-base-'));
  const { verifyBudgetCompatibilityHistory } = await import(
    /* @vite-ignore */ resolve(root, 'scripts/verify-budget-compatibility-history.mjs')
  );
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: temporary,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  try {
    git('init');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    const original = await ledger();
    const prior = rotateBudgetManifestCompatibility(original, 'a'.repeat(64));
    for (const path of [ledgerPath, historyPath]) {
      await mkdir(resolve(temporary, path, '..'), { recursive: true });
      await writeFile(resolve(temporary, path), JSON.stringify(prior));
    }
    git('add', '.');
    git('commit', '-m', 'fixture reviewed acceptance');
    const base = git('rev-parse', 'HEAD');
    await expect(verifyBudgetCompatibilityHistory(temporary, base)).resolves.toBe(3);
    for (const path of [ledgerPath, historyPath])
      await writeFile(resolve(temporary, path), JSON.stringify(original));
    await expect(verifyBudgetCompatibilityHistory(temporary, base)).rejects.toThrow(
      'Removed or reordered',
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
it('rejects conflicting staged inputs before emitting projections', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'openslack-history-output-'));
  try {
    const altered = rotateBudgetManifestCompatibility(await ledger(), 'a'.repeat(64));
    await mkdir(resolve(temporary, ledgerPath, '..'), { recursive: true });
    await writeFile(resolve(temporary, ledgerPath), JSON.stringify(altered));
    await expect(
      synchronizeBudgetCompatibility(
        root,
        WORKFLOW_BUDGET_CURRENT_MANIFEST_SHA256,
        false,
        temporary,
      ),
    ).rejects.toThrow('conflicting');
    await expect(readFile(resolve(temporary, tsPath))).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(resolve(temporary, ledgerPath));
    await synchronizeBudgetCompatibility(
      root,
      WORKFLOW_BUDGET_CURRENT_MANIFEST_SHA256,
      false,
      temporary,
    );
    expect(await readFile(resolve(temporary, tsPath), 'utf8')).toContain(
      WORKFLOW_BUDGET_CURRENT_MANIFEST_SHA256,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

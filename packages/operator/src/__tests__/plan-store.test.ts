import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { parseIntent } from '../intent.js';
import { planActions } from '../planner.js';
import {
  listPendingPlans,
  loadPendingPlan,
  resumePendingPlan,
  savePendingPlan,
  updatePendingPlanState,
} from '../plan-store.js';

function makeRoot(): string {
  return join(
    tmpdir(),
    `openslack-operator-plans-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

describe('operator plan store', () => {
  it('saves, lists, loads, and cancels a pending plan', () => {
    const root = makeRoot();
    mkdirSync(root, { recursive: true });
    try {
      const plan = planActions(parseIntent('merge PR #12'));
      const pending = savePendingPlan({ root, query: 'merge PR #12', plan });
      expect(loadPendingPlan(pending.planId, root)?.plan.goal).toBe('Merge PR #12');
      expect(listPendingPlans(root)).toHaveLength(1);
      expect(updatePendingPlanState(pending.planId, 'cancelled', root)?.state).toBe('cancelled');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resumes a clarification plan with supplied slots', () => {
    const root = makeRoot();
    mkdirSync(root, { recursive: true });
    try {
      const plan = planActions(parseIntent('merge PR'));
      const pending = savePendingPlan({ root, query: 'merge PR', plan });
      expect(pending.plan.missingParams.some((p) => p.name === 'prNumber')).toBe(true);

      const resumed = resumePendingPlan(pending.planId, { prNumber: 12 }, root);
      expect(resumed?.plan.missingParams).toHaveLength(0);
      expect(resumed?.plan.goal).toBe('Merge PR #12');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

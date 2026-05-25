import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionPlan, Intent } from './types.js';
import { planActions } from './planner.js';

export type PlanApprovalState = 'pending' | 'approved' | 'cancelled' | 'executed' | 'expired';

export interface PendingPlan {
  planId: string;
  query: string;
  plan: ActionPlan;
  state: PlanApprovalState;
  createdAt: string;
  expiresAt: string;
  actorId?: string;
  updatedAt?: string;
}

export const OPERATOR_PLAN_TTL_MS = 24 * 60 * 60 * 1000;

function getStoreDir(root = process.cwd()): string {
  const dir = join(root, '.openslack.local', 'operator', 'plans');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getPlanPath(planId: string, root = process.cwd()): string {
  return join(getStoreDir(root), `${planId}.json`);
}

export function generatePendingPlanId(now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `PLAN-${date}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

function refreshState(plan: PendingPlan, now = new Date()): PendingPlan {
  if (plan.state === 'pending' && new Date(plan.expiresAt) < now) {
    return { ...plan, state: 'expired', updatedAt: now.toISOString() };
  }
  return plan;
}

export function savePendingPlan(params: {
  query: string;
  plan: ActionPlan;
  actorId?: string;
  root?: string;
  state?: PlanApprovalState;
}): PendingPlan {
  const now = new Date();
  const pending: PendingPlan = {
    planId: generatePendingPlanId(now),
    query: params.query,
    plan: params.plan,
    state: params.state ?? 'pending',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + OPERATOR_PLAN_TTL_MS).toISOString(),
    actorId: params.actorId,
  };
  writeFileSync(getPlanPath(pending.planId, params.root), JSON.stringify(pending, null, 2), 'utf-8');
  return pending;
}

export function loadPendingPlan(planId: string, root = process.cwd()): PendingPlan | null {
  const path = getPlanPath(planId, root);
  if (!existsSync(path)) return null;
  try {
    const plan = refreshState(JSON.parse(readFileSync(path, 'utf-8')) as PendingPlan);
    if (plan.state === 'expired') writeFileSync(path, JSON.stringify(plan, null, 2), 'utf-8');
    return plan;
  } catch {
    return null;
  }
}

export function listPendingPlans(root = process.cwd()): PendingPlan[] {
  const dir = getStoreDir(root);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => loadPendingPlan(name.replace(/\.json$/, ''), root))
    .filter((plan): plan is PendingPlan => Boolean(plan))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function updatePendingPlanState(
  planId: string,
  state: PlanApprovalState,
  root = process.cwd(),
): PendingPlan | null {
  const plan = loadPendingPlan(planId, root);
  if (!plan) return null;
  const updated = { ...plan, state, updatedAt: new Date().toISOString() };
  writeFileSync(getPlanPath(planId, root), JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}

export function resumePendingPlan(
  planId: string,
  slotUpdates: Record<string, string | number | string[]>,
  root = process.cwd(),
): PendingPlan | null {
  const pending = loadPendingPlan(planId, root);
  if (!pending || pending.state !== 'pending') return null;
  const intent: Intent = {
    ...pending.plan.intent,
    slots: {
      ...pending.plan.intent.slots,
      ...slotUpdates,
    },
  };
  const plan = planActions(intent);
  const updated: PendingPlan = {
    ...pending,
    plan,
    state: 'pending',
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(getPlanPath(planId, root), JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}


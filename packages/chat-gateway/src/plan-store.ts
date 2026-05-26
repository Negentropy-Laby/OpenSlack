import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type ChatPlanAction =
  | 'confirm_merge' | 'show_doctor' | 'watch_pr' | 'cancel'
  | 'accept_handoff' | 'close_handoff'
  | 'record_decision'
  | 'execute_workflow'
  | 'approve_plan';

export interface PendingPlan {
  planId: string;
  actorId: string;
  channelId: string;
  threadId?: string;
  action: ChatPlanAction;
  value: string;
  riskLevel: 'none' | 'low' | 'medium' | 'high';
  agentId?: string;
  planHash: string;
  createdAt: string;
  expiresAt: string;
}

const PLAN_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getStoreDir(): string {
  const root = process.cwd();
  const dir = join(root, '.openslack.local', 'chat', 'plans');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function planPath(planId: string): string {
  return join(getStoreDir(), `${planId}.json`);
}

function hashPlan(plan: Omit<PendingPlan, 'planId' | 'planHash' | 'createdAt' | 'expiresAt'>): string {
  const data = JSON.stringify(plan);
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

export function generatePlanId(): string {
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = randomBytes(4).toString('hex').toUpperCase();
  return `PLAN-${ts}-${rand}`;
}

export function createPendingPlan(params: Omit<PendingPlan, 'planId' | 'planHash' | 'createdAt' | 'expiresAt'>): PendingPlan {
  const planId = generatePlanId();
  const planHash = hashPlan(params);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + PLAN_TTL_MS).toISOString();

  const plan: PendingPlan = {
    ...params,
    planId,
    planHash,
    createdAt,
    expiresAt,
  };

  const path = planPath(planId);
  writeFileSync(path, JSON.stringify(plan, null, 2), 'utf-8');
  return plan;
}

export function loadPendingPlan(planId: string): PendingPlan | null {
  const path = planPath(planId);
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as PendingPlan;
  } catch {
    return null;
  }
}

export function deletePendingPlan(planId: string): void {
  const path = planPath(planId);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

export function validatePlan(
  plan: PendingPlan,
  actorId: string,
  channelId: string,
  threadId?: string,
): { valid: boolean; reason?: string } {
  const now = new Date();
  const expiry = new Date(plan.expiresAt);

  if (now > expiry) {
    deletePendingPlan(plan.planId);
    return { valid: false, reason: 'Plan expired. Please request again.' };
  }

  if (plan.actorId !== actorId) {
    return { valid: false, reason: 'Plan was created by a different user.' };
  }

  if (plan.channelId !== channelId) {
    return { valid: false, reason: 'Plan was created in a different channel.' };
  }

  if (plan.threadId && plan.threadId !== threadId) {
    return { valid: false, reason: 'Plan was created in a different thread.' };
  }

  return { valid: true };
}

export function isActionAllowed(action: string): action is PendingPlan['action'] {
  return [
    'confirm_merge', 'show_doctor', 'watch_pr', 'cancel',
    'accept_handoff', 'close_handoff', 'record_decision',
    'execute_workflow', 'approve_plan',
  ].includes(action);
}

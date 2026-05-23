import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPendingPlan,
  loadPendingPlan,
  deletePendingPlan,
  validatePlan,
  generatePlanId,
  isActionAllowed,
} from '../plan-store.js';

describe('plan-store', () => {
  beforeEach(() => {
    // Clean up any leftover plans from previous tests
    const plan = createPendingPlan({
      actorId: 'test-cleanup',
      channelId: 'test-cleanup',
      action: 'cancel',
      value: 'test',
      riskLevel: 'low',
    });
    deletePendingPlan(plan.planId);
  });

  it('generates unique plan IDs', () => {
    const id1 = generatePlanId();
    const id2 = generatePlanId();
    expect(id1).toMatch(/^PLAN-\d{8}-[A-F0-9]{8}$/);
    expect(id1).not.toBe(id2);
  });

  it('creates and loads a pending plan', () => {
    const plan = createPendingPlan({
      actorId: 'U123',
      channelId: 'C456',
      threadId: 'T789',
      action: 'confirm_merge',
      value: '12',
      riskLevel: 'high',
    });

    expect(plan.planId).toMatch(/^PLAN-/);
    expect(plan.actorId).toBe('U123');
    expect(plan.channelId).toBe('C456');
    expect(plan.threadId).toBe('T789');
    expect(plan.action).toBe('confirm_merge');
    expect(plan.value).toBe('12');
    expect(plan.riskLevel).toBe('high');
    expect(plan.planHash).toBeDefined();
    expect(plan.createdAt).toBeDefined();
    expect(plan.expiresAt).toBeDefined();

    const loaded = loadPendingPlan(plan.planId);
    expect(loaded).not.toBeNull();
    expect(loaded?.actorId).toBe('U123');
  });

  it('deletes a pending plan', () => {
    const plan = createPendingPlan({
      actorId: 'U123',
      channelId: 'C456',
      action: 'cancel',
      value: 'test',
      riskLevel: 'low',
    });

    deletePendingPlan(plan.planId);
    const loaded = loadPendingPlan(plan.planId);
    expect(loaded).toBeNull();
  });

  it('validates matching actor and channel', () => {
    const plan = createPendingPlan({
      actorId: 'U123',
      channelId: 'C456',
      action: 'confirm_merge',
      value: '12',
      riskLevel: 'high',
    });

    const result = validatePlan(plan, 'U123', 'C456');
    expect(result.valid).toBe(true);
  });

  it('rejects different actor', () => {
    const plan = createPendingPlan({
      actorId: 'U123',
      channelId: 'C456',
      action: 'confirm_merge',
      value: '12',
      riskLevel: 'high',
    });

    const result = validatePlan(plan, 'U999', 'C456');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('different user');
  });

  it('rejects different channel', () => {
    const plan = createPendingPlan({
      actorId: 'U123',
      channelId: 'C456',
      action: 'confirm_merge',
      value: '12',
      riskLevel: 'high',
    });

    const result = validatePlan(plan, 'U123', 'C999');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('different channel');
  });

  it('rejects different thread', () => {
    const plan = createPendingPlan({
      actorId: 'U123',
      channelId: 'C456',
      threadId: 'T789',
      action: 'confirm_merge',
      value: '12',
      riskLevel: 'high',
    });

    const result = validatePlan(plan, 'U123', 'C456', 'T999');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('different thread');
  });

  it('rejects expired plans', () => {
    const plan = createPendingPlan({
      actorId: 'U123',
      channelId: 'C456',
      action: 'confirm_merge',
      value: '12',
      riskLevel: 'high',
    });

    // Manually expire the plan in memory and re-save
    const loaded = loadPendingPlan(plan.planId);
    if (loaded) {
      loaded.expiresAt = new Date(Date.now() - 1000).toISOString();
      const path = join(process.cwd(), '.openslack.local', 'chat', 'plans', `${plan.planId}.json`);
      writeFileSync(path, JSON.stringify(loaded, null, 2), 'utf-8');
    }

    // Pass the modified loaded plan to validatePlan
    const modifiedPlan = loadPendingPlan(plan.planId)!;
    const result = validatePlan(modifiedPlan, 'U123', 'C456');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expired');
  });

  it('allows action types', () => {
    expect(isActionAllowed('confirm_merge')).toBe(true);
    expect(isActionAllowed('show_doctor')).toBe(true);
    expect(isActionAllowed('watch_pr')).toBe(true);
    expect(isActionAllowed('cancel')).toBe(true);
    expect(isActionAllowed('invalid')).toBe(false);
  });
});

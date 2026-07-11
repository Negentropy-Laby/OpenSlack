import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OnboardingStore } from '../onboarding-store.js';
import type { OnboardingStateError } from '../onboarding-store.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('OnboardingStore', () => {
  it('persists intent before completion and does not repeat completed steps', () => {
    const store = createStore();
    let state = store.create('session-1');
    state = store.begin(state, 'workspace');
    state = store.load();
    expect(state.steps.find((step) => step.id === 'workspace')?.status).toBe('needs_reconcile');

    state = store.reconcile(state, 'workspace', 'completed', {
      summary: 'Workspace initialized',
      evidenceRefs: ['workspace://openslack.yaml'],
    });
    expect(store.nextActionable(state)?.id).toBe('provider');
    expect(() => store.begin(state, 'workspace')).toThrowError(
      expect.objectContaining({ code: 'ONBOARDING_STEP_INVALID' }),
    );
  });

  it('fails closed on corrupt state and rejects secret-shaped receipts', () => {
    const store = createStore();
    writeFileSync(store.path, '{bad json', 'utf-8');
    expect(() => store.load()).toThrowError(
      expect.objectContaining<Partial<OnboardingStateError>>({ code: 'ONBOARDING_STATE_INVALID' }),
    );

    const receiptStore = createStore();
    let state = receiptStore.create('session-2');
    state = receiptStore.begin(state, 'workspace');
    expect(() =>
      receiptStore.complete(state, 'workspace', {
        summary: 'stored private key',
        evidenceRefs: [],
      }),
    ).toThrowError(expect.objectContaining({ code: 'ONBOARDING_STEP_INVALID' }));
  });

  it('refuses to replace receipts and requires reconciliation before retry', () => {
    const store = createStore();
    let state = store.create('session-3');
    expect(() => store.create('replacement')).toThrowError(
      expect.objectContaining({ code: 'ONBOARDING_STATE_INVALID' }),
    );

    state = store.begin(state, 'github_app');
    state = store.load();
    expect(() => store.begin(state, 'github_app')).toThrowError(
      expect.objectContaining({ code: 'ONBOARDING_STEP_INVALID' }),
    );

    state = store.reconcile(state, 'github_app', 'retry');
    expect(state.steps.find((step) => step.id === 'github_app')?.status).toBe('pending');
    expect(store.begin(state, 'github_app').steps.find((step) => step.id === 'github_app')).toMatchObject({
      status: 'running',
      attempt: 2,
    });
  });
});

function createStore(): OnboardingStore {
  const root = mkdtempSync(join(tmpdir(), 'openslack-onboarding-'));
  roots.push(root);
  return new OnboardingStore(root, () => new Date('2026-07-11T00:00:00.000Z'));
}

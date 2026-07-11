import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OnboardingStateError, OnboardingStore } from '../onboarding-store.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('OnboardingStore', () => {
  it('persists intent before completion and does not repeat completed steps', () => {
    const store = createStore();
    let state = store.create('session-1');
    state = store.begin(state, 'workspace');
    expect(store.load().steps.find((step) => step.id === 'workspace')?.status).toBe(
      'needs_reconcile',
    );

    state = store.begin(store.load(), 'workspace');
    state = store.complete(state, 'workspace', {
      summary: 'Workspace initialized',
      evidenceRefs: ['workspace://openslack.yaml'],
    });
    expect(store.nextActionable(state)?.id).toBe('provider');
  });

  it('fails closed on corrupt state and rejects secret-shaped receipts', () => {
    const store = createStore();
    writeFileSync(store.path, '{bad json', 'utf-8');
    expect(() => store.load()).toThrowError(
      expect.objectContaining<Partial<OnboardingStateError>>({ code: 'ONBOARDING_STATE_INVALID' }),
    );

    let state = store.create('session-2');
    state = store.begin(state, 'workspace');
    expect(() =>
      store.complete(state, 'workspace', {
        summary: 'stored private key',
        evidenceRefs: [],
      }),
    ).toThrowError(expect.objectContaining({ code: 'ONBOARDING_STEP_INVALID' }));
  });
});

function createStore(): OnboardingStore {
  const root = mkdtempSync(join(tmpdir(), 'openslack-onboarding-'));
  roots.push(root);
  return new OnboardingStore(root, () => new Date('2026-07-11T00:00:00.000Z'));
}

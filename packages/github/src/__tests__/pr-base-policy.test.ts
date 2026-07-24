import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
}));

vi.mock('../client.js', () => ({
  getClient: mocks.getClient,
}));

import { createDraftPR } from '../pr.js';
import { createProfileSyncPR } from '../profile-sync.js';
import { assertCanonicalPRBase, CANONICAL_PR_BASE_REF } from '../pr-base-policy.js';
import type { PRBasePolicyError } from '../pr-base-policy.js';

describe('canonical PR base enforcement', () => {
  beforeEach(() => {
    mocks.getClient.mockReset();
  });

  it('accepts main', () => {
    expect(CANONICAL_PR_BASE_REF).toBe('main');
    expect(() => assertCanonicalPRBase('main')).not.toThrow();
  });

  it.each(['integration/notification-delivery-0.3', 'release/0.3', 'feature/topic'])(
    'rejects %s with the stable error code',
    (baseRef) => {
      expect(() => assertCanonicalPRBase(baseRef)).toThrow(
        expect.objectContaining<Partial<PRBasePolicyError>>({
          code: 'PR_BASE_FORBIDDEN',
          actualBaseRef: baseRef,
        }),
      );
    },
  );

  it('blocks the low-level draft PR API before client or network access', async () => {
    await expect(
      createDraftPR('agent/topic', 'release/0.3', 'title', 'body'),
    ).rejects.toMatchObject({ code: 'PR_BASE_FORBIDDEN' });
    expect(mocks.getClient).not.toHaveBeenCalled();
  });

  it('blocks Profile Sync before client or network access', async () => {
    await expect(
      createProfileSyncPR('acme', 'profile', 'agent/sync', 'title', 'body', 'feature/profile'),
    ).rejects.toMatchObject({ code: 'PR_BASE_FORBIDDEN' });
    expect(mocks.getClient).not.toHaveBeenCalled();
  });
});

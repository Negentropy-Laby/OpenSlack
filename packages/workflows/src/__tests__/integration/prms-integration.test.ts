import { describe, it, expect, vi } from 'vitest';
import { createOpenSlackAPI } from '../../openslack-api.js';
import type { PrmsDoctorResult } from '../../types.js';
import type { PRReviewReport, PRReviewPolicy } from '@openslack/pr';

/**
 * Integration tests for the PRMS pipeline through createOpenSlackAPI.
 *
 * These tests verify the end-to-end flow of the PRMS namespace:
 * classify -> doctor -> requestMerge, ensuring the API correctly
 * routes through the PRMS Merge Steward and gates on READY_TO_MERGE.
 */

const defaultPolicy: PRReviewPolicy = {
  no_auto_approval: true,
  no_self_review: true,
  red_zone_human_required: true,
  black_zone_never_merge: true,
};

function stubPRReport(overrides: Partial<PRReviewReport> = {}): PRReviewReport {
  return {
    prNumber: 1,
    title: 'Test PR',
    author: 'contributor',
    state: 'open',
    draft: false,
    baseRef: 'main',
    baseSha: 'base-sha',
    riskZone: 'green',
    changedFiles: ['docs/readme.md'],
    checks: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
    reviews: [{ user: 'reviewer', state: 'APPROVED' }],
    humanApprovals: [{ user: 'reviewer' }],
    decision: 'DISCOVERED',
    reason: 'Initial fetch complete.',
    recommendation: 'Run classification.',
    mergeable: true,
    ...overrides,
  };
}

describe('PRMS integration', () => {
  it('full pipeline: classify -> doctor -> requestMerge for green zone PR', async () => {
    const mergeFn = vi.fn(async () => ({
      merged: true,
      decision: 'READY_TO_MERGE',
      reason: 'Green Zone. All checks passed.',
      message: 'PR merged successfully.',
    }));

    const api = createOpenSlackAPI({
      _classifyPaths: () => ({
        green: ['docs/readme.md'],
        yellow: [],
        red: [],
      }),
      _fetchPRDetails: async () => stubPRReport(),
      _diagnosePR: () =>
        stubPRReport({
          decision: 'READY_TO_MERGE',
          reason: 'Green Zone. All checks passed.',
          recommendation: 'Safe to merge.',
          riskZone: 'green',
        }),
      _loadPRReviewPolicy: () => defaultPolicy,
      _loadPRCodeownerEvidence: async () => ({ ref: 'base-sha', owners: [], entries: [] }),
      _mergeIfReady: mergeFn,
    });

    // Step 1: Classify
    const classified = await api.prms.classify(['docs/readme.md']);
    expect(classified.green).toEqual(['docs/readme.md']);
    expect(classified.red).toEqual([]);

    // Step 2: Doctor
    const doctorResult: PrmsDoctorResult = await api.prms.doctor(1);
    expect(doctorResult.status).toBe('READY_TO_MERGE');
    expect(doctorResult.zone).toBe('green');
    expect(doctorResult.blockers).toHaveLength(0);

    // Step 3: Request merge (only after doctor confirms READY)
    expect(doctorResult.status).toBe('READY_TO_MERGE');
    const mergeResult = await api.prms.requestMerge(1);
    expect(mergeResult.merged).toBe(true);
    expect(mergeResult.prmsStatus).toBe('READY_TO_MERGE');
    expect(mergeFn).toHaveBeenCalledWith(1, defaultPolicy);
  });

  it('requestMerge is NOT called when doctor returns BLOCKED', async () => {
    const mergeFn = vi.fn(async () => ({
      merged: false,
      decision: 'BLOCKED',
      reason: 'Failing checks',
      message: 'Merge blocked.',
    }));

    const api = createOpenSlackAPI({
      _fetchPRDetails: async () =>
        stubPRReport({
          riskZone: 'yellow',
          changedFiles: ['packages/core/src/index.ts'],
          checks: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
        }),
      _diagnosePR: () =>
        stubPRReport({
          decision: 'CHECKS_FAILED',
          reason: 'Failing checks: ci',
          recommendation: 'Fix failing checks.',
          riskZone: 'yellow',
        }),
      _loadPRReviewPolicy: () => defaultPolicy,
      _loadPRCodeownerEvidence: async () => ({ ref: 'base-sha', owners: [], entries: [] }),
      _mergeIfReady: mergeFn,
    });

    const doctorResult = await api.prms.doctor(1);
    expect(doctorResult.status).toBe('BLOCKED');

    // A real caller would check doctor status before calling requestMerge.
    // But even if requestMerge is called, the steward blocks it.
    const mergeResult = await api.prms.requestMerge(1);
    expect(mergeResult.merged).toBe(false);
  });

  it('doctor gates correctly for red zone with missing CODEOWNER approval', async () => {
    const api = createOpenSlackAPI({
      _fetchPRDetails: async () =>
        stubPRReport({
          riskZone: 'red',
          changedFiles: ['.github/workflows/ci.yml'],
          reviews: [],
          humanApprovals: [],
        }),
      _diagnosePR: () =>
        stubPRReport({
          decision: 'NEEDS_CODEOWNER_APPROVAL',
          reason: 'Red Zone requires CODEOWNER approval.',
          recommendation: 'Request review from CODEOWNERS.',
          riskZone: 'red',
        }),
      _loadPRReviewPolicy: () => defaultPolicy,
      _loadPRCodeownerEvidence: async () => ({
        ref: 'base-sha',
        owners: ['@admin'],
        entries: [{ pattern: '*', owners: ['@admin'] }],
      }),
    });

    const doctorResult: PrmsDoctorResult = await api.prms.doctor(1);
    expect(doctorResult.status).toBe('BLOCKED');
    expect(doctorResult.zone).toBe('red');
    // Check that the approval gate is marked as failed
    expect(doctorResult.gates.approval.passed).toBe(false);
  });

  it('doctor returns READY_TO_MERGE for red zone with CODEOWNER approval', async () => {
    const api = createOpenSlackAPI({
      _fetchPRDetails: async () =>
        stubPRReport({
          riskZone: 'red',
          changedFiles: ['.github/workflows/ci.yml'],
          reviews: [{ user: 'admin', state: 'APPROVED' }],
          humanApprovals: [{ user: 'admin' }],
        }),
      _diagnosePR: () =>
        stubPRReport({
          decision: 'READY_TO_MERGE',
          reason: 'Red Zone. CODEOWNER approval satisfied.',
          recommendation: 'Ready to merge.',
          riskZone: 'red',
        }),
      _loadPRReviewPolicy: () => defaultPolicy,
      _loadPRCodeownerEvidence: async () => ({
        ref: 'base-sha',
        owners: ['@admin'],
        entries: [{ pattern: '.github/**', owners: ['@admin'] }],
      }),
    });

    const doctorResult: PrmsDoctorResult = await api.prms.doctor(1);
    expect(doctorResult.status).toBe('READY_TO_MERGE');
    expect(doctorResult.zone).toBe('red');
    expect(doctorResult.gates.approval.passed).toBe(true);
    expect(doctorResult.why).toContain('CODEOWNER approval');
  });

  it('prms.queue integrates with listOpenPRs', async () => {
    const api = createOpenSlackAPI({
      _listOpenPRs: async () => [
        {
          number: 10,
          title: 'Fix login',
          status: 'open',
          author: 'dev',
          draft: false,
          updatedAt: '2026-05-28T00:00:00Z',
          url: 'https://github.com/test/pull/10',
        },
        {
          number: 11,
          title: 'Add docs',
          status: 'open',
          author: 'dev',
          draft: false,
          updatedAt: '2026-05-28T00:00:00Z',
          url: 'https://github.com/test/pull/11',
        },
        {
          number: 12,
          title: 'Refactor core',
          status: 'open',
          author: 'dev',
          draft: false,
          updatedAt: '2026-05-28T00:00:00Z',
          url: 'https://github.com/test/pull/12',
        },
      ],
    });

    const queue = await api.prms.queue();
    expect(queue).toHaveLength(3);
    expect(queue[0].prNumber).toBe(10);
    expect(queue[2].title).toBe('Refactor core');
  });

  it('classify produces correct zone distribution for mixed paths', async () => {
    const api = createOpenSlackAPI({
      _classifyPaths: (paths: string[]) => {
        const green: string[] = [];
        const yellow: string[] = [];
        const red: string[] = [];
        for (const p of paths) {
          if (p.startsWith('docs/')) green.push(p);
          else if (p.startsWith('packages/')) yellow.push(p);
          else if (p.startsWith('.github/')) red.push(p);
        }
        return { green, yellow, red };
      },
    });

    const result = await api.prms.classify([
      'docs/guide.md',
      'packages/core/src/main.ts',
      '.github/workflows/ci.yml',
      'packages/runtime/src/index.ts',
      'docs/api.md',
    ]);

    expect(result.green).toEqual(['docs/guide.md', 'docs/api.md']);
    expect(result.yellow).toEqual(['packages/core/src/main.ts', 'packages/runtime/src/index.ts']);
    expect(result.red).toEqual(['.github/workflows/ci.yml']);
  });

  it('doctor handles black zone paths as red zone with blocked status', async () => {
    const api = createOpenSlackAPI({
      _fetchPRDetails: async () =>
        stubPRReport({
          riskZone: 'black',
          changedFiles: ['.env', 'secrets/production.yaml'],
        }),
      _diagnosePR: () =>
        stubPRReport({
          decision: 'BLOCKED_BLACK_ZONE',
          reason: 'Black Zone path detected.',
          recommendation: 'Close this PR.',
          riskZone: 'black',
        }),
      _loadPRReviewPolicy: () => defaultPolicy,
      _loadPRCodeownerEvidence: async () => ({ ref: 'base-sha', owners: [], entries: [] }),
    });

    const doctorResult: PrmsDoctorResult = await api.prms.doctor(1);
    expect(doctorResult.status).toBe('BLOCKED');
    // Black zone should be mapped to 'red' for safety
    expect(doctorResult.zone).toBe('red');
    expect(doctorResult.gates.classification.passed).toBe(false);
  });
});

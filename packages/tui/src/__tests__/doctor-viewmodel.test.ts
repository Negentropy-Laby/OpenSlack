import { describe, it, expect } from 'vitest';
import { mapDoctorToViewModel } from '../view-models/doctor.js';
import type { DoctorReportInput } from '../view-models/doctor.js';

function makeReport(overrides?: Partial<DoctorReportInput>): DoctorReportInput {
  return {
    prNumber: 42,
    title: 'Add TUI package',
    author: 'alice',
    state: 'open',
    draft: false,
    riskZone: 'green',
    checks: [
      { name: 'CI', status: 'completed', conclusion: 'success' },
      { name: 'Lint', status: 'completed', conclusion: 'success' },
    ],
    reviews: [
      { user: 'bob', state: 'APPROVED' },
      { user: 'alice', state: 'APPROVED' },
    ],
    humanApprovals: [{ user: 'bob' }],
    decision: 'READY_TO_MERGE',
    reason: 'All gates passed',
    recommendation: 'Merge when ready',
    mergeable: true,
    ...overrides,
  };
}

describe('mapDoctorToViewModel', () => {
  it('maps a passing PR report', () => {
    const model = mapDoctorToViewModel(makeReport());
    expect(model.prNumber).toBe(42);
    expect(model.title).toBe('Add TUI package');
    expect(model.author).toBe('alice');
    expect(model.decision).toBe('READY_TO_MERGE');
    expect(model.gates).toHaveLength(6);
    expect(model.gates.every((g) => g.status === 'PASS')).toBe(true);
    expect(model.checks).toHaveLength(2);
    expect(model.reviews).toHaveLength(2);
  });

  it('maps gates correctly for blocked PR', () => {
    const model = mapDoctorToViewModel(
      makeReport({
        draft: true,
        mergeable: false,
        riskZone: 'black',
        checks: [
          { name: 'CI', status: 'completed', conclusion: 'failure' },
          { name: 'Lint', status: 'in_progress', conclusion: null },
        ],
        reviews: [],
        humanApprovals: [],
        decision: 'BLOCKED_DRAFT',
      }),
    );
    const gateNames = model.gates.map((g) => g.name);
    expect(gateNames).toEqual(['Draft', 'State', 'Merge', 'Checks', 'Approvals', 'Risk']);
    expect(model.gates[0].status).toBe('FAIL'); // Draft
    expect(model.gates[2].status).toBe('FAIL'); // Merge
    expect(model.gates[3].status).toBe('WARN'); // Checks (pending)
    expect(model.gates[4].status).toBe('FAIL'); // Approvals
    expect(model.gates[5].status).toBe('FAIL'); // Risk black
  });

  it('sanitizes escape sequences from fields', () => {
    const model = mapDoctorToViewModel(
      makeReport({
        title: 'Bad\x1b[31m inject',
        reason: 'Reason\x1b[31m with escape',
      }),
    );
    expect(model.title).toBe('Bad inject');
    expect(model.reason).toBe('Reason with escape');
  });

  it('maps checks with correct status', () => {
    const model = mapDoctorToViewModel(
      makeReport({
        checks: [
          { name: 'CI', status: 'completed', conclusion: 'success' },
          { name: 'Lint', status: 'completed', conclusion: 'failure' },
          { name: 'Deploy', status: 'in_progress', conclusion: null },
        ],
      }),
    );
    expect(model.checks[0].status).toBe('PASS');
    expect(model.checks[1].status).toBe('FAIL');
    expect(model.checks[2].status).toBe('WARN');
  });

  it('treats neutral and skipped checks as PASS', () => {
    const model = mapDoctorToViewModel(
      makeReport({
        checks: [
          { name: 'CI', status: 'completed', conclusion: 'success' },
          { name: 'Optional', status: 'completed', conclusion: 'neutral' },
          { name: 'Skipped', status: 'completed', conclusion: 'skipped' },
        ],
      }),
    );
    expect(model.checks[0].status).toBe('PASS');
    expect(model.checks[1].status).toBe('PASS');
    expect(model.checks[2].status).toBe('PASS');
  });

  it('maps reviews using PRMS-filtered humanApprovals', () => {
    const model = mapDoctorToViewModel(
      makeReport({
        reviews: [
          { user: 'bob', state: 'APPROVED' },
          { user: 'alice', state: 'APPROVED' },
          { user: 'bot-app', state: 'APPROVED' },
          { user: 'charlie', state: 'CHANGES_REQUESTED' },
        ],
        humanApprovals: [{ user: 'bob' }],
      }),
    );
    expect(model.reviews[0].valid).toBe(true); // bob in humanApprovals
    expect(model.reviews[1].valid).toBe(false); // alice not in humanApprovals (is author)
    expect(model.reviews[2].valid).toBe(false); // bot-app not in humanApprovals
    expect(model.reviews[3].valid).toBe(false); // charlie not in humanApprovals
  });

  it('passes evidence through sanitization', () => {
    const model = mapDoctorToViewModel(makeReport(), ['Risk zone: green', 'Evil\x1b[31m evidence']);
    expect(model.evidence).toHaveLength(2);
    expect(model.evidence[1]).toBe('Evil evidence');
  });

  it('defaults compressed to false and profileSyncGate to undefined', () => {
    const model = mapDoctorToViewModel(makeReport());
    expect(model.compressed).toBe(false);
    expect(model.profileSyncGate).toBeUndefined();
  });

  it('accepts DoctorMapperOptions with profileSyncGate', () => {
    const model = mapDoctorToViewModel(makeReport(), {
      evidence: ['Profile sync check'],
      profileSyncGate: { passed: true, detail: 'All criteria passed' },
    });
    expect(model.evidence).toEqual(['Profile sync check']);
    expect(model.profileSyncGate).toEqual({ passed: true, detail: 'All criteria passed' });
    expect(model.compressed).toBe(false);
  });

  it('accepts profileSyncGate with failed status', () => {
    const model = mapDoctorToViewModel(makeReport(), {
      profileSyncGate: { passed: false, detail: 'Invalid marker: marker mismatch' },
    });
    expect(model.profileSyncGate?.passed).toBe(false);
    expect(model.profileSyncGate?.detail).toBe('Invalid marker: marker mismatch');
  });

  it('accepts plain evidence array (backward compatible)', () => {
    const model = mapDoctorToViewModel(makeReport(), ['evidence item']);
    expect(model.evidence).toEqual(['evidence item']);
    expect(model.profileSyncGate).toBeUndefined();
  });
});

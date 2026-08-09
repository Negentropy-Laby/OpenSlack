import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  QUALIFICATION_PROFILES,
  createQualificationPlan,
  qualificationRunPath,
  recordQualificationStep,
  verifyQualification,
} from '../lib.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openslack-qualification-'));
  roots.push(root);
  const correlationId = 'QUAL-20260809-ABCDEFGH';
  const testedCommit = 'a'.repeat(40);
  createQualificationPlan({
    workspaceRoot: root,
    correlationId,
    testedCommit,
    now: () => new Date('2026-08-09T00:00:00Z'),
  });
  return { root, workspaceRoot: root, correlationId, testedCommit };
}
function complete(profile: keyof typeof QUALIFICATION_PROFILES) {
  const value = fixture();
  for (const step of QUALIFICATION_PROFILES[profile])
    recordQualificationStep({
      workspaceRoot: value.root,
      correlationId: value.correlationId,
      testedCommit: value.testedCommit,
      step,
      status: 'PASS',
      environment: 'clean-host',
      evidenceRefs: ['github:Negentropy-Laby/OpenSlack/issues/369'],
      now: () => new Date('2026-08-09T01:00:00Z'),
    });
  return value;
}

describe('qualification capstone', () => {
  it('accepts a complete fresh profile', () => {
    const value = complete('notification');
    expect(
      verifyQualification({
        ...value,
        profiles: ['notification'],
        now: () => new Date('2026-08-09T02:00:00Z'),
      }).valid,
    ).toBe(true);
  });
  it('fails closed on missing, failed, and stale steps', () => {
    const missing = fixture();
    expect(
      verifyQualification({
        ...missing,
        profiles: ['plugin'],
        now: () => new Date('2026-08-09T02:00:00Z'),
      }).failures[0],
    ).toMatch(/^STEP_MISSING/);
    const failed = complete('plugin');
    recordQualificationStep({
      ...failed,
      step: 'plugin_isolation',
      status: 'FAIL',
      environment: 'clean-host',
      now: () => new Date('2026-08-09T01:00:00Z'),
    });
    expect(
      verifyQualification({
        ...failed,
        profiles: ['plugin'],
        now: () => new Date('2026-08-09T02:00:00Z'),
      }).failures,
    ).toContain('STEP_FAILED:plugin:plugin_isolation');
    const stale = complete('scenario');
    expect(
      verifyQualification({
        ...stale,
        profiles: ['scenario'],
        now: () => new Date('2026-10-09T02:00:00Z'),
      }).failures.some((failure) => failure.includes('STEP_STALE')),
    ).toBe(true);
  });
  it('rejects tested-commit drift, secrets, and illegal evidence refs', () => {
    const value = fixture();
    expect(() =>
      recordQualificationStep({
        ...value,
        testedCommit: 'b'.repeat(40),
        step: 'notification_px2',
        status: 'PASS',
        environment: 'clean-host',
      }),
    ).toThrow(/immutable/);
    expect(() =>
      recordQualificationStep({
        ...value,
        step: 'notification_px2',
        status: 'PASS',
        environment: 'clean-host',
        evidenceRefs: ['run:Authorization=Bearer-secret'],
      }),
    ).toThrow();
    expect(() =>
      recordQualificationStep({
        ...value,
        step: 'notification_px2',
        status: 'PASS',
        environment: 'clean-host',
        evidenceRefs: ['https://example.com'],
      }),
    ).toThrow();
  });
  it('rejects unknown fields and a concurrent lock', () => {
    const value = fixture();
    const path = qualificationRunPath(value.root, value.correlationId);
    const run = JSON.parse(readFileSync(path, 'utf8'));
    run.extra = true;
    writeFileSync(path, JSON.stringify(run));
    expect(() => verifyQualification({ ...value, profiles: ['notification'] })).toThrow(
      /Unexpected/,
    );
    const locked = fixture();
    const lock = join(
      dirname(qualificationRunPath(locked.root, locked.correlationId)),
      'record.lock',
    );
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, 'locked');
    expect(() =>
      recordQualificationStep({
        ...locked,
        step: 'notification_px2',
        status: 'PASS',
        environment: 'clean-host',
      }),
    ).toThrow();
  });
});

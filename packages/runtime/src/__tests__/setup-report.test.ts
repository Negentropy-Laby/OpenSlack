import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildSetupReport, detectGenesisShell, renderSetupReport, getNextSteps } from '../setup-report.js';

function makeRoot(): string {
  const root = join(tmpdir(), `openslack-setup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, '.github'), { recursive: true });
  mkdirSync(join(root, '.openslack'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'openslack.yaml'), 'schema: openslack.workspace.v1\n', 'utf-8');
  writeFileSync(join(root, '.github', 'CODEOWNERS'), '* @wsman\n', 'utf-8');
  writeFileSync(join(root, 'scripts', 'genesis-validate.sh'), '#!/usr/bin/env bash\n', 'utf-8');
  return root;
}

describe('setup report', () => {
  it('builds categorized findings without mutating setup state', async () => {
    const root = makeRoot();
    try {
      const report = await buildSetupReport({ root });
      expect(report.dryRun).toBe(true);
      expect(report.findings.some((f) => f.status === 'ok')).toBe(true);
      expect(report.findings.some((f) => f.status === 'requires_github_admin')).toBe(true);
      expect(renderSetupReport(report)).toContain('OpenSlack Setup Report');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports missing genesis shell support as a setup finding', () => {
    const root = makeRoot();
    try {
      const finding = detectGenesisShell(root);
      expect(finding.id).toBe('genesis-shell');
      expect(finding.status).toMatch(/ok|fixable_by_command/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('getNextSteps', () => {
  it('returns at least 5 next steps', () => {
    const steps = getNextSteps();
    expect(steps.length).toBeGreaterThanOrEqual(5);
  });

  it('returns steps with label, command, and description', () => {
    const steps = getNextSteps();
    for (const step of steps) {
      expect(typeof step.label).toBe('string');
      expect(step.label.length).toBeGreaterThan(0);
      expect(typeof step.command).toBe('string');
      expect(step.command.length).toBeGreaterThan(0);
      expect(typeof step.description).toBe('string');
      expect(step.description.length).toBeGreaterThan(0);
    }
  });

  it('includes a status check step', () => {
    const steps = getNextSteps();
    const statusStep = steps.find((s) => s.command.includes('status'));
    expect(statusStep).toBeDefined();
    expect(statusStep!.label).toMatch(/status/i);
  });

  it('includes a PR list step', () => {
    const steps = getNextSteps();
    const prStep = steps.find((s) => s.command.includes('pr list'));
    expect(prStep).toBeDefined();
  });

  it('includes a doctor step', () => {
    const steps = getNextSteps();
    const doctorStep = steps.find((s) => s.command.includes('doctor'));
    expect(doctorStep).toBeDefined();
  });

  it('all commands start with pnpm openslack', () => {
    const steps = getNextSteps();
    for (const step of steps) {
      expect(step.command).toMatch(/^pnpm openslack /);
    }
  });
});


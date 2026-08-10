import { describe, expect, it } from 'vitest';
import { previewTaskCreation } from '../task-create.js';

describe('previewTaskCreation', () => {
  it('generates a schema-valid task issue preview for each template', () => {
    const templates = [
      'bugfix',
      'docs',
      'test-fix',
      'refactor',
      'review',
      'investigation',
    ] as const;

    for (const template of templates) {
      const preview = previewTaskCreation({
        template,
        title: `Test ${template} task`,
      });

      expect(preview.errors).toEqual([]);
      expect(preview.issueTitle).toBe(`Test ${template} task`);
      expect(preview.body).toContain('```openslack-task');
      expect(preview.labels).toContain('openslack:task');
      expect(preview.labels).toContain('openslack:ready');
    }
  });

  it('rejects Black Zone paths before issue creation', () => {
    const preview = previewTaskCreation({
      template: 'bugfix',
      title: 'Bad task',
      allowedPaths: ['.env'],
    });

    expect(preview.errors.some((e) => e.includes('Black Zone'))).toBe(true);
  });

  it('requires human approval metadata for Red Zone paths', () => {
    const preview = previewTaskCreation({
      template: 'bugfix',
      title: 'Workflow task',
      allowedPaths: ['.github/workflows/ci.yml'],
    });

    expect(preview.errors.some((e) => e.includes('Red Zone'))).toBe(true);
  });

  it('accepts Red Zone paths when explicit human approval metadata is present', () => {
    const preview = previewTaskCreation({
      template: 'bugfix',
      title: 'Workflow task',
      allowedPaths: ['.github/workflows/ci.yml'],
      humanApprovalRequiredFor: ['red_zone_change'],
    });

    expect(preview.errors).toEqual([]);
    expect(preview.manifest.human_approval_required_for).toEqual(['red_zone_change']);
  });

  it('rejects an explicitly understated risk level', () => {
    const preview = previewTaskCreation({
      template: 'bugfix',
      title: 'Understated workflow task',
      allowedPaths: ['.github/workflows/ci.yml'],
      riskLevel: 'low',
      humanApprovalRequiredFor: ['red_zone_change'],
    });

    expect(preview.errors.some((error) => error.includes('understates'))).toBe(true);
  });

  it('rejects an unsupported agent routing type', () => {
    const preview = previewTaskCreation({
      template: 'docs',
      title: 'Unsupported route',
      agentType: 'qoder',
    });
    expect(preview.errors).toContain('Agent type is unsupported: qoder');
  });

  it('classifies a broad package scope as Red because it reaches protected packages', () => {
    const preview = previewTaskCreation({
      template: 'bugfix',
      title: 'Broad package task',
      allowedPaths: ['packages/**'],
      humanApprovalRequiredFor: ['red_zone_change'],
    });
    expect(preview.riskZone).toBe('red');
    expect(preview.manifest.risk_level).toBe('high');
  });
});

import { describe, expect, it } from 'vitest';
import { previewTaskCreation } from '../task-create.js';

describe('previewTaskCreation', () => {
  it('generates a schema-valid task issue preview for each template', () => {
    const templates = ['bugfix', 'docs', 'test-fix', 'refactor', 'review', 'investigation'] as const;

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
});


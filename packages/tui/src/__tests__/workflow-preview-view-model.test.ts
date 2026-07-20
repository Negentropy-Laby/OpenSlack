import { describe, it, expect } from 'vitest';
import { mapWorkflowPreviewToViewModel } from '../view-models/workflow-preview.js';
import type { WorkflowPreview } from '@openslack/collaboration';

function makePreview(overrides?: Partial<WorkflowPreview>): WorkflowPreview {
  return {
    templateId: 'deploy-workflow',
    name: 'Deploy Workflow',
    correlationId: 'WF-deploy-20260528-XYZ789',
    steps: [
      {
        phase: 'Build',
        type: 'action',
        title: 'Build project',
        actionId: 'build',
        sideEffects: false,
        requiresConfirmation: false,
      },
      {
        phase: 'Deploy',
        type: 'action',
        title: 'Deploy to staging',
        actionId: 'deploy',
        sideEffects: true,
        requiresConfirmation: true,
        requiredRole: 'admin',
      },
    ],
    errors: [],
    ...overrides,
  };
}

describe('mapWorkflowPreviewToViewModel', () => {
  it('maps basic fields correctly', () => {
    const model = mapWorkflowPreviewToViewModel(makePreview());
    expect(model.templateId).toBe('deploy-workflow');
    expect(model.name).toBe('Deploy Workflow');
    expect(model.correlationId).toBe('WF-deploy-20260528-XYZ789');
  });

  it('maps steps with all fields', () => {
    const model = mapWorkflowPreviewToViewModel(makePreview());
    expect(model.steps).toHaveLength(2);
    expect(model.steps[0].phase).toBe('Build');
    expect(model.steps[0].title).toBe('Build project');
    expect(model.steps[0].sideEffects).toBe(false);
    expect(model.steps[1].phase).toBe('Deploy');
    expect(model.steps[1].sideEffects).toBe(true);
    expect(model.steps[1].requiresConfirmation).toBe(true);
    expect(model.steps[1].requiredRole).toBe('admin');
  });

  it('extracts unique phases', () => {
    const model = mapWorkflowPreviewToViewModel(makePreview());
    expect(model.phases).toEqual(['Build', 'Deploy']);
    expect(model.phaseCount).toBe(2);
  });

  it('deduplicates phases', () => {
    const preview = makePreview({
      steps: [
        {
          phase: 'Build',
          type: 'action',
          title: 'Step 1',
          actionId: 'a',
          sideEffects: false,
          requiresConfirmation: false,
        },
        {
          phase: 'Build',
          type: 'action',
          title: 'Step 2',
          actionId: 'b',
          sideEffects: false,
          requiresConfirmation: false,
        },
        {
          phase: 'Test',
          type: 'action',
          title: 'Step 3',
          actionId: 'c',
          sideEffects: false,
          requiresConfirmation: false,
        },
      ],
    });
    const model = mapWorkflowPreviewToViewModel(preview);
    expect(model.phases).toEqual(['Build', 'Test']);
    expect(model.phaseCount).toBe(2);
    expect(model.stepCount).toBe(3);
  });

  it('computes hasSideEffects correctly', () => {
    const model1 = mapWorkflowPreviewToViewModel(makePreview());
    expect(model1.hasSideEffects).toBe(true);

    const model2 = mapWorkflowPreviewToViewModel(
      makePreview({
        steps: [
          {
            phase: 'Plan',
            type: 'action',
            title: 'Plan',
            actionId: 'plan',
            sideEffects: false,
            requiresConfirmation: false,
          },
        ],
      }),
    );
    expect(model2.hasSideEffects).toBe(false);
  });

  it('computes requiresConfirmation correctly', () => {
    const model1 = mapWorkflowPreviewToViewModel(makePreview());
    expect(model1.requiresConfirmation).toBe(true);

    const model2 = mapWorkflowPreviewToViewModel(
      makePreview({
        steps: [
          {
            phase: 'Plan',
            type: 'action',
            title: 'Plan',
            actionId: 'plan',
            sideEffects: false,
            requiresConfirmation: false,
          },
        ],
      }),
    );
    expect(model2.requiresConfirmation).toBe(false);
  });

  it('maps errors correctly', () => {
    const model = mapWorkflowPreviewToViewModel(
      makePreview({
        errors: ['Missing input: repo', 'Invalid step type'],
      }),
    );
    expect(model.errors).toEqual(['Missing input: repo', 'Invalid step type']);
    expect(model.hasErrors).toBe(true);
  });

  it('handles empty errors', () => {
    const model = mapWorkflowPreviewToViewModel(makePreview());
    expect(model.errors).toEqual([]);
    expect(model.hasErrors).toBe(false);
  });

  it('handles empty steps', () => {
    const model = mapWorkflowPreviewToViewModel(makePreview({ steps: [] }));
    expect(model.steps).toEqual([]);
    expect(model.phases).toEqual([]);
    expect(model.phaseCount).toBe(0);
    expect(model.stepCount).toBe(0);
    expect(model.hasSideEffects).toBe(false);
    expect(model.requiresConfirmation).toBe(false);
  });

  it('sanitizes text fields', () => {
    const preview = makePreview({
      templateId: 'test\x1b[31mworkflow',
      name: 'Bad\x00Name',
      correlationId: 'corr\x07id',
      steps: [
        {
          phase: 'Phase\x1b[0m',
          type: 'action',
          title: 'Title\x0b',
          actionId: 'act\x1b[31m',
          sideEffects: false,
          requiresConfirmation: false,
        },
      ],
      errors: ['Error\x1b[31mmsg'],
    });
    const model = mapWorkflowPreviewToViewModel(preview);
    expect(model.templateId).toBe('testworkflow');
    expect(model.name).toBe('BadName');
    expect(model.correlationId).toBe('corrid');
    expect(model.steps[0].phase).toBe('Phase');
    expect(model.steps[0].title).toBe('Title');
    expect(model.steps[0].actionId).toBe('act');
    expect(model.errors[0]).toBe('Errormsg');
  });

  it('handles steps without actionId', () => {
    const preview = makePreview({
      steps: [
        {
          phase: 'Review',
          type: 'decision-gate',
          title: 'Approval gate',
          sideEffects: false,
          requiresConfirmation: true,
          requiredRole: 'reviewer',
        },
      ],
    });
    const model = mapWorkflowPreviewToViewModel(preview);
    expect(model.steps[0].actionId).toBe('');
    expect(model.steps[0].requiredRole).toBe('reviewer');
  });

  it('handles steps without requiredRole', () => {
    const preview = makePreview({
      steps: [
        {
          phase: 'Run',
          type: 'action',
          title: 'Run task',
          actionId: 'run',
          sideEffects: true,
          requiresConfirmation: false,
        },
      ],
    });
    const model = mapWorkflowPreviewToViewModel(preview);
    expect(model.steps[0].requiredRole).toBe('');
  });
});

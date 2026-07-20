import { describe, it, expect } from 'vitest';
import { mapWorkflowPreviewToViewModel } from '../view-models/workflow-preview.js';
import type { WorkflowPreview } from '@openslack/collaboration';

// Tests for the render-workflow-preview module (mapper + export wiring)
// Since renderTui requires a real TTY, we test the mapper and module structure.

describe('renderWorkflowPreviewTui module wiring', () => {
  it('exports mapWorkflowPreviewToViewModel from view-models', async () => {
    const mod = await import('../view-models/workflow-preview.js');
    expect(typeof mod.mapWorkflowPreviewToViewModel).toBe('function');
  });

  it('exports WorkflowPreviewViewModel type (structural)', async () => {
    const mod = await import('../view-models/workflow-preview.js');
    // Type export check: ensure the module loaded without errors
    expect(mod).toBeDefined();
  });

  it('exports renderWorkflowPreviewTui from views', async () => {
    const mod = await import('../views/render-workflow-preview.js');
    expect(typeof mod.renderWorkflowPreviewTui).toBe('function');
  });

  it('exports WorkflowPreviewView from views', async () => {
    const mod = await import('../views/WorkflowPreviewView.js');
    expect(typeof mod.default).toBe('function');
  });

  it('index.ts exports renderWorkflowPreviewTui', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.renderWorkflowPreviewTui).toBe('function');
  });
});

describe('mapWorkflowPreviewToViewModel integration scenarios', () => {
  it('maps a realistic multi-phase workflow preview', () => {
    const preview: WorkflowPreview = {
      templateId: 'feature',
      name: 'Feature Development',
      correlationId: 'WF-feature-20260528-FEAT01',
      steps: [
        {
          phase: 'Research',
          type: 'action',
          title: 'Analyze codebase',
          actionId: 'analyze',
          sideEffects: false,
          requiresConfirmation: false,
        },
        {
          phase: 'Research',
          type: 'action',
          title: 'Identify affected modules',
          actionId: 'identify',
          sideEffects: false,
          requiresConfirmation: false,
        },
        {
          phase: 'Plan',
          type: 'action',
          title: 'Create implementation plan',
          actionId: 'plan',
          sideEffects: false,
          requiresConfirmation: false,
        },
        {
          phase: 'Plan',
          type: 'decision-gate',
          title: 'Approve plan',
          sideEffects: false,
          requiresConfirmation: true,
          requiredRole: 'human',
        },
        {
          phase: 'Execute',
          type: 'action',
          title: 'Implement changes',
          actionId: 'implement',
          sideEffects: true,
          requiresConfirmation: false,
        },
        {
          phase: 'Execute',
          type: 'action',
          title: 'Write tests',
          actionId: 'test',
          sideEffects: true,
          requiresConfirmation: false,
        },
        {
          phase: 'Review',
          type: 'handoff',
          title: 'Handoff to reviewer',
          sideEffects: true,
          requiresConfirmation: false,
        },
        {
          phase: 'Review',
          type: 'wait',
          title: 'Wait for review approval',
          sideEffects: false,
          requiresConfirmation: false,
        },
      ],
      errors: [],
    };

    const model = mapWorkflowPreviewToViewModel(preview);

    expect(model.templateId).toBe('feature');
    expect(model.name).toBe('Feature Development');
    expect(model.correlationId).toBe('WF-feature-20260528-FEAT01');
    expect(model.stepCount).toBe(8);
    expect(model.phases).toEqual(['Research', 'Plan', 'Execute', 'Review']);
    expect(model.phaseCount).toBe(4);
    expect(model.hasSideEffects).toBe(true);
    expect(model.requiresConfirmation).toBe(true);
    expect(model.hasErrors).toBe(false);
  });

  it('maps a preview with validation errors', () => {
    const preview: WorkflowPreview = {
      templateId: 'broken',
      name: 'Broken Workflow',
      correlationId: 'WF-broken-20260528-ERR01',
      steps: [],
      errors: [
        'Missing required input: repo',
        'Unknown action ID: invalid-action',
        'Phase has no steps',
      ],
    };

    const model = mapWorkflowPreviewToViewModel(preview);
    expect(model.hasErrors).toBe(true);
    expect(model.errors).toHaveLength(3);
    expect(model.stepCount).toBe(0);
    expect(model.phases).toEqual([]);
  });

  it('handles a single-phase read-only workflow', () => {
    const preview: WorkflowPreview = {
      templateId: 'audit',
      name: 'Audit Workflow',
      correlationId: 'WF-audit-20260528-AUD01',
      steps: [
        {
          phase: 'Audit',
          type: 'action',
          title: 'Scan dependencies',
          actionId: 'scan-deps',
          sideEffects: false,
          requiresConfirmation: false,
        },
        {
          phase: 'Audit',
          type: 'action',
          title: 'Check licenses',
          actionId: 'check-licenses',
          sideEffects: false,
          requiresConfirmation: false,
        },
        {
          phase: 'Audit',
          type: 'record-decision',
          title: 'Record audit findings',
          sideEffects: false,
          requiresConfirmation: false,
        },
      ],
      errors: [],
    };

    const model = mapWorkflowPreviewToViewModel(preview);
    expect(model.hasSideEffects).toBe(false);
    expect(model.requiresConfirmation).toBe(false);
    expect(model.phases).toEqual(['Audit']);
    expect(model.phaseCount).toBe(1);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { Writable } from 'stream';
import React from 'react';
import { render } from '@openslack/tui';
import { ThemeProvider } from '../design-system/ThemeProvider.js';
import { NavigationProvider } from '../navigation/context.js';
import WorkflowPreviewView from '../views/WorkflowPreviewView.js';
import type { WorkflowPreviewViewModel } from '../view-models/workflow-preview.js';
import WorkflowLifecycleView from '../views/WorkflowLifecycleView.js';
import type {
  WorkflowLifecycleViewModel,
  LifecycleStage,
} from '../view-models/workflow-lifecycle.js';
import { mapCanonicalStages } from '../view-models/workflow-lifecycle.js';

function makeModel(overrides?: Partial<WorkflowPreviewViewModel>): WorkflowPreviewViewModel {
  return {
    templateId: 'test-workflow',
    name: 'Test Workflow',
    correlationId: 'WF-test-20260528-ABC123',
    steps: [
      {
        phase: 'Setup',
        type: 'action',
        title: 'Run setup',
        actionId: 'setup-action',
        sideEffects: false,
        requiresConfirmation: false,
        requiredRole: '',
      },
      {
        phase: 'Execute',
        type: 'action',
        title: 'Execute task',
        actionId: 'exec-action',
        sideEffects: true,
        requiresConfirmation: true,
        requiredRole: 'admin',
      },
    ],
    phases: ['Setup', 'Execute'],
    phaseCount: 2,
    stepCount: 2,
    hasSideEffects: true,
    requiresConfirmation: true,
    errors: [],
    hasErrors: false,
    ...overrides,
  };
}

describe('WorkflowPreviewView', () => {
  let instance: { unmount: () => void } | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  async function renderView(model: WorkflowPreviewViewModel): Promise<string> {
    const chunks: string[] = [];
    const stdout = new Writable({
      write(chunk, _, cb) {
        chunks.push(String(chunk));
        cb();
      },
    }) as NodeJS.WriteStream;
    Object.defineProperties(stdout, {
      columns: { value: 80, configurable: true },
      rows: { value: 24, configurable: true },
      isTTY: { value: false, configurable: true },
    });

    instance = await render(
      React.createElement(
        ThemeProvider,
        { mode: 'dark' },
        React.createElement(WorkflowPreviewView, { model }),
      ),
      { stdout, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 150));
    return chunks.join('');
  }

  it('renders header with workflow name', async () => {
    const output = await renderView(makeModel());
    expect(output).toContain('Workflow: Test Workflow');
  });

  it('renders template ID and correlation ID', async () => {
    const output = await renderView(makeModel());
    expect(output).toContain('test-workflow');
    expect(output).toContain('WF-test-20260528-ABC123');
  });

  it('renders step count and phase count in summary', async () => {
    const output = await renderView(makeModel());
    expect(output).toContain('2 steps');
    expect(output).toContain('2 phases');
  });

  it('renders phase headers', async () => {
    const output = await renderView(makeModel());
    expect(output).toContain('Setup');
    expect(output).toContain('Execute');
  });

  it('renders step titles', async () => {
    const output = await renderView(makeModel());
    expect(output).toContain('Run setup');
    expect(output).toContain('Execute task');
  });

  it('renders side effects indicator', async () => {
    const output = await renderView(makeModel());
    expect(output).toContain('side effect');
  });

  it('renders confirmation indicator', async () => {
    const output = await renderView(makeModel());
    expect(output).toContain('confirmation');
  });

  it('renders role requirement', async () => {
    const output = await renderView(makeModel());
    expect(output).toContain('role:admin');
  });

  it('renders with empty steps without crashing', async () => {
    const output = await renderView(
      makeModel({
        steps: [],
        phases: [],
        phaseCount: 0,
        stepCount: 0,
        hasSideEffects: false,
        requiresConfirmation: false,
      }),
    );
    expect(output).toContain('Workflow: Test Workflow');
    expect(output).toContain('0 steps');
    expect(output).toContain('No steps');
  });

  it('renders with errors', async () => {
    const output = await renderView(
      makeModel({
        errors: ['Missing required input: repo', 'Invalid action ID'],
        hasErrors: true,
      }),
    );
    expect(output).toContain('Missing required input: repo');
    expect(output).toContain('Invalid action ID');
  });

  it('renders read-only badge when no side effects', async () => {
    const output = await renderView(
      makeModel({
        steps: [
          {
            phase: 'Plan',
            type: 'action',
            title: 'Preview plan',
            actionId: 'plan-action',
            sideEffects: false,
            requiresConfirmation: false,
            requiredRole: '',
          },
        ],
        phases: ['Plan'],
        phaseCount: 1,
        stepCount: 1,
        hasSideEffects: false,
        requiresConfirmation: false,
      }),
    );
    expect(output).toContain('Read-only');
  });

  it('renders exit keyboard shortcut in footer', async () => {
    const output = await renderView(makeModel());
    expect(output).toContain('q');
    expect(output).toContain('exit');
  });

  it('renders with single phase containing many steps', async () => {
    const steps = Array.from({ length: 5 }, (_, i) => ({
      phase: 'Build',
      type: 'action',
      title: `Step ${i + 1}`,
      actionId: `step-${i}`,
      sideEffects: false,
      requiresConfirmation: false,
      requiredRole: '',
    }));
    const output = await renderView(
      makeModel({
        steps,
        phases: ['Build'],
        phaseCount: 1,
        stepCount: 5,
        hasSideEffects: false,
        requiresConfirmation: false,
      }),
    );
    expect(output).toContain('5 steps');
    expect(output).toContain('1 phases');
    for (let i = 1; i <= 5; i++) {
      expect(output).toContain(`Step ${i}`);
    }
  });

  it('renders with decision-gate step type', async () => {
    const output = await renderView(
      makeModel({
        steps: [
          {
            phase: 'Review',
            type: 'decision-gate',
            title: 'Require human approval',
            actionId: '',
            sideEffects: false,
            requiresConfirmation: true,
            requiredRole: 'reviewer',
          },
        ],
        phases: ['Review'],
        phaseCount: 1,
        stepCount: 1,
        hasSideEffects: false,
        requiresConfirmation: true,
      }),
    );
    expect(output).toContain('Require human approval');
    expect(output).toContain('confirmation');
    expect(output).toContain('role:reviewer');
  });

  it('renders with handoff step type', async () => {
    const output = await renderView(
      makeModel({
        steps: [
          {
            phase: 'Handoff',
            type: 'handoff',
            title: 'Handoff from agent-1 to agent-2',
            actionId: '',
            sideEffects: true,
            requiresConfirmation: false,
            requiredRole: '',
          },
        ],
        phases: ['Handoff'],
        phaseCount: 1,
        stepCount: 1,
        hasSideEffects: true,
        requiresConfirmation: false,
      }),
    );
    expect(output).toContain('Handoff from agent-1 to agent-2');
  });

  it('renders with wait step type', async () => {
    const output = await renderView(
      makeModel({
        steps: [
          {
            phase: 'Wait',
            type: 'wait',
            title: 'Wait for CI',
            actionId: '',
            sideEffects: false,
            requiresConfirmation: false,
            requiredRole: '',
          },
        ],
        phases: ['Wait'],
        phaseCount: 1,
        stepCount: 1,
        hasSideEffects: false,
        requiresConfirmation: false,
      }),
    );
    expect(output).toContain('Wait for CI');
  });
});

// --- mapCanonicalStages helper tests ---
describe('mapCanonicalStages', () => {
  function makeStage(overrides: Partial<LifecycleStage>): LifecycleStage {
    return {
      name: '',
      label: '',
      status: 'pending',
      icon: '●',
      detail: '',
      ...overrides,
    };
  }

  it('returns 5 canonical slots for empty stages', () => {
    const slots = mapCanonicalStages([]);
    expect(slots).toHaveLength(5);
    expect(slots[0]!.key).toBe('proposal');
    expect(slots[0]!.status).toBe('current');
    expect(slots[1]!.status).toBe('pending');
    expect(slots[4]!.key).toBe('merged');
  });

  it('maps proposal stage to first slot as complete', () => {
    const stages = [
      makeStage({ name: 'proposal', label: 'Proposal', status: 'complete', issueNumber: 100 }),
    ];
    const slots = mapCanonicalStages(stages);
    expect(slots[0]!.status).toBe('complete');
    expect(slots[0]!.issueNumber).toBe(100);
    expect(slots[1]!.status).toBe('current');
    expect(slots[2]!.status).toBe('pending');
  });

  it('maps multiple stages and marks progress correctly', () => {
    const stages = [
      makeStage({ name: 'proposal', label: 'Proposal', status: 'complete', issueNumber: 100 }),
      makeStage({ name: 'review', label: 'Review', status: 'complete', issueNumber: 101 }),
      makeStage({ name: 'run', label: 'Run', status: 'in-progress', issueNumber: 102 }),
    ];
    const slots = mapCanonicalStages(stages);
    expect(slots[0]!.status).toBe('complete');
    expect(slots[1]!.status).toBe('complete');
    expect(slots[2]!.status).toBe('current');
    expect(slots[3]!.status).toBe('pending');
    expect(slots[4]!.status).toBe('pending');
  });

  it('marks a failed stage correctly', () => {
    const stages = [
      makeStage({ name: 'proposal', label: 'Proposal', status: 'complete' }),
      makeStage({ name: 'review', label: 'Review', status: 'failed' }),
    ];
    const slots = mapCanonicalStages(stages);
    expect(slots[0]!.status).toBe('complete');
    expect(slots[1]!.status).toBe('failed');
  });

  it('uses fallback sequential mapping for unclassifiable stage names', () => {
    const stages = [
      makeStage({ name: 'alpha', label: 'Alpha', status: 'complete' }),
      makeStage({ name: 'beta', label: 'Beta', status: 'in-progress' }),
    ];
    const slots = mapCanonicalStages(stages);
    expect(slots).toHaveLength(5);
    expect(slots[0]!.key).toBe('proposal');
    expect(slots[0]!.status).toBe('complete');
    expect(slots[1]!.key).toBe('review');
    // classifyStageStatus maps 'in-progress' to canonical 'current'
    expect(slots[1]!.status).toBe('current');
  });
});

// --- WorkflowLifecycleView horizontal progress bar tests ---
describe('WorkflowLifecycleView horizontal progress bar', () => {
  let instance: { unmount: () => void } | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  function makeLifecycleModel(
    overrides?: Partial<WorkflowLifecycleViewModel>,
  ): WorkflowLifecycleViewModel {
    return {
      workflowName: 'test-lifecycle',
      workflowHash: 'abc123',
      trustLevel: 'trusted',
      risk: 'medium',
      sourcePath: '.openslack/workflows/test-lifecycle',
      stages: [
        {
          name: 'proposal',
          label: 'Proposal',
          status: 'complete',
          icon: '✓',
          issueNumber: 125,
          detail: 'Proposal accepted',
        },
        {
          name: 'review',
          label: 'Review',
          status: 'complete',
          icon: '✓',
          issueNumber: 126,
          detail: 'Review passed',
        },
        { name: 'run', label: 'Run', status: 'in-progress', icon: '●', detail: 'Running' },
        { name: 'pr', label: 'PR', status: 'pending', icon: '○', detail: '' },
        { name: 'merged', label: 'Merged', status: 'pending', icon: '○', detail: '' },
      ],
      phaseIssues: [],
      ...overrides,
    };
  }

  async function renderLifecycleView(model: WorkflowLifecycleViewModel): Promise<string> {
    const chunks: string[] = [];
    const stdout = new Writable({
      write(chunk, _, cb) {
        chunks.push(String(chunk));
        cb();
      },
    }) as NodeJS.WriteStream;
    Object.defineProperties(stdout, {
      columns: { value: 100, configurable: true },
      rows: { value: 30, configurable: true },
      isTTY: { value: false, configurable: true },
    });

    instance = await render(
      React.createElement(
        NavigationProvider,
        null,
        React.createElement(WorkflowLifecycleView, { model }),
      ),
      { stdout, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 150));
    return chunks.join('');
  }

  it('renders all 5 canonical stage labels in horizontal progress bar', async () => {
    const output = await renderLifecycleView(makeLifecycleModel());
    expect(output).toContain('Proposal');
    expect(output).toContain('Review');
    expect(output).toContain('Run');
    expect(output).toContain('PR');
    expect(output).toContain('Merged');
  });

  it('shows Current label below progress bar for active stage', async () => {
    const output = await renderLifecycleView(makeLifecycleModel());
    expect(output).toContain('Current:');
    // Run is the in-progress stage so canonical mapper should mark it as current
    expect(output).toContain('Current: Run');
  });

  it('renders issue numbers next to stages', async () => {
    const output = await renderLifecycleView(makeLifecycleModel());
    expect(output).toContain('#125');
    expect(output).toContain('#126');
  });

  it('renders solid connectors for complete stages', async () => {
    const output = await renderLifecycleView(makeLifecycleModel());
    // Complete stages connected by ─── (solid line)
    expect(output).toContain('───');
  });

  it('renders header with workflow name', async () => {
    const output = await renderLifecycleView(makeLifecycleModel());
    expect(output).toContain('OpenSlack / Lifecycle / test-lifecycle');
  });

  it('renders metadata bar with trust and risk', async () => {
    const output = await renderLifecycleView(makeLifecycleModel());
    expect(output).toContain('Hash: abc123');
    expect(output).toContain('Source: .openslack/workflows/test-lifecycle');
    expect(output).toContain('trusted');
    expect(output).toContain('medium');
  });

  it('shows next action hint when present', async () => {
    const output = await renderLifecycleView(
      makeLifecycleModel({
        nextAction: 'Awaiting PR creation',
      }),
    );
    expect(output).toContain('Next: Awaiting PR creation');
  });

  it('shows PR info when prNumber is set', async () => {
    const output = await renderLifecycleView(
      makeLifecycleModel({
        prNumber: 42,
        prStatus: 'open',
      }),
    );
    expect(output).toContain('PR: #42');
    expect(output).toContain('open');
  });

  it('renders empty state when no stages', async () => {
    const output = await renderLifecycleView(makeLifecycleModel({ stages: [] }));
    expect(output).toContain('No GitHub issues found for this workflow');
  });
});

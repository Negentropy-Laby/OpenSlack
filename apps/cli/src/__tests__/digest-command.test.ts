import { describe, it, expect } from 'vitest';
import {
  buildDigestCard,
  cardToText,
  buildWorkflowCard,
} from '@openslack/chat-gateway';
import {
  previewWorkflowTemplate,
  renderWorkflowPreview,
} from '@openslack/collaboration';

// ─── Digest Slack posting logic tests ──────────────────────────────────────────

describe('digest --post slack integration logic', () => {
  it('builds a digest card with correct fields', () => {
    const card = buildDigestCard({
      sinceHours: 24,
      totalEvents: 15,
      groups: [
        { label: 'Completed', count: 10, items: ['PR merged', 'Task done'] },
        { label: 'Blocked', count: 3, items: ['PR stuck'] },
        { label: 'Agent Activity', count: 2, items: ['Agent claimed'] },
      ],
    });
    const text = cardToText(card);
    expect(text).toContain('Collaboration Digest');
    expect(text).toContain('15 events');
    expect(text).toContain('Completed');
    expect(text).toContain('Blocked');
    expect(text).toContain('Agent Activity');
  });

  it('cardToText produces plain text suitable for Slack messages', () => {
    const card = buildDigestCard({
      sinceHours: 8,
      totalEvents: 5,
      groups: [
        { label: 'Completed', count: 5, items: ['Done'] },
      ],
    });
    const text = cardToText(card);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
    // Ensure no ANSI codes
    expect(text).not.toMatch(/\x1b\[/);
  });

  it('builds digest card with empty groups', () => {
    const card = buildDigestCard({
      sinceHours: 24,
      totalEvents: 0,
      groups: [],
    });
    expect(card.title).toBe('Collaboration Digest');
    expect(card.summary).toContain('0 events');
    expect(card.fields).toHaveLength(0);
  });
});

// ─── Workflow preview --format logic tests ─────────────────────────────────────
// Use only registered action IDs and non-action step types to avoid validation errors.

describe('workflow preview --format logic', () => {
  const sampleTemplate = {
    schema: 'openslack.workflow_template.v1' as const,
    id: 'test-preview',
    name: 'Test Preview Workflow',
    inputs: [
      { name: 'repo', type: 'string' as const, required: true },
    ],
    phases: [
      {
        name: 'Assess',
        steps: [
          { type: 'action' as const, actionId: 'status.show', title: 'Show status' },
          { type: 'action' as const, actionId: 'doctor.run', title: 'Run doctor' },
        ],
      },
      {
        name: 'Decide',
        steps: [
          { type: 'decision-gate' as const, title: 'Approve deployment', requiredRole: 'admin' },
          { type: 'record-decision' as const, topic: 'Deploy?', decision: 'Yes', rationale: 'Tests pass', decidedBy: 'admin' },
        ],
      },
    ],
  };

  it('renders standard preview with renderWorkflowPreview', () => {
    const preview = previewWorkflowTemplate(sampleTemplate, { repo: 'org/repo' });
    const text = renderWorkflowPreview(preview);
    expect(text).toContain('Workflow: Test Preview Workflow');
    expect(text).toContain('Template: test-preview');
    expect(text).toContain('Correlation:');
    expect(text).toContain('Show status');
    expect(text).toContain('Run doctor');
    expect(text).toContain('Approve deployment');
  });

  it('renders JSON preview with JSON.stringify', () => {
    const preview = previewWorkflowTemplate(sampleTemplate, { repo: 'org/repo' });
    const json = JSON.stringify(preview, null, 2);
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.templateId).toBe('test-preview');
    expect(parsed.steps.length).toBeGreaterThan(0);
  });

  it('renders chat format with buildWorkflowCard + cardToText', () => {
    const preview = previewWorkflowTemplate(sampleTemplate, { repo: 'org/repo' });
    const card = buildWorkflowCard(preview);
    const text = cardToText(card);
    expect(text).toContain('Workflow: Test Preview Workflow');
    expect(text).toContain('Steps');
    expect(text).toContain('Phases');
  });

  it('preview contains correct step data for TUI mapping', () => {
    const preview = previewWorkflowTemplate(sampleTemplate, { repo: 'org/repo' });
    expect(preview.steps.length).toBe(4);
    expect(preview.steps[0].phase).toBe('Assess');
    expect(preview.steps[0].type).toBe('action');
    expect(preview.steps[2].phase).toBe('Decide');
    expect(preview.steps[2].type).toBe('decision-gate');
    expect(preview.steps[2].requiredRole).toBe('admin');
    expect(preview.errors).toHaveLength(0);
  });

  it('preview handles missing required inputs with errors', () => {
    const preview = previewWorkflowTemplate(sampleTemplate, {});
    expect(preview.errors.length).toBeGreaterThan(0);
    const text = renderWorkflowPreview(preview);
    expect(text).toContain('Errors');
  });

  it('buildWorkflowCard shows side effects info', () => {
    const preview = previewWorkflowTemplate(sampleTemplate, { repo: 'org/repo' });
    const card = buildWorkflowCard(preview);
    const sideEffectsField = card.fields.find((f: { label: string }) => f.label === 'Side effects');
    expect(sideEffectsField).toBeDefined();
    expect(['Yes', 'No']).toContain((sideEffectsField as { value: string }).value);
  });

  it('buildWorkflowCard shows execute/cancel actions for valid preview', () => {
    const preview = previewWorkflowTemplate(sampleTemplate, { repo: 'org/repo' });
    const card = buildWorkflowCard(preview);
    expect(card.actions.length).toBeGreaterThan(0);
    const actionIds = card.actions.map((a: { action: string }) => a.action);
    expect(actionIds).toContain('execute_workflow');
    expect(actionIds).toContain('cancel');
  });

  it('buildWorkflowCard shows no actions for errored preview', () => {
    const preview = previewWorkflowTemplate(sampleTemplate, {});
    if (preview.errors.length > 0) {
      const card = buildWorkflowCard(preview);
      expect(card.actions).toHaveLength(0);
    }
  });
});

// ─── Workflow preview with handoff and wait steps ──────────────────────────────

describe('workflow preview with non-action steps', () => {
  const handoffWaitTemplate = {
    schema: 'openslack.workflow_template.v1' as const,
    id: 'handoff-test',
    name: 'Handoff and Wait',
    phases: [
      {
        name: 'Handoff',
        steps: [
          { type: 'handoff' as const, from: 'agent-1', to: 'agent-2', context: 'Review changes' },
        ],
      },
      {
        name: 'Wait',
        steps: [
          { type: 'wait' as const, title: 'Wait for CI' },
        ],
      },
    ],
  };

  it('renders handoff and wait steps in standard format', () => {
    const preview = previewWorkflowTemplate(handoffWaitTemplate, {});
    const text = renderWorkflowPreview(preview);
    expect(text).toContain('Handoff and Wait');
    expect(text).toContain('Handoff');
    expect(text).toContain('Wait');
  });

  it('preview has correct phase grouping', () => {
    const preview = previewWorkflowTemplate(handoffWaitTemplate, {});
    expect(preview.steps.length).toBe(2);
    expect(preview.steps[0].phase).toBe('Handoff');
    expect(preview.steps[1].phase).toBe('Wait');
  });

  it('builds workflow card for handoff/wait preview', () => {
    const preview = previewWorkflowTemplate(handoffWaitTemplate, {});
    const card = buildWorkflowCard(preview);
    expect(card.title).toContain('Handoff and Wait');
    expect(card.fields.length).toBeGreaterThan(0);
  });
});

// ─── Slack adapter send validation tests ────────────────────────────────────────

describe('Slack adapter send validation', () => {
  it('requires botToken to send', async () => {
    const { SlackAdapter } = await import('@openslack/chat-gateway');
    const adapter = new SlackAdapter({ port: 0, signingSecret: 'test', botToken: undefined });
    // Should not throw but log error (the method handles missing token gracefully)
    await expect(adapter.send('C123', { text: 'hello' })).resolves.toBeUndefined();
  });

  it('adapter has correct name property', async () => {
    const { SlackAdapter } = await import('@openslack/chat-gateway');
    const adapter = new SlackAdapter({ port: 0, signingSecret: 'test' });
    expect(adapter.name).toBe('slack');
  });
});

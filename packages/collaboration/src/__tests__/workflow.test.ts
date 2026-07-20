import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  executeWorkflowTemplate,
  previewWorkflowTemplate,
  readEvents,
  validateWorkflowTemplate,
  type WorkflowTemplate,
} from '../index.js';

describe('workflow templates', () => {
  let origCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'openslack-workflow-test-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeTemplate(): WorkflowTemplate {
    return {
      schema: 'openslack.workflow_template.v1',
      id: 'WFT-release-review',
      name: 'Release Review Gate',
      inputs: [{ name: 'pr_number', type: 'integer', required: true }],
      phases: [
        {
          name: 'Pre-merge',
          steps: [
            { type: 'action', actionId: 'pr.doctor', input: { prNumber: '{{inputs.pr_number}}' } },
            { type: 'decision-gate', title: 'Human approval required', requiredRole: 'codeowner' },
            {
              type: 'handoff',
              from: 'agent',
              to: 'human',
              context: 'Review PR {{inputs.pr_number}}',
              prRef: '{{inputs.pr_number}}',
            },
          ],
        },
      ],
    };
  }

  it('validates typed action templates', () => {
    expect(validateWorkflowTemplate(makeTemplate())).toEqual([]);
  });

  it('rejects raw command templates', () => {
    const template = makeTemplate() as unknown as Record<string, unknown>;
    const phases = template.phases as Array<{ steps: Array<Record<string, unknown>> }>;
    phases[0].steps[0] = { type: 'action', command: 'openslack pr doctor 42' };

    const errors = validateWorkflowTemplate(template);

    expect(errors.some((error) => error.includes('raw command'))).toBe(true);
  });

  it('previews action, decision, and handoff steps with one correlation ID', () => {
    const preview = previewWorkflowTemplate(makeTemplate(), { pr_number: 42 }, 'WF-test');

    expect(preview.errors).toEqual([]);
    expect(preview.correlationId).toBe('WF-test');
    expect(preview.steps.map((step) => step.type)).toEqual(['action', 'decision-gate', 'handoff']);
    expect(preview.steps[0].actionId).toBe('pr.doctor');
  });

  it('executes dry-run workflow and records correlated events', async () => {
    const result = await executeWorkflowTemplate(
      makeTemplate(),
      { pr_number: 42 },
      { dryRun: true, correlationId: 'WF-test' },
    );

    expect(result.status).toBe('completed');
    const events = readEvents().filter((event) => event.correlationId === 'WF-test');
    expect(events.map((event) => event.type)).toEqual([
      'workflow.previewed',
      'workflow.started',
      'workflow.completed',
    ]);
  });

  it('blocks templates with unknown registered actions', () => {
    const template = makeTemplate();
    template.phases[0].steps[0] = { type: 'action', actionId: 'shell.run', input: {} };

    const preview = previewWorkflowTemplate(template, { pr_number: 42 });

    expect(preview.errors.some((error) => error.includes('unknown action'))).toBe(true);
  });

  it('resolves template variables in handoff fields during execution', async () => {
    const template: WorkflowTemplate = {
      schema: 'openslack.workflow_template.v1',
      id: 'test-handoff-resolve',
      name: 'Handoff Resolve Test',
      inputs: [
        { name: 'agentId', type: 'string', required: true },
        { name: 'issueNumber', type: 'integer', required: true },
      ],
      phases: [
        {
          name: 'Handoff',
          steps: [
            {
              type: 'handoff',
              from: '{{inputs.agentId}}',
              to: 'human',
              context: 'Work done on issue {{inputs.issueNumber}} by {{inputs.agentId}}',
              issueRef: '{{inputs.issueNumber}}',
              nextSteps: ['Review changes for issue {{inputs.issueNumber}}'],
            },
          ],
        },
      ],
    };

    const result = await executeWorkflowTemplate(
      template,
      { agentId: 'codex-dev', issueNumber: 7 },
      { dryRun: false, correlationId: 'WF-handoff-test' },
    );

    expect(result.status).toBe('completed');
    expect(result.handoffs).toHaveLength(1);
    expect(result.handoffs[0].from).toBe('codex-dev');
    expect(result.handoffs[0].context).toBe('Work done on issue 7 by codex-dev');
    expect(result.handoffs[0].issueRef).toBe('7');
    expect(result.handoffs[0].nextSteps).toEqual(['Review changes for issue 7']);
  });

  it('resolves template variables in record-decision fields during execution', async () => {
    const template: WorkflowTemplate = {
      schema: 'openslack.workflow_template.v1',
      id: 'test-decision-resolve',
      name: 'Decision Resolve Test',
      inputs: [
        { name: 'agentId', type: 'string', required: true },
        { name: 'title', type: 'string', required: true },
      ],
      phases: [
        {
          name: 'Decide',
          steps: [
            {
              type: 'record-decision',
              topic: 'Research: {{inputs.title}}',
              decision: 'Completed by {{inputs.agentId}}',
              rationale: 'Investigation finished',
              decidedBy: '{{inputs.agentId}}',
              tags: ['research', '{{inputs.agentId}}'],
            },
          ],
        },
      ],
    };

    const result = await executeWorkflowTemplate(
      template,
      { agentId: 'claude-reviewer', title: 'Auth redesign' },
      { dryRun: false, correlationId: 'WF-decision-test' },
    );

    expect(result.status).toBe('completed');
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].topic).toBe('Research: Auth redesign');
    expect(result.decisions[0].decision).toBe('Completed by claude-reviewer');
    expect(result.decisions[0].decidedBy).toBe('claude-reviewer');
    expect(result.decisions[0].tags).toEqual(['research', 'claude-reviewer']);
  });
});

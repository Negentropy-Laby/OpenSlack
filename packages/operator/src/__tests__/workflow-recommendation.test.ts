import { describe, expect, it } from 'vitest';
import { recommendWorkflowForQuery } from '../workflow-recommendation.js';

describe('recommendWorkflowForQuery', () => {
  it('does not recommend workflows for simple direct tasks', () => {
    const recommendation = recommendWorkflowForQuery('fix a typo in one file');

    expect(recommendation.decision).toBe('workflow_not_needed');
    expect(recommendation.reason).toContain('small direct operator task');
  });

  it('does not treat workflow status as a generation request', () => {
    const recommendation = recommendWorkflowForQuery('workflow status');

    expect(recommendation.decision).toBe('workflow_not_needed');
    expect(recommendation.nextAction).toBe('Use openslack ask or a direct module command.');
  });

  it('recommends a workflow for explicit high-scope workflow requests', () => {
    const recommendation = recommendWorkflowForQuery('use a workflow to audit every API endpoint');

    expect(recommendation.decision).toBe('workflow_recommended');
    expect(recommendation.reason).toContain('This looks like a workflow task');
    expect(recommendation.suggestedPattern).toBe('adversarial-verification');
    expect(recommendation.nextAction).toContain('Generate workflow draft');
    expect(recommendation.nextAction).toContain('workflow generate');
  });

  it('scales confidence when multiple fanout signals are present', () => {
    const recommendation = recommendWorkflowForQuery('audit all packages across every API endpoint');

    expect(recommendation.decision).toBe('workflow_recommended');
    expect(recommendation.confidence).toBeGreaterThan(0.75);
  });

  it('recognizes Chinese high-scope review requests', () => {
    const recommendation = recommendWorkflowForQuery('审查所有 packages 里的 API endpoint');

    expect(recommendation.decision).toBe('workflow_recommended');
    expect(recommendation.suggestedPattern).toBe('adversarial-verification');
  });

  it('treats ultracode as a draft trigger without executing a workflow', () => {
    const recommendation = recommendWorkflowForQuery('ultracode: root-cause all failing workflow tests');

    expect(recommendation.decision).toBe('workflow_draft_required');
    expect(recommendation.confidence).toBeGreaterThan(0.9);
    expect(recommendation.nextAction).toContain('workflow generate');
  });

  it('recommends workflows for broad PR governance review', () => {
    const recommendation = recommendWorkflowForQuery('review all open PRs for governance issues');

    expect(recommendation.decision).toBe('workflow_recommended');
    expect(recommendation.reason).toContain('multiple targets');
    expect(recommendation.suggestedPattern).toBe('adversarial-verification');
    expect(recommendation.nextAction).toContain('Generate workflow draft');
  });
});

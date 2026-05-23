import { describe, it, expect } from 'vitest';
import { formatPlanAsMarkdown, formatResultAsMarkdown, formatError } from '../formatter.js';
import { planActions } from '@openslack/operator';
import { parseIntent } from '@openslack/operator';

describe('formatPlanAsMarkdown', () => {
  it('formats low-risk plan', () => {
    const intent = parseIntent('check status');
    const plan = planActions(intent);
    const md = formatPlanAsMarkdown(plan);
    expect(md).toContain('Check OpenSlack status');
    expect(md).toContain('Risk: NONE');
  });

  it('formats high-risk plan with explanation', () => {
    const intent = parseIntent('merge PR #12');
    const plan = planActions(intent);
    const md = formatPlanAsMarkdown(plan);
    expect(md).toContain('Merge PR #12');
    expect(md).toContain('Risk: HIGH');
    expect(md).toContain('irreversible');
  });

  it('formats missing params', () => {
    const intent = parseIntent('sync issue #12');
    const plan = planActions(intent);
    const md = formatPlanAsMarkdown(plan);
    expect(md).toContain('Missing information');
  });
});

describe('formatResultAsMarkdown', () => {
  it('formats success result', () => {
    const result = {
      planId: 'PLAN-001',
      status: 'success' as const,
      steps: [],
      summary: 'Done',
      nextActions: [],
    };
    const resp = formatResultAsMarkdown(result);
    expect(resp.text).toContain('✅');
    expect(resp.text).toContain('Done');
  });

  it('formats blocked result', () => {
    const result = {
      planId: 'PLAN-001',
      status: 'blocked' as const,
      steps: [],
      summary: 'Missing params',
      nextActions: ['Retry'],
    };
    const resp = formatResultAsMarkdown(result);
    expect(resp.text).toContain('🚫');
    expect(resp.text).toContain('Retry');
  });
});

describe('formatError', () => {
  it('formats error', () => {
    const resp = formatError('Something broke');
    expect(resp.text).toContain('❌');
    expect(resp.text).toContain('Something broke');
  });
});

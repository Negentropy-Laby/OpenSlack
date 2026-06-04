import { describe, expect, it } from 'vitest';
import { buildTuiAskPlan } from '../tui-ask.js';

describe('buildTuiAskPlan', () => {
  it('maps broad PR checks to a PR queue route card', () => {
    const result = buildTuiAskPlan('检查 PR');

    expect(result.plan.intent.kind).toBe('pr_queue');
    expect(result.cards).toContainEqual(expect.objectContaining({
      label: 'Open PR Queue',
      kind: 'route',
      route: 'pr-queue',
    }));
  });

  it('maps workflow-shaped prompts to draft-first workflow cards', () => {
    const result = buildTuiAskPlan('use a workflow to audit every API endpoint');

    expect(result.plan.intent.kind).toBe('workflow_recommended');
    expect(result.cards[0]).toEqual(expect.objectContaining({
      label: 'Generate Draft',
      kind: 'workflow_draft',
      confirmationRequired: false,
    }));
    expect(result.cards).toContainEqual(expect.objectContaining({
      label: 'Preview Draft',
      command: 'openslack collaboration workflow preview-draft <draftId>',
      detail: expect.stringContaining('Replace <draftId>'),
    }));
    expect(result.cards).toContainEqual(expect.objectContaining({
      label: 'Run after approval',
      confirmationRequired: true,
      detail: expect.stringContaining('Replace <workflow-file>'),
    }));
  });

  it('keeps small status prompts on the direct status route', () => {
    const result = buildTuiAskPlan('check status');

    expect(result.plan.intent.kind).toBe('status');
    expect(result.cards).toContainEqual(expect.objectContaining({
      label: 'Open Status',
      kind: 'route',
      route: 'status',
    }));
  });

  it('maps profile sync prompts to profile sync route cards', () => {
    const result = buildTuiAskPlan('检查 GitHub 主页是否需要更新');

    expect(result.plan.intent.kind).toBe('profile_sync');
    expect(result.cards).toContainEqual(expect.objectContaining({
      label: 'Check Profile Sync',
      route: 'profile',
    }));
    expect(result.cards).toContainEqual(expect.objectContaining({
      label: 'Create Profile Sync PR',
      confirmationRequired: true,
    }));
  });
});

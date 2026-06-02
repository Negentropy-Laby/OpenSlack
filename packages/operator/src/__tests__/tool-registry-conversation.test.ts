import { describe, it, expect } from 'vitest';
import {
  getRegisteredAction,
  createRegisteredStep,
  isRegisteredStep,
} from '../index.js';

describe('conversation tool registry', () => {
  it('conversation.list is a valid registered action', () => {
    const action = getRegisteredAction('conversation.list');
    expect(action).toBeDefined();
    expect(action!.id).toBe('conversation.list');
    expect(action!.description).toContain('List conversation');
    expect(action!.riskLevel).toBe('none');
    expect(action!.sideEffects).toBe(false);
    expect(action!.confirmationRequired).toBe(false);

    const step = createRegisteredStep('conversation.list', {}, 's1');
    expect(step.actionId).toBe('conversation.list');
    expect(step.command).toBe('conversation');
    expect(step.args).toEqual(['list']);
    expect(isRegisteredStep(step)).toBe(true);
  });

  it('conversation.list accepts optional --status filter', () => {
    const step = createRegisteredStep('conversation.list', { status: 'active' }, 's1');
    expect(step.actionId).toBe('conversation.list');
    expect(step.args).toEqual(['list', '--status', 'active']);
    expect(isRegisteredStep(step)).toBe(true);
  });

  it('conversation.show is a valid registered action', () => {
    const action = getRegisteredAction('conversation.show');
    expect(action).toBeDefined();
    expect(action!.id).toBe('conversation.show');
    expect(action!.description).toContain('Show conversation');
    expect(action!.riskLevel).toBe('none');
    expect(action!.sideEffects).toBe(false);
    expect(action!.inputSchema).toEqual({
      threadId: { type: 'string', required: true },
    });

    const step = createRegisteredStep('conversation.show', { threadId: 'CONV-001' }, 's1');
    expect(step.actionId).toBe('conversation.show');
    expect(step.command).toBe('conversation');
    expect(step.args).toEqual(['show', 'CONV-001']);
    expect(isRegisteredStep(step)).toBe(true);
  });

  it('conversation.send has sideEffects=true', () => {
    const action = getRegisteredAction('conversation.send');
    expect(action).toBeDefined();
    expect(action!.id).toBe('conversation.send');
    expect(action!.description).toContain('Send message');
    expect(action!.riskLevel).toBe('medium');
    expect(action!.sideEffects).toBe(true);
    expect(action!.confirmationRequired).toBe(false);
    expect(action!.inputSchema).toEqual({
      threadId: { type: 'string', required: true },
      message: { type: 'string', required: true },
    });

    const step = createRegisteredStep('conversation.send', { threadId: 'CONV-001', message: 'Hello' }, 's1');
    expect(step.actionId).toBe('conversation.send');
    expect(step.command).toBe('conversation');
    expect(step.args).toEqual(['send', 'CONV-001', 'Hello']);
    expect(isRegisteredStep(step)).toBe(true);
  });

  it('conversation.show rejects missing threadId', () => {
    expect(() => createRegisteredStep('conversation.show', {}, 's1')).toThrow('Missing required input');
  });

  it('conversation.send rejects missing required inputs', () => {
    expect(() => createRegisteredStep('conversation.send', { threadId: 'CONV-001' }, 's1')).toThrow('Missing required input');
    expect(() => createRegisteredStep('conversation.send', { message: 'Hello' }, 's1')).toThrow('Missing required input');
  });

  // --- New conversation actions ---

  it('conversation.start is a valid registered action', () => {
    const action = getRegisteredAction('conversation.start');
    expect(action).toBeDefined();
    expect(action!.id).toBe('conversation.start');
    expect(action!.description).toContain('Create');
    expect(action!.riskLevel).toBe('low');
    expect(action!.sideEffects).toBe(true);
    expect(action!.inputSchema.title).toEqual({ type: 'string', required: true });

    const step = createRegisteredStep('conversation.start', { title: 'Test Thread' }, 's1');
    expect(step.actionId).toBe('conversation.start');
    expect(step.command).toBe('conversation');
    expect(step.args).toEqual(['start', '--title', 'Test Thread']);
    expect(isRegisteredStep(step)).toBe(true);
  });

  it('conversation.start accepts optional pr/issue/workflow', () => {
    const step = createRegisteredStep('conversation.start', { title: 'PR Thread', pr: 42 }, 's1');
    expect(step.args).toEqual(['start', '--title', 'PR Thread', '--pr', '42']);
  });

  it('conversation.start rejects missing title', () => {
    expect(() => createRegisteredStep('conversation.start', {}, 's1')).toThrow('Missing required input');
  });

  it('conversation.summarize is a valid registered action', () => {
    const action = getRegisteredAction('conversation.summarize');
    expect(action).toBeDefined();
    expect(action!.id).toBe('conversation.summarize');
    expect(action!.description).toContain('summary');
    expect(action!.riskLevel).toBe('none');
    expect(action!.sideEffects).toBe(false);
    expect(action!.inputSchema).toEqual({
      threadId: { type: 'string', required: true },
    });

    const step = createRegisteredStep('conversation.summarize', { threadId: 'CONV-001' }, 's1');
    expect(step.actionId).toBe('conversation.summarize');
    expect(step.command).toBe('conversation');
    expect(step.args).toEqual(['summarize', 'CONV-001']);
    expect(isRegisteredStep(step)).toBe(true);
  });

  it('conversation.summarize rejects missing threadId', () => {
    expect(() => createRegisteredStep('conversation.summarize', {}, 's1')).toThrow('Missing required input');
  });

  it('conversation.archive is a valid registered action', () => {
    const action = getRegisteredAction('conversation.archive');
    expect(action).toBeDefined();
    expect(action!.id).toBe('conversation.archive');
    expect(action!.description).toContain('Archive');
    expect(action!.riskLevel).toBe('medium');
    expect(action!.sideEffects).toBe(true);
    expect(action!.inputSchema).toEqual({
      threadId: { type: 'string', required: true },
    });

    const step = createRegisteredStep('conversation.archive', { threadId: 'CONV-001' }, 's1');
    expect(step.actionId).toBe('conversation.archive');
    expect(step.command).toBe('conversation');
    expect(step.args).toEqual(['archive', 'CONV-001']);
    expect(isRegisteredStep(step)).toBe(true);
  });

  it('conversation.archive rejects missing threadId', () => {
    expect(() => createRegisteredStep('conversation.archive', {}, 's1')).toThrow('Missing required input');
  });
});

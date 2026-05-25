import { describe, it, expect } from 'vitest';
import {
  buildActionPlanFromRegisteredActions,
  createRegisteredStep,
  isRegisteredStep,
  LLM_PLANNER_MAX_TOOL_STEPS,
} from '../index.js';

describe('tool registry', () => {
  it('creates typed registered steps', () => {
    const step = createRegisteredStep('pr.doctor', { prNumber: 12 }, 's1');
    expect(step.actionId).toBe('pr.doctor');
    expect(step.command).toBe('pr');
    expect(step.args).toEqual(['doctor', '12']);
    expect(isRegisteredStep(step)).toBe(true);
  });

  it('rejects unknown actions instead of accepting raw shell', () => {
    expect(() => createRegisteredStep('shell.run', { command: 'rm -rf .' }, 's1')).toThrow('Unregistered');
  });

  it('rejects invalid action input', () => {
    expect(() => createRegisteredStep('pr.doctor', { prNumber: '12' }, 's1')).toThrow('expected number');
  });

  it('registers task creation preview instead of raw issue commands', () => {
    const step = createRegisteredStep('task.create.preview', { title: 'Investigate setup', template: 'investigation' }, 's1');
    expect(step.command).toBe('task');
    expect(step.args).toEqual(['create', '--template', 'investigation', '--title', 'Investigate setup']);
    expect(isRegisteredStep(step)).toBe(true);
  });

  it('enforces the compound plan step limit', () => {
    const calls = Array.from({ length: LLM_PLANNER_MAX_TOOL_STEPS + 1 }, () => ({
      actionId: 'status.show',
      input: {},
    }));
    expect(() => buildActionPlanFromRegisteredActions('too many', { kind: 'status', slots: {}, confidence: 1 }, calls))
      .toThrow('max tool step limit');
  });
});

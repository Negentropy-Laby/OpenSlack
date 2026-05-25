import { describe, it, expect } from 'vitest';
import {
  LLM_PLANNER_MAX_REPLANS,
  LLM_PLANNER_MAX_RETRIES,
  LLM_PLANNER_MAX_TOOL_STEPS,
  resolveIntent,
  type LLMPlannerProvider,
} from '../index.js';

describe('resolveIntent', () => {
  it('does not call LLM for high-confidence known intents', async () => {
    let called = false;
    const provider: LLMPlannerProvider = {
      id: 'test',
      async classifyAndPlan() {
        called = true;
        return { intent: { kind: 'doctor', slots: {}, confidence: 1 } };
      },
    };

    const intent = await resolveIntent('check status', { provider });

    expect(intent.kind).toBe('status');
    expect(called).toBe(false);
  });

  it('uses LLM fallback for unknown requests and returns typed intents only', async () => {
    const provider: LLMPlannerProvider = {
      id: 'test',
      async classifyAndPlan() {
        return { intent: { kind: 'pr_doctor', slots: { prNumber: 42 }, confidence: 0.9 } };
      },
    };

    const intent = await resolveIntent('why is the release blocked?', { provider });

    expect(intent.kind).toBe('pr_doctor');
    expect(intent.slots.prNumber).toBe(42);
  });

  it('falls back to unknown when provider returns an invalid raw command shape', async () => {
    const provider: LLMPlannerProvider = {
      id: 'test',
      async classifyAndPlan() {
        return { intent: { kind: 'shell.run', slots: { command: 'rm -rf .' }, confidence: 1 } as never };
      },
    };

    const intent = await resolveIntent('delete everything', { provider });

    expect(intent.kind).toBe('unknown');
  });

  it('exports bounded planner limits', () => {
    expect(LLM_PLANNER_MAX_TOOL_STEPS).toBe(6);
    expect(LLM_PLANNER_MAX_REPLANS).toBe(2);
    expect(LLM_PLANNER_MAX_RETRIES).toBe(1);
  });
});

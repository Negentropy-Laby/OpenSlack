import { describe, it, expect } from 'vitest';
import { isAgentConversationMessage } from '../conversation-types.js';
import type { AgentConversationMessage } from '../conversation-types.js';

describe('conversation-types', () => {
  const baseFields = {
    id: 'MSG-20260602-TEST01',
    threadId: 'CONV-20260602-TEST',
    timestamp: new Date().toISOString(),
    authorId: 'agent-1',
  };

  const allKinds: AgentConversationMessage[] = [
    { ...baseFields, kind: 'user_message', text: 'Hello' },
    { ...baseFields, kind: 'agent_response', text: 'Hi there' },
    { ...baseFields, kind: 'tool_event', toolName: 'readFile' },
    { ...baseFields, kind: 'plan', planId: 'PLAN-1', steps: ['step 1', 'step 2'] },
    { ...baseFields, kind: 'approval_request', targetAction: 'merge', riskLevel: 'high' },
    { ...baseFields, kind: 'decision', decisionId: 'DEC-1', summary: 'Use approach A' },
    {
      ...baseFields,
      kind: 'handoff',
      handoffId: 'HO-1',
      toParticipant: 'agent-2',
      summary: 'Passing task',
    },
  ];

  it('recognizes all 7 valid message kinds', () => {
    for (const msg of allKinds) {
      expect(isAgentConversationMessage(msg)).toBe(true);
    }
    expect(allKinds).toHaveLength(7);
  });

  it('rejects null and undefined', () => {
    expect(isAgentConversationMessage(null)).toBe(false);
    expect(isAgentConversationMessage(undefined)).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isAgentConversationMessage('string')).toBe(false);
    expect(isAgentConversationMessage(42)).toBe(false);
    expect(isAgentConversationMessage(true)).toBe(false);
  });

  it('rejects objects without kind', () => {
    expect(isAgentConversationMessage({ id: 'x' })).toBe(false);
  });

  it('rejects objects with invalid kind', () => {
    expect(isAgentConversationMessage({ ...baseFields, kind: 'invalid' })).toBe(false);
  });

  it('rejects objects with numeric kind', () => {
    expect(isAgentConversationMessage({ ...baseFields, kind: 123 })).toBe(false);
  });

  it('user_message has correct discriminated fields', () => {
    const msg = allKinds.find((m) => m.kind === 'user_message')!;
    expect(msg.kind).toBe('user_message');
    if (msg.kind === 'user_message') {
      expect(msg.text).toBe('Hello');
    }
  });

  it('agent_response has correct discriminated fields', () => {
    const msg = allKinds.find((m) => m.kind === 'agent_response')!;
    expect(msg.kind).toBe('agent_response');
    if (msg.kind === 'agent_response') {
      expect(msg.text).toBe('Hi there');
    }
  });

  it('tool_event has correct discriminated fields', () => {
    const msg = allKinds.find((m) => m.kind === 'tool_event')!;
    expect(msg.kind).toBe('tool_event');
    if (msg.kind === 'tool_event') {
      expect(msg.toolName).toBe('readFile');
    }
  });

  it('plan has correct discriminated fields', () => {
    const msg = allKinds.find((m) => m.kind === 'plan')!;
    expect(msg.kind).toBe('plan');
    if (msg.kind === 'plan') {
      expect(msg.planId).toBe('PLAN-1');
      expect(msg.steps).toEqual(['step 1', 'step 2']);
    }
  });

  it('approval_request has correct discriminated fields', () => {
    const msg = allKinds.find((m) => m.kind === 'approval_request')!;
    expect(msg.kind).toBe('approval_request');
    if (msg.kind === 'approval_request') {
      expect(msg.targetAction).toBe('merge');
      expect(msg.riskLevel).toBe('high');
    }
  });

  it('decision has correct discriminated fields', () => {
    const msg = allKinds.find((m) => m.kind === 'decision')!;
    expect(msg.kind).toBe('decision');
    if (msg.kind === 'decision') {
      expect(msg.decisionId).toBe('DEC-1');
      expect(msg.summary).toBe('Use approach A');
    }
  });

  it('handoff has correct discriminated fields', () => {
    const msg = allKinds.find((m) => m.kind === 'handoff')!;
    expect(msg.kind).toBe('handoff');
    if (msg.kind === 'handoff') {
      expect(msg.handoffId).toBe('HO-1');
      expect(msg.toParticipant).toBe('agent-2');
      expect(msg.summary).toBe('Passing task');
    }
  });
});

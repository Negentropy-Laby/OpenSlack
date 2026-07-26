import { describe, expect, it } from 'vitest';
import {
  OPENSLACK_MCP_RESULT_SCHEMA,
  createBlockedMcpResult,
  createOpenSlackMcpResult,
} from '../index.js';

describe('OpenSlack MCP result contract', () => {
  it('uses a bounded immutable v1 result', () => {
    const result = createOpenSlackMcpResult({
      summary: 'Executive overview ready.',
      data: { count: 1 },
      evidenceRefs: ['event:1', 'event:1'],
    });

    expect(result).toEqual({
      schema: OPENSLACK_MCP_RESULT_SCHEMA,
      status: 'completed',
      summary: 'Executive overview ready.',
      data: { count: 1 },
      governance: { risk: 'none', approvalRequired: false },
      nextActions: [],
      evidenceRefs: ['event:1'],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.governance)).toBe(true);
  });

  it('makes missing projection capability an explicit blocker', () => {
    expect(
      createBlockedMcpResult('Outcomes unavailable.', 'OUTCOMES_READER_NOT_BOUND'),
    ).toMatchObject({
      status: 'blocked',
      governance: {
        risk: 'none',
        approvalRequired: false,
        blocker: 'OUTCOMES_READER_NOT_BOUND',
      },
    });
  });

  it('bounds identifiers, errors, evidence, summary, and next actions', () => {
    const result = createOpenSlackMcpResult({
      status: 'failed',
      summary: 's'.repeat(3_000),
      planId: 'p'.repeat(300),
      executionId: 'e'.repeat(300),
      error: { code: 'C'.repeat(200), message: 'm'.repeat(2_000) },
      evidenceRefs: Array.from({ length: 80 }, (_, index) => `event:${index}`),
      nextActions: Array.from({ length: 20 }, (_, index) => ({
        id: `next-${index}`,
        label: `Next ${index}`,
      })),
    });

    expect(result.summary.length).toBe(2_000);
    expect(result.planId).toHaveLength(160);
    expect(result.executionId).toHaveLength(160);
    expect(result.error?.code).toHaveLength(100);
    expect(result.error?.message).toHaveLength(1_000);
    expect(result.evidenceRefs).toHaveLength(50);
    expect(result.nextActions).toHaveLength(12);
  });
});

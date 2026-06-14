import { describe, expect, it } from 'vitest';
import { summarizeResults } from '../summarizer.js';
import type { ExecutionResult } from '../types.js';

describe('summarizeResults', () => {
  it('includes failed step output with basic secret redaction', () => {
    const result: ExecutionResult = {
      planId: 'PLAN-20260604-0001',
      status: 'failed',
      steps: [
        {
          stepId: 's1',
          status: 'failed',
          output: 'doctor failed\nOPENSLACK_LLM_API_KEY=sk-abcdefghijklmnopqrstuvwxyz',
          exitCode: 1,
        },
      ],
      summary: 'Failed at step "Run multi-module health check"',
      nextActions: ['Check error output and retry'],
    };

    const summary = summarizeResults(result);

    expect(summary).toContain('Output:');
    expect(summary).toContain('doctor failed');
    expect(summary).toContain('[redacted secret]');
    expect(summary).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });
});

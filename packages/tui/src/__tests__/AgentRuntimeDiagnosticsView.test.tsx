import React from 'react';
import { describe, expect, it } from 'vitest';
import AgentRuntimeDiagnosticsView from '../views/AgentRuntimeDiagnosticsView.js';
import type { AgentRuntimeDiagnosticsViewModel } from '../view-models/agent-runtime.js';
import { assertNoLineExceedsWidth, renderAtColumns } from './helpers/render-at-columns.js';

function vm(status: 'PASS' | 'FAIL'): AgentRuntimeDiagnosticsViewModel {
  return {
    provider: 'aby',
    status,
    configSource: status === 'PASS' ? 'OPENSLACK_ABY_ROOT' : 'none',
    configPath: '/repo/.openslack.local/agent-runtime.json',
    root: status === 'PASS' ? '/aby' : 'not configured',
    command: 'bun',
    args: ['/aby/src/sidecar/entrypoints/runEntrypoint.ts', '/aby/src/sidecar/entrypoints/agentRunBridge.ts'],
    timeoutMs: '120000ms',
    safeEnvAllowed: ['AGENT_RUN_BRIDGE_RUNNER'],
    safeEnvRejected: status === 'PASS' ? [] : ['OPENSLACK_PRIVATE_KEY'],
    checks: [
      { name: 'config-source', status, detail: status === 'PASS' ? 'Using env' : 'No Aby root configured' },
    ],
    remediations: [status === 'PASS' ? 'Aby bridge runtime is configured and ready.' : 'Set OPENSLACK_ABY_ROOT.'],
  };
}

describe('AgentRuntimeDiagnosticsView', () => {
  it('renders PASS, FAIL, and not configured states at common widths', async () => {
    for (const model of [vm('PASS'), vm('FAIL')]) {
      const outputs = await renderAtColumns(
        React.createElement(AgentRuntimeDiagnosticsView, { model }),
        [80, 100, 120],
      );

      for (const [width, output] of outputs) {
        expect(output).toContain('Agent Runtime / aby');
        assertNoLineExceedsWidth(output, width);
      }
    }
  });
});

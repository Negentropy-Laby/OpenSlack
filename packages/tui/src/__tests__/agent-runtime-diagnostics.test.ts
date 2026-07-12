import { describe, expect, it } from 'vitest';
import type { AbyRuntimeDoctorReport } from '@openslack/agent-runtime';
import {
  mapAbyRuntimeDoctorToViewModel,
  renderPlainAgentRuntimeDiagnostics,
  renderPlain,
} from '../index.js';

function report(overrides: Partial<AbyRuntimeDoctorReport> = {}): AbyRuntimeDoctorReport {
  return {
    provider: 'aby',
    status: 'FAIL',
    readiness: 'not_configured',
    configSource: 'none',
    configPath: '/repo/.openslack.local/agent-runtime.json',
    root: undefined,
    resolvedRoot: undefined,
    command: 'bun',
    args: [],
    timeoutMs: 120000,
    env: { allowedKeys: [], rejectedKeys: [] },
    checks: [{ name: 'config-source', status: 'FAIL', detail: 'No Aby root configured' }],
    remediations: ['Set OPENSLACK_ABY_ROOT.'],
    remediation: 'Set OPENSLACK_ABY_ROOT.',
    ...overrides,
  };
}

describe('agent runtime diagnostics view model', () => {
  it('maps not configured reports without inventing state', () => {
    const vm = mapAbyRuntimeDoctorToViewModel(report());

    expect(vm.provider).toBe('aby');
    expect(vm.status).toBe('FAIL');
    expect(vm.readiness).toBe('not_configured');
    expect(vm.root).toBe('not configured');
    expect(vm.lastSmokeRun).toBeUndefined();
  });

  it('renders plain output without env values', () => {
    const vm = mapAbyRuntimeDoctorToViewModel(
      report({
        env: {
          allowedKeys: ['AGENT_RUN_SAFE_MODE'],
          rejectedKeys: ['OPENSLACK_PRIVATE_KEY'],
        },
      }),
    );
    const out = renderPlainAgentRuntimeDiagnostics(vm);

    expect(out).toContain('Agent Runtime / aby');
    expect(out).toContain('Safe env allowed: AGENT_RUN_SAFE_MODE');
    expect(out).toContain('Safe env rejected: OPENSLACK_PRIVATE_KEY');
    expect(out).not.toContain('should-not-leak');
  });

  it('is available through the plain renderer dispatch', () => {
    const vm = mapAbyRuntimeDoctorToViewModel(
      report({
        status: 'PASS',
        readiness: 'ready',
        configSource: 'OPENSLACK_ABY_ROOT',
        root: '/aby',
        resolvedRoot: '/aby',
        checks: [{ name: 'config-source', status: 'PASS', detail: 'Using env' }],
        remediations: ['Aby bridge runtime is configured and ready.'],
        remediation: 'Aby bridge runtime is configured and ready.',
      }),
    );

    expect(renderPlain('agent-runtime', vm)).toContain('[PASS] PASS');
  });
});

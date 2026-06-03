import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { agentRuntimeCommands, renderAbyRuntimeDoctorReport } from '../commands/agent-runtime.js';

const mockDiagnoseAbyRuntime = vi.fn();

const passReport = {
  provider: 'aby' as const,
  status: 'PASS' as const,
  configSource: 'OPENSLACK_ABY_ROOT' as const,
  configPath: '/repo/.openslack.local/agent-runtime.json',
  root: '/aby',
  resolvedRoot: '/aby',
  command: 'bun',
  args: ['/aby/src/sidecar/entrypoints/runEntrypoint.ts', '/aby/src/sidecar/entrypoints/agentRunBridge.ts'],
  env: { allowedKeys: ['AGENT_RUN_BRIDGE_RUNNER'], rejectedKeys: [] },
  checks: [
    { name: 'config-source', status: 'PASS' as const, detail: 'Using OPENSLACK_ABY_ROOT' },
    { name: 'safe-env', status: 'PASS' as const, detail: 'Allowed keys: AGENT_RUN_BRIDGE_RUNNER' },
  ],
  remediation: 'Aby bridge runtime is configured and ready.',
};

describe('agent-runtime command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDiagnoseAbyRuntime.mockReturnValue(passReport);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders Aby doctor reports without env values', () => {
    const output = renderAbyRuntimeDoctorReport({
      ...passReport,
      env: { allowedKeys: ['AGENT_RUN_SAFE_MODE'], rejectedKeys: ['OPENSLACK_PRIVATE_KEY'] },
    });

    expect(output).toContain('Provider: aby');
    expect(output).toContain('Status: PASS');
    expect(output).toContain('Safe env allowed: AGENT_RUN_SAFE_MODE');
    expect(output).toContain('Safe env rejected: OPENSLACK_PRIVATE_KEY');
    expect(output).not.toContain('secret');
  });

  it('renders multiple remediation lines as a list', () => {
    const output = renderAbyRuntimeDoctorReport({
      ...passReport,
      status: 'FAIL',
      checks: [
        { name: 'agentRunBridge.ts', status: 'FAIL' as const, detail: 'Missing bridge' },
        { name: 'safe-env', status: 'FAIL' as const, detail: 'Rejected unsafe keys: OPENSLACK_PRIVATE_KEY' },
      ],
      remediation: [
        'Update Aby to a bridge-capable checkout that contains src/sidecar/entrypoints/agentRunBridge.ts.',
        'Remove unsafe env keys from .openslack.local/agent-runtime.json; task content and secrets must not cross the bridge through env.',
      ].join('\n'),
    });

    expect(output).toContain('Remediation:\n  - Update Aby');
    expect(output).toContain('\n  - Remove unsafe env keys');
  });

  it('runs agent-runtime doctor --provider aby', async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const cmd = agentRuntimeCommands({
      diagnoseAbyRuntime: (options) => mockDiagnoseAbyRuntime(options),
    });
    await cmd.parseAsync(['node', 'openslack agent-runtime', 'doctor', '--provider', 'aby'], {
      from: 'node',
    });

    logSpy.mockRestore();

    expect(mockDiagnoseAbyRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ rootDir: expect.any(String), env: process.env }),
    );
    expect(logs.join('\n')).toContain('Agent Runtime Doctor');
    expect(logs.join('\n')).toContain('Status: PASS');
  });

  it('exits nonzero when Aby doctor fails', async () => {
    mockDiagnoseAbyRuntime.mockReturnValue({
      ...passReport,
      status: 'FAIL',
      checks: [{ name: 'config-source', status: 'FAIL', detail: 'No Aby root configured' }],
      remediation: 'Set OPENSLACK_ABY_ROOT.',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    const cmd = agentRuntimeCommands({
      diagnoseAbyRuntime: (options) => mockDiagnoseAbyRuntime(options),
    });
    await expect(
      cmd.parseAsync(['node', 'openslack agent-runtime', 'doctor', '--provider', 'aby'], {
        from: 'node',
      }),
    ).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('rejects unsupported providers', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    const cmd = agentRuntimeCommands({
      diagnoseAbyRuntime: (options) => mockDiagnoseAbyRuntime(options),
    });
    await expect(
      cmd.parseAsync(['node', 'openslack agent-runtime', 'doctor', '--provider', 'other'], {
        from: 'node',
      }),
    ).rejects.toThrow('process.exit');

    expect(mockDiagnoseAbyRuntime).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

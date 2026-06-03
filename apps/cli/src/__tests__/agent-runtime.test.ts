import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { agentRuntimeCommands, renderAbyRuntimeDoctorReport } from '../commands/agent-runtime.js';

const mockDiagnoseAbyRuntime = vi.fn();
const mockSetupAbyRuntime = vi.fn();
const mockRunAbyRuntimeSmoke = vi.fn();
const mockGetAgentRuntimeMcpStatus = vi.fn();

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
  remediations: ['Aby bridge runtime is configured and ready.'],
  remediation: 'Aby bridge runtime is configured and ready.',
};

describe('agent-runtime command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDiagnoseAbyRuntime.mockReturnValue(passReport);
    mockSetupAbyRuntime.mockReturnValue({
      provider: 'aby',
      mode: 'write',
      status: 'PASS',
      root: '/aby',
      resolvedRoot: '/aby',
      configPath: '/repo/.openslack.local/agent-runtime.json',
      command: 'bun',
      timeoutMs: 120000,
      wroteConfig: true,
      env: { allowedKeys: [], rejectedKeys: [] },
      configPreview: { aby: { root: '/aby', command: 'bun', timeoutMs: 120000 } },
      checks: [{ name: 'aby-root', status: 'PASS', detail: '/aby' }],
      remediations: ['Configuration written.'],
    });
    mockRunAbyRuntimeSmoke.mockResolvedValue({
      provider: 'aby',
      status: 'PASS',
      agentId: 'anthropic_architect_aby',
      doctor: passReport,
      runId: 'RUN-20260603-SMOKE',
      terminalReason: 'completed',
      stderrSummary: 'not captured',
      evidence: {
        runJson: '/repo/.openslack.local/agents/runs/RUN-20260603-SMOKE/run.json',
        metadataJson: '/repo/.openslack.local/agents/runs/RUN-20260603-SMOKE/metadata.json',
        transcriptJsonl: '/repo/.openslack.local/agents/runs/RUN-20260603-SMOKE/transcript.jsonl',
      },
      checks: [{ name: 'doctor', status: 'PASS', detail: 'doctor ok' }],
    });
    mockGetAgentRuntimeMcpStatus.mockReturnValue({
      provider: 'aby',
      status: 'PASS',
      scopeNote: 'OpenSlack validates MCP descriptors and namespaces; Aby owns MCP client lifecycle.',
      agentId: 'anthropic_architect_aby',
      requiredServers: ['github'],
      availableServers: ['github'],
      missingRequiredServers: [],
      descriptors: [{ name: 'github', required: true }],
      invalidTools: [],
      toolEvidence: [],
      remediations: ['MCP descriptors and transcript evidence are consistent.'],
    });
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
      remediations: [
        'Update Aby to a bridge-capable checkout that contains src/sidecar/entrypoints/agentRunBridge.ts.',
        'Remove unsafe env keys from .openslack.local/agent-runtime.json; task content and secrets must not cross the bridge through env.',
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

  it('renders JSON doctor output with stable redacted fields', async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const cmd = agentRuntimeCommands({
      diagnoseAbyRuntime: (options) => mockDiagnoseAbyRuntime(options),
    });
    await cmd.parseAsync(
      ['node', 'openslack agent-runtime', 'doctor', '--provider', 'aby', '--format', 'json'],
      { from: 'node' },
    );

    logSpy.mockRestore();
    const parsed = JSON.parse(logs.join('\n'));
    expect(parsed.provider).toBe('aby');
    expect(parsed.safeEnv.allowedKeys).toEqual(['AGENT_RUN_BRIDGE_RUNNER']);
    expect(parsed.remediations).toEqual(['Aby bridge runtime is configured and ready.']);
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });

  it('runs agent-runtime setup aby --write', async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const cmd = agentRuntimeCommands({
      diagnoseAbyRuntime: (options) => mockDiagnoseAbyRuntime(options),
      setupAbyRuntime: (options) => mockSetupAbyRuntime(options),
    });
    await cmd.parseAsync(
      ['node', 'openslack agent-runtime', 'setup', 'aby', '--root', '/aby', '--write'],
      { from: 'node' },
    );

    expect(mockSetupAbyRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ root: '/aby', write: true }),
    );
    expect(logs.join('\n')).toContain('Agent Runtime Setup');
    expect(logs.join('\n')).toContain('Config written: yes');
    logSpy.mockRestore();
  });

  it('runs agent-runtime smoke --provider aby', async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const cmd = agentRuntimeCommands({
      runAbyRuntimeSmoke: (options) => mockRunAbyRuntimeSmoke(options),
    });
    await cmd.parseAsync(
      ['node', 'openslack agent-runtime', 'smoke', '--provider', 'aby'],
      { from: 'node' },
    );

    expect(mockRunAbyRuntimeSmoke).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'anthropic_architect_aby' }),
    );
    expect(logs.join('\n')).toContain('Aby Runtime Smoke');
    expect(logs.join('\n')).toContain('RUN-20260603-SMOKE');
    logSpy.mockRestore();
  });

  it('runs agent-runtime mcp status', async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const cmd = agentRuntimeCommands({
      getAgentRuntimeMcpStatus: (options) => mockGetAgentRuntimeMcpStatus(options),
    });
    await cmd.parseAsync(
      ['node', 'openslack agent-runtime', 'mcp', 'status', '--provider', 'aby', '--agent', 'anthropic_architect_aby'],
      { from: 'node' },
    );

    expect(mockGetAgentRuntimeMcpStatus).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'anthropic_architect_aby' }),
    );
    expect(logs.join('\n')).toContain('Agent Runtime MCP Status');
    expect(logs.join('\n')).toContain('Aby owns MCP client lifecycle');
    logSpy.mockRestore();
  });

  it('rejects agent-runtime mcp status without an agent or run context', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    const cmd = agentRuntimeCommands({
      getAgentRuntimeMcpStatus: (options) => mockGetAgentRuntimeMcpStatus(options),
    });
    await expect(
      cmd.parseAsync(['node', 'openslack agent-runtime', 'mcp', 'status', '--provider', 'aby'], {
        from: 'node',
      }),
    ).rejects.toThrow('process.exit');

    expect(mockGetAgentRuntimeMcpStatus).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      'Pass --agent <agentId> or --run <runId> to inspect MCP status.',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits nonzero when Aby doctor fails', async () => {
    mockDiagnoseAbyRuntime.mockReturnValue({
      ...passReport,
      status: 'FAIL',
      checks: [{ name: 'config-source', status: 'FAIL', detail: 'No Aby root configured' }],
      remediations: ['Set OPENSLACK_ABY_ROOT.'],
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

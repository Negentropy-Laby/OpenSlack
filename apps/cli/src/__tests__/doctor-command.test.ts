import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { doctorCommands } from '../commands/doctor.js';

const mockListAbyRuntimeAgents = vi.fn();
const mockDiagnoseAbyRuntime = vi.fn();

vi.mock('@openslack/workspace', () => ({
  validateWorkspace: vi.fn(() => ({ valid: true, errors: [] })),
  readModules: vi.fn(() => ({ modules: [] })),
  validateModules: vi.fn(() => ({ valid: true, errors: [] })),
}));

vi.mock('@openslack/github', () => ({
  getClient: vi.fn(() => Promise.resolve({ isDryRun: true })),
}));

vi.mock('@openslack/runtime', () => ({
  detectGenesisShell: vi.fn(() => ({ command: 'echo genesis', detail: 'ok' })),
  renderFindingsPlain: vi.fn((findings: Array<{ status: string; title: string; detail: string }>) =>
    findings.map((finding) => `${finding.status}: ${finding.title}: ${finding.detail}`).join('\n'),
  ),
}));

vi.mock('@openslack/agent-runtime', () => ({
  listAbyRuntimeAgents: () => mockListAbyRuntimeAgents(),
  diagnoseAbyRuntime: (options: unknown) => mockDiagnoseAbyRuntime(options),
}));

async function runDoctor(): Promise<string> {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });

  const cmd = doctorCommands({ execSync: vi.fn(() => 'PASS') as never });
  try {
    await cmd.parseAsync(['node', 'openslack doctor'], { from: 'node' });
  } finally {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return logs.join('\n');
}

describe('doctor command agent runtime aggregation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAbyRuntimeAgents.mockReturnValue([]);
    mockDiagnoseAbyRuntime.mockReturnValue({
      status: 'PASS',
      remediations: ['ok'],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not fail when no registered agent requires Aby', async () => {
    const output = await runDoctor();

    expect(output).toContain('[WARN] Agent Runtime / Aby: Aby runtime not required');
    expect(mockDiagnoseAbyRuntime).not.toHaveBeenCalled();
  });

  it('fails when a registered Aby agent has failing runtime diagnostics', async () => {
    mockListAbyRuntimeAgents.mockReturnValue([{ agentId: 'anthropic_architect_aby' }]);
    mockDiagnoseAbyRuntime.mockReturnValue({
      status: 'FAIL',
      remediations: ['Set OPENSLACK_ABY_ROOT.'],
    });

    await expect(runDoctor()).rejects.toThrow('process.exit');
    expect(mockDiagnoseAbyRuntime).toHaveBeenCalled();
  });
});

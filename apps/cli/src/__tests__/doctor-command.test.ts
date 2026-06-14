import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { doctorCommands } from '../commands/doctor.js';

const mockListAbyRuntimeAgents = vi.fn();
const mockDiagnoseAbyRuntime = vi.fn();
const LLM_ENV_KEYS = [
  'OPENSLACK_LLM_PROVIDER',
  'OPENSLACK_LLM_API_KEY',
  'OPENSLACK_LLM_MODEL',
] as const;
let savedLlmEnv: Map<string, string | undefined>;

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

vi.mock('@openslack/operator', async () => {
  const actual = await vi.importActual<typeof import('../../../../packages/operator/src/llm-config.js')>(
    '../../../../packages/operator/src/llm-config.js',
  );
  return {
    describeLLMRoutingConfig: actual.describeLLMRoutingConfig,
  };
});

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
    savedLlmEnv = new Map(LLM_ENV_KEYS.map((key) => [key, process.env[key]]));
    vi.clearAllMocks();
    mockListAbyRuntimeAgents.mockReturnValue([]);
    mockDiagnoseAbyRuntime.mockReturnValue({
      status: 'PASS',
      remediations: ['ok'],
    });
  });

  afterEach(() => {
    for (const key of LLM_ENV_KEYS) {
      const value = savedLlmEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
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

  it('warns when OpenAI-compatible LLM routing is missing a model', async () => {
    process.env.OPENSLACK_LLM_PROVIDER = 'openai-compatible';
    process.env.OPENSLACK_LLM_API_KEY = 'dummy';
    delete process.env.OPENSLACK_LLM_MODEL;

    const output = await runDoctor();

    expect(output).toContain('[WARN] Intent Routing: misconfigured');
    expect(output).toContain('OPENSLACK_LLM_MODEL not set');
    expect(output).not.toContain('model: default');
  });
});

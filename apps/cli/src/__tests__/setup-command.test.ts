import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupCommands } from '../commands/setup.js';
import { execFileSync as actualExecFileSync, execSync as actualExecSync } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execSync: vi.fn((command: string) => {
    if (command.includes('github doctor')) {
      const err = new Error('GitHub doctor failed') as Error & { stderr?: Buffer };
      err.stderr = Buffer.from('Dry-run (no credentials)');
      throw err;
    }
    return Buffer.from('PASS');
  }),
  execFileSync: vi.fn(() => Buffer.from('PASS')),
}));

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    question: (_msg: string, cb: (answer: string) => void) => cb('n'),
    close: vi.fn(),
  })),
}));

const mockRecommendNextActions = vi.fn<
  (ctx?: unknown) => Array<{ priority: number; title: string; action: string; command?: string }>
>(() => [
  {
    priority: 6,
    title: 'All clear',
    action: 'No actions needed.',
    command: 'openslack ask "what next?"',
  },
]);
const mockRenderFindingsPlain = vi.fn<(findings?: unknown) => string>(
  () => 'OK: Workspace root\n  /repo',
);
const mockBuildSetupReport = vi.fn<(opts?: unknown) => Promise<unknown>>();
const mockGetNextSteps = vi.fn<
  () => Array<{ label: string; command: string; description: string }>
>(() => [
  {
    label: 'Check your workspace status',
    command: 'bun run openslack status',
    description: 'Show current workspace state, modules, and health',
  },
  {
    label: 'Review your PRs',
    command: 'bun run openslack pr list',
    description: 'List open pull requests and their status',
  },
  {
    label: 'See the team dashboard',
    command: 'bun run openslack collaboration dashboard',
    description: 'View team activity, events, and collaboration metrics',
  },
  {
    label: 'Get a role-specific guide',
    command: 'bun run openslack guide operator',
    description: 'Show the operator role guide with common workflows',
  },
  {
    label: 'Run diagnostics',
    command: 'bun run openslack doctor',
    description: 'Run a full diagnostic check on your workspace',
  },
]);
const LLM_ENV_KEYS = [
  'OPENSLACK_LLM_PROVIDER',
  'OPENSLACK_LLM_API_KEY',
  'OPENSLACK_LLM_MODEL',
] as const;
let savedLlmEnv: Map<string, string | undefined>;

vi.mock('@openslack/runtime', () => ({
  detectGenesisShell: vi.fn(() => ({
    status: 'ok',
    category: 'ok',
    title: 'Genesis validation shell',
    detail: 'Git Bash detected',
    command: 'git-bash scripts/genesis-validate.sh',
  })),
  buildSetupReport: (opts: unknown) => mockBuildSetupReport(opts),
  renderSetupReport: vi.fn(() => 'setup report'),
  recommendNextActions: (ctx: unknown) => mockRecommendNextActions(ctx),
  renderFindingsPlain: (findings: unknown) => mockRenderFindingsPlain(findings),
  getNextSteps: () => mockGetNextSteps(),
  runGoldenEval: vi.fn(() =>
    Array.from({ length: 7 }, (_, index) => ({ caseId: `case-${index}`, passed: true })),
  ),
}));

vi.mock('@openslack/github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openslack/github')>();
  return {
    ...actual,
    getClient: vi.fn(async () => ({ isDryRun: true, authMode: 'dry_run' })),
  };
});

vi.mock('@openslack/operator', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../packages/operator/src/llm-config.js')
  >('../../../../packages/operator/src/llm-config.js');
  return {
    describeLLMRoutingConfig: actual.describeLLMRoutingConfig,
  };
});

vi.mock('@openslack/collaboration', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('@openslack/agent-runtime', () => ({
  diagnoseAgentRuntime: vi.fn(() => ({
    status: 'FAIL',
    readiness: 'not_configured',
    remediations: ['Configure an agent runtime provider.'],
    providers: { aby: {} },
  })),
}));

const defaultFindings = [
  { id: 'repo-root', title: 'Workspace root', status: 'ok', detail: '/repo' },
  { id: 'git-remote', title: 'Git remote', status: 'ok', detail: 'origin configured' },
  { id: 'github-auth', title: 'GitHub auth', status: 'ok', detail: 'token set' },
  {
    id: 'github-labels',
    title: 'OpenSlack labels',
    status: 'fixable_by_command',
    detail: 'Can be repaired',
    command: 'openslack github repair labels --apply',
  },
  {
    id: 'branch-protection',
    title: 'Branch protection',
    status: 'requires_github_admin',
    detail: 'Check settings',
  },
];

async function runInteractive(args: string[]): Promise<string[]> {
  const command = setupCommands();
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });

  mockBuildSetupReport.mockResolvedValue({
    root: '/repo',
    generatedAt: new Date().toISOString(),
    dryRun: true,
    findings: defaultFindings,
  });

  await command.parseAsync(['node', 'openslack setup', 'interactive', ...args], { from: 'node' });
  logSpy.mockRestore();
  return logs;
}

async function runSmoke(): Promise<string[]> {
  const command = setupCommands();
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });

  try {
    await command.parseAsync(['node', 'openslack setup', 'smoke'], { from: 'node' });
  } catch (err) {
    if (!(err instanceof Error) || err.message !== 'process.exit') {
      throw err;
    }
  } finally {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return logs;
}

describe('setup interactive', () => {
  beforeEach(() => {
    savedLlmEnv = new Map(LLM_ENV_KEYS.map((key) => [key, process.env[key]]));
    vi.clearAllMocks();
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

  it('exists as a subcommand', () => {
    const command = setupCommands();
    const sub = command.commands.find((c) => c.name() === 'interactive');
    expect(sub).toBeDefined();
    expect(sub?.description()).toContain('interactive');
  });

  it('has --format option', () => {
    const command = setupCommands();
    const sub = command.commands.find((c) => c.name() === 'interactive');
    const formatOpt = sub?.options.find((o) => o.long === '--format');
    expect(formatOpt).toBeDefined();
  });

  it('classifies readiness from setup findings', async () => {
    const logs = await runInteractive([]);
    expect(logs.join('\n')).toContain('almost ready');
  });

  it('runs validation steps in-process without a source CLI child', async () => {
    await runInteractive([]);
    expect(vi.mocked(actualExecFileSync)).not.toHaveBeenCalled();
  });

  it('prints next steps from recommendNextActions', async () => {
    const logs = await runInteractive([]);
    expect(mockRecommendNextActions).toHaveBeenCalled();
    expect(logs.join('\n')).toContain('Recommended Next Steps');
  });

  it('--format plain outputs plain format without prompts', async () => {
    const logs = await runInteractive(['--format', 'plain']);
    expect(mockRenderFindingsPlain).toHaveBeenCalled();
    expect(logs.join('\n')).toContain('Readiness:');
  });

  it('reports ready when all findings are ok', async () => {
    mockBuildSetupReport.mockResolvedValue({
      root: '/repo',
      generatedAt: new Date().toISOString(),
      dryRun: true,
      findings: [
        { id: 'repo-root', title: 'Workspace root', status: 'ok', detail: '/repo' },
        { id: 'git-remote', title: 'Git remote', status: 'ok', detail: 'origin configured' },
      ],
    });
    const logs = await runInteractive([]);
    expect(logs.join('\n')).toContain('ready');
  });

  it('renders "What would you like to do next?" after interactive setup', async () => {
    const logs = await runInteractive([]);
    expect(logs.join('\n')).toContain('What would you like to do next?');
  });

  it('renders numbered options with commands in next steps guide', async () => {
    const logs = await runInteractive([]);
    const output = logs.join('\n');
    expect(output).toContain('1. Check your workspace status');
    expect(output).toContain('bun run openslack status');
    expect(output).toContain('2. Review your PRs');
    expect(output).toContain('bun run openslack pr list');
  });

  it('calls getNextSteps during interactive setup', async () => {
    await runInteractive([]);
    expect(mockGetNextSteps).toHaveBeenCalled();
  });

  it('renders all 5 discovery options with descriptions', async () => {
    const logs = await runInteractive([]);
    const output = logs.join('\n');
    expect(output).toContain('See the team dashboard');
    expect(output).toContain('Get a role-specific guide');
    expect(output).toContain('Run diagnostics');
  });

  it('setup smoke warns when OpenAI-compatible LLM routing is missing a model', async () => {
    process.env.OPENSLACK_LLM_PROVIDER = 'openai-compatible';
    process.env.OPENSLACK_LLM_API_KEY = 'dummy';
    delete process.env.OPENSLACK_LLM_MODEL;

    const output = (await runSmoke()).join('\n');

    expect(output).toContain('⚠ Intent Routing: misconfigured');
    expect(output).not.toContain('model: default');
  });

  it('runs normal-workspace setup without source CLI, golden, or Genesis assumptions', async () => {
    const logs: string[] = [];
    const runGolden = vi.fn(() => []);
    const command = setupCommands({
      resolveContext: () =>
        ({
          productHome: '/product',
          workspaceRoot: '/ordinary-repo',
          projectStateRoot: '/ordinary-repo/.openslack',
          localStateRoot: '/ordinary-repo/.openslack.local',
          sourceCheckout: false,
          assetResolver: { readText: vi.fn() },
        }) as never,
      validate: vi.fn(() => ({ valid: true, errors: [] })),
      runGolden,
      getGitHubClient: vi.fn(async () => ({ isDryRun: true, authMode: 'dry_run' }) as never),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    try {
      await expect(command.parseAsync(['node', 'openslack'], { from: 'node' })).rejects.toThrow(
        'process.exit',
      );
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
    expect(logs.join('\n')).toContain('[PASS] Source maintenance');
    expect(runGolden).not.toHaveBeenCalled();
    expect(vi.mocked(actualExecFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(actualExecSync)).not.toHaveBeenCalled();
  });
});

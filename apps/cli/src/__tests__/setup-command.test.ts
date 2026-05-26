import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupCommands } from '../commands/setup.js';
import { execFileSync as actualExecFileSync } from 'node:child_process';

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

const mockRecommendNextActions = vi.fn<(ctx?: unknown) => Array<{ priority: number; title: string; action: string; command?: string }>>(() => [
  { priority: 6, title: 'All clear', action: 'No actions needed.', command: 'openslack ask "what next?"' },
]);
const mockRenderFindingsPlain = vi.fn<(findings?: unknown) => string>(() => 'OK: Workspace root\n  /repo');
const mockBuildSetupReport = vi.fn<(opts?: unknown) => Promise<unknown>>();

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
}));

vi.mock('@openslack/collaboration', () => ({
  recordEvent: vi.fn(),
}));

const defaultFindings = [
  { id: 'repo-root', title: 'Workspace root', status: 'ok', detail: '/repo' },
  { id: 'git-remote', title: 'Git remote', status: 'ok', detail: 'origin configured' },
  { id: 'github-auth', title: 'GitHub auth', status: 'ok', detail: 'token set' },
  { id: 'github-labels', title: 'OpenSlack labels', status: 'fixable_by_command', detail: 'Can be repaired', command: 'openslack github repair labels --apply' },
  { id: 'branch-protection', title: 'Branch protection', status: 'requires_github_admin', detail: 'Check settings' },
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

describe('setup interactive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
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

  it('runs validation steps via execFileSync', async () => {
    await runInteractive([]);
    expect(vi.mocked(actualExecFileSync)).toHaveBeenCalled();
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
});

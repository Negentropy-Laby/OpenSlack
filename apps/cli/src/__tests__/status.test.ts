import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { statusCommands } from '../commands/status.js';
import type { AttentionItem } from '@openslack/runtime';

const mockReadModules = vi.fn(() => ({
  schema: 'openslack.modules.v1',
  modules: [
    { name: 'runtime', phase: '1', status: 'active', tests: 42, packages: ['@openslack/runtime'] },
    { name: 'collaboration', phase: '2', status: 'active', tests: 30, packages: ['@openslack/collaboration'] },
  ],
}));
const mockValidateModules = vi.fn(() => ({ valid: true, errors: [] }));
const mockGetTotalTests = vi.fn(() => 72);
const mockGetTotalTestFiles = vi.fn(() => 12);

vi.mock('@openslack/workspace', () => ({
  readModules: () => mockReadModules(),
  validateModules: () => mockValidateModules(),
  getTotalTests: () => mockGetTotalTests(),
  getTotalTestFiles: () => mockGetTotalTestFiles(),
}));

const mockRecommendNextActions = vi.fn(() => [
  { priority: 3, title: '2 PRs blocked', action: 'Check what is blocking.', command: 'openslack pr doctor <n>' },
]);
const mockBuildSetupReport = vi.fn(() =>
  Promise.resolve({
    root: '/repo',
    generatedAt: new Date().toISOString(),
    dryRun: true,
    findings: [
      { id: 'repo-root', title: 'Workspace root', status: 'ok', detail: '/repo' },
      { id: 'git-remote', title: 'Git remote', status: 'ok', detail: 'origin configured' },
    ],
  }),
);

const mockGetAttentionItems = vi.fn<() => Promise<AttentionItem[]>>(() =>
  Promise.resolve([
    { type: 'pr', description: '2 PRs blocked', action: 'Check what is blocking the PR.', priority: 'medium' },
  ]),
);
const mockGetNextAction = vi.fn<(items: AttentionItem[]) => string>(() => '2 PRs blocked: Check what is blocking the PR.');

vi.mock('@openslack/runtime', () => ({
  recommendNextActions: () => mockRecommendNextActions(),
  buildSetupReport: () => mockBuildSetupReport(),
  getAttentionItems: () => mockGetAttentionItems(),
  getNextAction: (items: AttentionItem[]) => mockGetNextAction(items),
}));

const mockBuildDashboardProjection = vi.fn(() => ({
  generatedAt: new Date().toISOString(),
  sinceHours: 24,
  taskCounts: {},
  prCounts: {},
  blockerCount: 0,
  blockers: [],
  openHandoffs: 0,
  activeDecisions: 0,
  recentEvents: [],
  openHandoffDetails: [],
  activeDecisionDetails: [],
  appliedFilters: {},
}));

vi.mock('@openslack/collaboration', () => ({
  buildDashboardProjection: () => mockBuildDashboardProjection(),
}));

const mockDiagnoseAgentRuntime = vi.fn((_options?: unknown) => ({
  status: 'FAIL',
  readiness: 'not_configured',
  remediations: ['Configure an agent runtime provider.'],
  providers: { aby: {} },
}));

vi.mock('@openslack/agent-runtime', () => ({
  diagnoseAgentRuntime: (options: unknown) => mockDiagnoseAgentRuntime(options),
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn((command: string) => {
    if (command.includes('rev-list --count')) return '100';
    if (command.includes('rev-parse --short')) return 'abc1234';
    if (command.includes('log -1 --format=%s')) return 'test commit';
    if (command.includes('gh ')) {
      throw new Error('gh not available');
    }
    return '';
  }),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
}));

async function runStatus(): Promise<string[]> {
  const command = statusCommands();
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  // Suppress process.exit inside the command handler
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

  await command.parseAsync(['node', 'openslack'], { from: 'node' });

  logSpy.mockRestore();
  errorSpy.mockRestore();
  exitSpy.mockRestore();
  return logs;
}

describe('status command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders Needs Attention section', async () => {
    const logs = await runStatus();
    const output = logs.join('\n');
    expect(output).toContain('Needs Attention:');
  });

  it('reports agent runtime readiness separately from module status', async () => {
    const logs = await runStatus();
    const output = logs.join('\n');
    expect(output).toContain('Agent Runtime: not_configured');
    expect(output).toContain('Configure an agent runtime provider.');
  });

  it('renders attention item with priority label', async () => {
    const logs = await runStatus();
    const output = logs.join('\n');
    expect(output).toContain('[MEDIUM]');
    expect(output).toContain('pr:');
    expect(output).toContain('2 PRs blocked');
  });

  it('renders Recommended Next Action line', async () => {
    const logs = await runStatus();
    const output = logs.join('\n');
    expect(output).toContain('Recommended Next Action:');
    expect(output).toContain('2 PRs blocked');
  });

  it('explains raw and module-attributed test counts separately', async () => {
    const logs = await runStatus();
    const output = logs.join('\n');
    expect(output).toContain('Raw passing Vitest count from .openslack/modules.yaml');
    expect(output).toContain('Module-attributed counts (72 tests, 12 files)');
  });

  it('shows All clear when no attention items', async () => {
    mockGetAttentionItems.mockResolvedValueOnce([]);
    mockGetNextAction.mockReturnValueOnce('All clear — no immediate actions needed.');
    const logs = await runStatus();
    const output = logs.join('\n');
    expect(output).toContain('All clear');
  });

  it('calls getAttentionItems with context derived from setup and dashboard', async () => {
    await runStatus();
    expect(mockGetAttentionItems).toHaveBeenCalled();
  });

  it('calls getNextAction with the attention items', async () => {
    await runStatus();
    expect(mockGetNextAction).toHaveBeenCalled();
  });

  it('renders multiple attention items with all priority labels', async () => {
    const multiItems: AttentionItem[] = [
      { type: 'health', description: 'Health failed', action: 'Run doctor', priority: 'high' },
      { type: 'pr', description: '2 PRs blocked', action: 'Check blockers', priority: 'medium' },
      { type: 'task', description: '5 tasks ready', action: 'Claim a task', priority: 'low' },
    ];
    mockGetAttentionItems.mockResolvedValueOnce(multiItems);
    const logs = await runStatus();
    const output = logs.join('\n');
    expect(output).toContain('[HIGH]');
    expect(output).toContain('[MEDIUM]');
    expect(output).toContain('[LOW]');
  });
});

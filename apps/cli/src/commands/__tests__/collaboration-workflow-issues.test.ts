import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { collaborationCommands, resolveWorkflowInspectionAuthority } from '../collaboration.js';

const hoisted = vi.hoisted(() => {
  class RunnerControlError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  class RoutingConfigError extends Error {
    readonly code = 'WORKFLOW_RUN_ROUTING_CONFIG_INVALID';
  }
  class RoutingError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    finalizeWorkflowLifecycle: vi.fn(),
    loadRunnerConfig: vi.fn(),
    loadRoutingConfig: vi.fn(),
    createRoutingContext: vi.fn(),
    createRouteJournal: vi.fn(),
    openRunReadOnly: vi.fn(),
    inspectReadOnly: vi.fn(),
    readWorkflowPolicy: vi.fn(),
    RunnerControlError,
    RoutingConfigError,
    RoutingError,
  };
});

vi.mock('@openslack/github', () => ({
  publishWorkflowProposal: vi.fn(),
  publishWorkflowReviewRequest: vi.fn(),
  publishWorkflowRunAudit: vi.fn(),
  publishWorkflowImprovement: vi.fn(),
  publishWorkflowSplit: vi.fn(),
  bootstrapWorkflowLabels: vi.fn(),
}));

vi.mock('@openslack/pr', () => ({
  finalizeWorkflowLifecycle: (...args: unknown[]) => hoisted.finalizeWorkflowLifecycle(...args),
}));

vi.mock('@openslack/workflows', () => ({
  findWorkflow: vi.fn(),
  loadWorkflow: vi.fn(),
  discoverJsWorkflows: vi.fn().mockResolvedValue([]),
  discoverYamlTemplates: vi.fn().mockResolvedValue([]),
  executePreview: vi.fn(),
  executeDryRun: vi.fn(),
  createWorkflowRunRouteJournal: (...args: unknown[]) => hoisted.createRouteJournal(...args),
  createWorkflowRunRoutingExecutionContext: (...args: unknown[]) =>
    hoisted.createRoutingContext(...args),
  openWorkflowRunReadOnly: (...args: unknown[]) => hoisted.openRunReadOnly(...args),
  loadWorkflowRunnerControlConfig: (...args: unknown[]) => hoisted.loadRunnerConfig(...args),
  loadWorkflowRunRoutingConfig: (...args: unknown[]) => hoisted.loadRoutingConfig(...args),
  inspectWorkflowRunReadOnly: (...args: unknown[]) => hoisted.inspectReadOnly(...args),
  WorkflowRunnerControlError: hoisted.RunnerControlError,
  WorkflowRunRoutingConfigError: hoisted.RoutingConfigError,
  WorkflowRunRoutingError: hoisted.RoutingError,
  checkResumable: vi.fn(),
  prepareResume: vi.fn(),
  renderRunHtml: vi.fn(),
  renderRunJson: vi.fn(),
  renderRunMarkdown: vi.fn(),
  listWorkflowPatterns: vi.fn().mockReturnValue([]),
  getWorkflowPattern: vi.fn(),
  renderWorkflowPattern: vi.fn(),
  generateWorkflowDraft: vi.fn(),
  previewWorkflowDraft: vi.fn(),
  renderWorkflowDraftPreview: vi.fn(),
  readWorkflowPolicy: (...args: unknown[]) => hoisted.readWorkflowPolicy(...args),
  writeWorkflowPolicy: vi.fn(),
  renderWorkflowPolicy: vi.fn(),
  listWorkflowRuns: vi.fn().mockResolvedValue([]),
  showWorkflowRun: vi.fn(),
  renderWorkflowRuns: vi.fn(),
  renderWorkflowRun: vi.fn(),
  saveWorkflow: vi.fn(),
  exportWorkflowSkill: vi.fn(),
  TrustStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockReturnValue('untrusted'),
    set: vi.fn(),
    save: vi.fn(),
    list: vi.fn().mockReturnValue({}),
  })),
  resolveTrustLevel: vi.fn().mockReturnValue('untrusted'),
  getPermissionsForTrustLevel: vi.fn().mockReturnValue(new Set(['read'])),
}));

describe('collaboration workflow issue commands', () => {
  function createTestProgram(): Command {
    const program = new Command();
    program.addCommand(collaborationCommands());
    return program;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.finalizeWorkflowLifecycle.mockResolvedValue({
      status: 'finalized',
      result: {
        closedIssues: [186],
        commentedIssues: [186],
        updatedLabels: [],
        errors: [],
        failures: [],
      },
    });
    process.exitCode = undefined;
    hoisted.loadRunnerConfig.mockReturnValue({
      origin: 'http://127.0.0.1:18183',
      workspaceId: 'workspace.test',
      bearerToken: 'a'.repeat(32),
      descriptorRoot: 'C:\\runner-descriptors',
    });
    hoisted.loadRoutingConfig.mockReturnValue({ mode: 'disabled', ignoredSettings: [] });
    hoisted.createRouteJournal.mockReturnValue({
      locateReadOnly: vi.fn().mockResolvedValue(null),
    });
    hoisted.createRoutingContext.mockReturnValue({
      mode: 'disabled',
      authority: undefined,
      journal: { locateReadOnly: vi.fn().mockResolvedValue(null) },
    });
    hoisted.openRunReadOnly.mockReturnValue({
      getRunStatus: vi.fn().mockResolvedValue(null),
    });
    hoisted.readWorkflowPolicy.mockReturnValue({
      enabled: true,
      ultracode: false,
      maxConcurrency: 16,
      maxAgentsPerRun: 1000,
      source: 'default',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('workflow publish command exists', () => {
    const program = createTestProgram();
    const publish = program.commands
      .find((c) => c.name() === 'collaboration')
      ?.commands.find((c) => c.name() === 'workflow')
      ?.commands.find((c) => c.name() === 'publish');
    expect(publish).toBeDefined();
    expect(publish?.description()).toContain('proposal');
  });

  it('workflow review-request command exists', () => {
    const program = createTestProgram();
    const review = program.commands
      .find((c) => c.name() === 'collaboration')
      ?.commands.find((c) => c.name() === 'workflow')
      ?.commands.find((c) => c.name() === 'review-request');
    expect(review).toBeDefined();
    expect(review?.description()).toContain('review');
  });

  it('workflow audit-run command exists', () => {
    const program = createTestProgram();
    const audit = program.commands
      .find((c) => c.name() === 'collaboration')
      ?.commands.find((c) => c.name() === 'workflow')
      ?.commands.find((c) => c.name() === 'audit-run');
    expect(audit).toBeDefined();
    expect(audit?.description()).toContain('audit');
  });

  it('workflow split command exists', () => {
    const program = createTestProgram();
    const split = program.commands
      .find((c) => c.name() === 'collaboration')
      ?.commands.find((c) => c.name() === 'workflow')
      ?.commands.find((c) => c.name() === 'split');
    expect(split).toBeDefined();
    expect(split?.description()).toContain('Split');
  });

  it('workflow labels command exists', () => {
    const program = createTestProgram();
    const labels = program.commands
      .find((c) => c.name() === 'collaboration')
      ?.commands.find((c) => c.name() === 'workflow')
      ?.commands.find((c) => c.name() === 'labels');
    expect(labels).toBeDefined();
    expect(labels?.description()).toContain('labels');
  });

  it('workflow improvement command exists', () => {
    const program = createTestProgram();
    const improvement = program.commands
      .find((c) => c.name() === 'collaboration')
      ?.commands.find((c) => c.name() === 'workflow')
      ?.commands.find((c) => c.name() === 'improvement');
    expect(improvement).toBeDefined();
    expect(improvement?.description()).toContain('improvement');
  });

  it('workflow finalize-pr command exists', () => {
    const program = createTestProgram();
    const finalize = program.commands
      .find((c) => c.name() === 'collaboration')
      ?.commands.find((c) => c.name() === 'workflow')
      ?.commands.find((c) => c.name() === 'finalize-pr');
    expect(finalize).toBeDefined();
    expect(finalize?.description()).toContain('Finalize');
  });

  it('omits authority only when runner and routing configuration are entirely absent', () => {
    expect(resolveWorkflowInspectionAuthority('C:\\workspace', {})).toBeUndefined();
    expect(hoisted.loadRunnerConfig).not.toHaveBeenCalled();
  });

  it('reports partial runner configuration instead of mislabeling it as missing authority', async () => {
    vi.stubEnv('OPENSLACK_WORKFLOW_RUNNER_CONTROL_ORIGIN', 'invalid');
    hoisted.loadRunnerConfig.mockImplementation(() => {
      throw new hoisted.RunnerControlError(
        'WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID',
        'Workflow runner transport is incomplete.',
      );
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createTestProgram().parseAsync([
      'node',
      'test',
      'collaboration',
      'workflow',
      'runs',
      'inspect',
      'run.partial',
    ]);

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      'WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID: Workflow runner transport is incomplete.',
    );
    expect(hoisted.inspectReadOnly).not.toHaveBeenCalled();
  });

  it('keeps the removed rollback value fail-closed as unsupported', async () => {
    vi.stubEnv('OPENSLACK_WORKFLOW_RUN_ROUTING_MODE', 'ts-new-record-rollback-v1');
    hoisted.loadRoutingConfig.mockImplementation(() => {
      throw new hoisted.RoutingConfigError('Workflow run routing mode is unsupported.');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createTestProgram().parseAsync([
      'node',
      'test',
      'collaboration',
      'workflow',
      'runs',
      'inspect',
      'run.retired',
    ]);

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      'WORKFLOW_RUN_ROUTING_CONFIG_INVALID: Workflow run routing mode is unsupported.',
    );
    expect(hoisted.inspectReadOnly).not.toHaveBeenCalled();
  });

  it('prints reconciliation inspection JSON and exits nonzero', async () => {
    vi.stubEnv('OPENSLACK_WORKFLOW_RUNNER_CONTROL_ORIGIN', 'configured');
    hoisted.inspectReadOnly.mockResolvedValue({
      schema: 'openslack.workflow_run_readonly_inspection.v1',
      runId: 'run.reconcile',
      ownership: 'unresolved-route',
      disposition: 'reconciliation-required',
      route: null,
      authorityHead: null,
      localEvidence: { typescriptHistorical: null, goRecovery: null },
      diagnostics: ['WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED'],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createTestProgram().parseAsync([
      'node',
      'test',
      'collaboration',
      'workflow',
      'runs',
      'inspect',
      'run.reconcile',
    ]);

    expect(process.exitCode).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"reconciliation-required"'));
  });

  it('refuses Go-owned and unresolved historical exports with stable runs-inspect guidance', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const fixture of [
      {
        ownership: 'go-workflow-control',
        disposition: 'authority-required',
        code: 'WORKFLOW_RUN_HISTORICAL_EXPORT_GO_OWNED',
        command: ['inspect', 'run.go'],
      },
      {
        ownership: 'unresolved-route',
        disposition: 'reconciliation-required',
        code: 'WORKFLOW_RUN_HISTORICAL_EXPORT_ROUTE_UNRESOLVED',
        command: ['audit-run', 'run.unresolved'],
      },
    ] as const) {
      hoisted.inspectReadOnly.mockResolvedValue({
        schema: 'openslack.workflow_run_readonly_inspection.v1',
        runId: fixture.command[1],
        ownership: fixture.ownership,
        disposition: fixture.disposition,
        route: null,
        authorityHead: null,
        localEvidence: { typescriptHistorical: null, goRecovery: null },
        diagnostics: [],
      });
      process.exitCode = undefined;
      error.mockClear();

      await createTestProgram().parseAsync([
        'node',
        'test',
        'collaboration',
        'workflow',
        ...fixture.command,
      ]);

      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining(fixture.code));
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(`workflow runs inspect ${fixture.command[1]}`),
      );
    }
  });

  it('refuses resume cleanly when read-only route evidence needs reconciliation', async () => {
    vi.stubEnv('OPENSLACK_WORKFLOW_RUNNER_CONTROL_ORIGIN', 'configured');
    hoisted.createRoutingContext.mockReturnValue({
      mode: 'explicit',
      journal: {
        locateReadOnly: vi
          .fn()
          .mockRejectedValue(
            new hoisted.RoutingError(
              'WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED',
              'unsafe route fixture',
            ),
          ),
      },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createTestProgram().parseAsync([
      'node',
      'test',
      'collaboration',
      'workflow',
      'resume',
      'run.route-error',
    ]);

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED'),
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('workflow runs inspect run.route-error'),
    );
  });

  it('passes explicit targets and evidence claims to the package coordinator unchanged', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createTestProgram().parseAsync([
      'node',
      'test',
      'collaboration',
      'workflow',
      'finalize-pr',
      '185',
      '--governance-issue',
      '186',
      '--proposal-issue',
      '187',
      '--review-issue',
      '188',
      '--phase-issues',
      '189,190',
      '--hash',
      'sha256:evidence',
      '--trust',
      'core',
    ]);
    expect(hoisted.finalizeWorkflowLifecycle).toHaveBeenCalledExactlyOnceWith({
      prNumber: 185,
      mode: 'explicit-targets',
      governanceIssue: 186,
      proposalIssue: 187,
      reviewIssue: 188,
      phaseIssues: [189, 190],
      hash: 'sha256:evidence',
      trust: 'core',
    });
  });

  it('reports publisher partial failure without claiming finalization complete', async () => {
    hoisted.finalizeWorkflowLifecycle.mockResolvedValue({
      status: 'finalized',
      result: {
        closedIssues: [],
        commentedIssues: [186],
        updatedLabels: [],
        errors: ['write failed'],
        failures: [{ code: 'LIFECYCLE_WRITE_FAILED', stage: 'labels' }],
      },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createTestProgram().parseAsync([
      'node',
      'test',
      'collaboration',
      'workflow',
      'finalize-pr',
      '185',
    ]);
    expect(process.exitCode).toBe(1);
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('Failed to finalize workflow PR #185');
    expect(output).toContain('"commentedIssues":[186]');
    expect(output).not.toContain('finalize complete');
  });

  it.each([
    ['hash', ['--hash', 'sha256:wrong']],
    ['trust', ['--trust', 'trusted']],
    ['issue', ['--governance-issue', '187']],
  ])('preserves the package %s refusal', async (_name, options) => {
    hoisted.finalizeWorkflowLifecycle.mockResolvedValue({
      status: 'refused',
      message: 'Cannot override verified evidence.',
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createTestProgram().parseAsync([
      'node',
      'test',
      'collaboration',
      'workflow',
      'finalize-pr',
      '185',
      ...options,
    ]);
    expect(process.exitCode).toBe(1);
    expect(log).toHaveBeenCalledWith('Cannot override verified evidence.');
    expect(log.mock.calls.flat().join('\n')).not.toContain('finalize complete');
  });

  it.each([
    ['--hash', 'sha256:unverified'],
    ['--trust', 'core'],
  ])('does not drop %s before the package can reject an unsupported claim', async (flag, value) => {
    hoisted.finalizeWorkflowLifecycle.mockResolvedValue({
      status: 'refused',
      message: 'Repository evidence is unavailable.',
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createTestProgram().parseAsync([
      'node',
      'test',
      'collaboration',
      'workflow',
      'finalize-pr',
      '185',
      '--review-issue',
      '186',
      flag,
      value,
    ]);
    expect(hoisted.finalizeWorkflowLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'explicit-targets',
        reviewIssue: 186,
        [flag === '--hash' ? 'hash' : 'trust']: value,
      }),
    );
    expect(process.exitCode).toBe(1);
  });

  it('dynamic workflow parity commands exist', () => {
    const workflow = createTestProgram()
      .commands.find((c) => c.name() === 'collaboration')
      ?.commands.find((c) => c.name() === 'workflow');
    const names = workflow?.commands.map((c) => c.name()) ?? [];
    expect(names).toEqual(
      expect.arrayContaining([
        'patterns',
        'generate',
        'preview-draft',
        'runs',
        'config',
        'save',
        'export-skill',
      ]),
    );
  });

  it('renders the shared credential-free preview without claiming completion', async () => {
    hoisted.finalizeWorkflowLifecycle.mockResolvedValue({
      status: 'preview',
      result: { dryRun: true },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createTestProgram().parseAsync([
      'node',
      'test',
      'collaboration',
      'workflow',
      'finalize-pr',
      '185',
    ]);
    expect(log.mock.calls.flat().join('\n')).toContain('preview only');
    expect(log.mock.calls.flat().join('\n')).not.toContain('finalize complete');
    expect(process.exitCode).toBeUndefined();
  });

  it('does not relabel a coordinator exception as success', async () => {
    hoisted.finalizeWorkflowLifecycle.mockRejectedValue(new Error('live evidence unavailable'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createTestProgram().parseAsync([
      'node',
      'test',
      'collaboration',
      'workflow',
      'finalize-pr',
      '185',
    ]);
    expect(process.exitCode).toBe(1);
    expect(log.mock.calls.flat().join('\n')).toContain('live evidence unavailable');
    expect(log.mock.calls.flat().join('\n')).not.toContain('finalize complete');
  });

  it('preserves explicitly selected non-governance lifecycle targets', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createTestProgram().parseAsync([
      'node',
      'test',
      'collaboration',
      'workflow',
      'finalize-pr',
      '185',
      '--proposal-issue',
      '187',
      '--review-issue',
      '188',
      '--phase-issues',
      '189,190',
    ]);
    expect(hoisted.finalizeWorkflowLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        prNumber: 185,
        mode: 'explicit-targets',
        proposalIssue: 187,
        reviewIssue: 188,
        phaseIssues: [189, 190],
      }),
    );
  });
});

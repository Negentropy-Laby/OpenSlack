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
    evaluateWorkflowGate: vi.fn(),
    fetchPRDetails: vi.fn(),
    finalizeWorkflowPR: vi.fn(),
    loadPRCodeownerEvidence: vi.fn(),
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
  finalizeWorkflowPR: (...args: unknown[]) => hoisted.finalizeWorkflowPR(...args),
}));

vi.mock('@openslack/pr', () => ({
  evaluateWorkflowGate: (...args: unknown[]) => hoisted.evaluateWorkflowGate(...args),
  fetchPRDetails: (...args: unknown[]) => hoisted.fetchPRDetails(...args),
  loadPRCodeownerEvidence: (...args: unknown[]) => hoisted.loadPRCodeownerEvidence(...args),
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

  it('exits nonzero and does not report completion when a GitHub finalizer write fails', async () => {
    const workflowEvidence = {
      schema: 'openslack.workflow-evidence.v1',
      baseSha: 'base-sha',
      headSha: 'head-sha',
      evidenceHash: 'sha256:evidence',
      artifactFiles: ['packages/workflows/src/builtins/profile-sync.ts'],
      addedFiles: [],
      modifiedFiles: ['packages/workflows/src/builtins/profile-sync.ts'],
      deletedFiles: [],
      changeKind: 'modified',
    };
    hoisted.fetchPRDetails.mockResolvedValue({
      prNumber: 185,
      author: 'openslack-agent-operator[bot]',
      body: 'Workflow governance #186',
      baseSha: 'base-sha',
      headSha: 'head-sha',
      changedFiles: ['packages/workflows/src/builtins/profile-sync.ts'],
      reviews: [],
      workflowEvidence,
    });
    hoisted.loadPRCodeownerEvidence.mockResolvedValue({
      ref: 'base-sha',
      owners: ['@wsman'],
      entries: [],
    });
    hoisted.evaluateWorkflowGate.mockReturnValue({
      overall: 'PASS',
      evidenceHash: 'sha256:evidence',
      trustDecision: 'core',
      trustReviewer: 'wsman',
      trustReviewCommitOid: 'head-sha',
      governanceIssue: 186,
    });
    hoisted.finalizeWorkflowPR.mockResolvedValue({
      closedIssues: [],
      commentedIssues: [186],
      updatedLabels: [],
      errors: ['Failed to finalize governance issue #186: write failed'],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await createTestProgram().parseAsync([
        'node',
        'test',
        'collaboration',
        'workflow',
        'finalize-pr',
        '185',
        '--governance-issue',
        '186',
        '--hash',
        'sha256:evidence',
        '--trust',
        'core',
      ]);

      expect(process.exitCode).toBe(1);
      expect(hoisted.finalizeWorkflowPR).toHaveBeenCalledWith(185, {
        governanceIssue: 186,
        proposalIssue: undefined,
        reviewIssue: undefined,
        phaseIssues: undefined,
        workflowHash: 'sha256:evidence',
        trustDecision: 'core',
        trustReviewer: 'wsman',
        trustReviewCommitOid: 'head-sha',
      });
      expect(log.mock.calls.flat().join('\n')).toContain('Failed to finalize workflow PR #185');
      expect(log.mock.calls.flat().join('\n')).not.toContain('finalize complete');
    } finally {
      process.exitCode = previousExitCode;
      log.mockRestore();
    }
  });

  it.each([
    ['hash', ['--governance-issue', '186', '--hash', 'sha256:wrong', '--trust', 'core']],
    ['trust', ['--governance-issue', '186', '--hash', 'sha256:evidence', '--trust', 'trusted']],
    ['issue', ['--governance-issue', '187', '--hash', 'sha256:evidence', '--trust', 'core']],
  ])('rejects a CLI %s override before any finalizer write', async (_name, overrides) => {
    hoisted.fetchPRDetails.mockResolvedValue({
      prNumber: 185,
      author: 'openslack-agent-operator[bot]',
      body: 'Workflow governance #186',
      baseSha: 'base-sha',
      headSha: 'head-sha',
      changedFiles: ['packages/workflows/src/builtins/profile-sync.ts'],
      reviews: [],
      workflowEvidence: {
        schema: 'openslack.workflow-evidence.v1',
        baseSha: 'base-sha',
        headSha: 'head-sha',
        evidenceHash: 'sha256:evidence',
        artifactFiles: ['packages/workflows/src/builtins/profile-sync.ts'],
        addedFiles: [],
        modifiedFiles: ['packages/workflows/src/builtins/profile-sync.ts'],
        deletedFiles: [],
        changeKind: 'modified',
      },
    });
    hoisted.loadPRCodeownerEvidence.mockResolvedValue({
      ref: 'base-sha',
      owners: ['@wsman'],
      entries: [],
    });
    hoisted.evaluateWorkflowGate.mockReturnValue({
      overall: 'PASS',
      evidenceHash: 'sha256:evidence',
      trustDecision: 'core',
      trustReviewer: 'wsman',
      trustReviewCommitOid: 'head-sha',
      governanceIssue: 186,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await createTestProgram().parseAsync([
        'node',
        'test',
        'collaboration',
        'workflow',
        'finalize-pr',
        '185',
        ...overrides,
      ]);

      expect(process.exitCode).toBe(1);
      expect(hoisted.finalizeWorkflowPR).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join('\n')).toContain('Cannot override');
    } finally {
      log.mockRestore();
    }
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
});

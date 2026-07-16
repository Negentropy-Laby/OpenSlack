import { Command } from 'commander';
import { execSync, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  buildSetupReport,
  detectGenesisShell,
  diagnoseLocalStateCompatibility,
  renderSetupReport,
  recommendNextActions,
  renderFindingsPlain,
  getNextSteps,
  getOnboardingStepGuide,
  OnboardingStore,
  migrateLocalStateSchemas,
  runGoldenEval,
} from '@openslack/runtime';
import type { OnboardingState, OnboardingStepId, PlainFinding } from '@openslack/runtime';
import { describeLLMRoutingConfig } from '@openslack/operator';
import type { LLMPlannerProviderRegistryPort } from '@openslack/operator';
import { recordEvent } from '@openslack/collaboration';
import { diagnoseAgentRuntime } from '@openslack/agent-runtime';
import { resolveWorkspaceContext, validateWorkspace } from '@openslack/workspace';
import { getClient } from '@openslack/github';

export function readStrictOption(source: unknown): boolean {
  if (!source || typeof source !== 'object') return false;
  const maybe = source as { strict?: unknown; opts?: () => { strict?: unknown }; parent?: unknown };
  if (typeof maybe.strict === 'boolean') return maybe.strict;
  if (typeof maybe.opts === 'function' && maybe.opts().strict === true) return true;
  if (maybe.parent) return readStrictOption(maybe.parent);
  return false;
}

export interface SetupCommandDependencies {
  resolveContext?: typeof resolveWorkspaceContext;
  validate?: typeof validateWorkspace;
  runGolden?: typeof runGoldenEval;
  getGitHubClient?: typeof getClient;
  llmProviderRegistry?: LLMPlannerProviderRegistryPort;
}

function readStrictFromCommander(args: unknown[], command: Command): boolean {
  return readStrictOption(command) || args.some((arg) => readStrictOption(arg));
}

function renderOnboardingState(store: OnboardingStore, state: OnboardingState): void {
  console.log(`Onboarding session: ${state.sessionId}`);
  for (const step of state.steps) console.log(`[${step.status.toUpperCase()}] ${step.id}`);
  const next = store.nextActionable(state);
  if (!next) {
    console.log('Onboarding ledger complete.');
    return;
  }
  console.log(`Next: ${next.id} (${next.status})`);
  if (next.status === 'needs_reconcile') {
    console.log('Verify the interrupted operation before choosing reconcile-complete or reconcile-retry.');
    return;
  }
  const guide = getOnboardingStepGuide(next.id);
  console.log(`${guide.title}: ${guide.objective}`);
  console.log(`Begin with: openslack setup onboarding begin ${next.id}`);
}

export function setupCommands(dependencies: SetupCommandDependencies = {}): Command {
  const resolveContext = dependencies.resolveContext ?? resolveWorkspaceContext;
  const validate = dependencies.validate ?? validateWorkspace;
  const runGolden = dependencies.runGolden ?? runGoldenEval;
  const getGitHubClient = dependencies.getGitHubClient ?? getClient;
  const cmd = new Command('setup').description('One-step OpenSlack setup wizard');

  const onboarding = cmd
    .command('onboarding')
    .description('Start or resume the durable standalone-product onboarding ledger')
    .option('--start', 'Create a new onboarding session')
    .action((options: { start?: boolean }) => {
      try {
        const context = resolveContext();
        const store = new OnboardingStore(context.localStateRoot);
        const state = options.start ? store.create() : store.load();
        renderOnboardingState(store, state);
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'Onboarding state failed.');
        process.exitCode = 1;
      }
    });

  onboarding
    .command('begin [step]')
    .description('Persist intent for the next onboarding step before running its commands')
    .action((stepId?: string) => {
      try {
        const context = resolveContext();
        const store = new OnboardingStore(context.localStateRoot);
        const state = store.load();
        const selected = stepId
          ? state.steps.find((step) => step.id === stepId)
          : store.nextActionable(state);
        if (stepId && !selected) throw new Error(`Unknown onboarding step: ${stepId}`);
        if (!selected) {
          console.log('Onboarding ledger complete.');
          return;
        }
        const next = store.begin(state, selected.id);
        const guide = getOnboardingStepGuide(selected.id);
        console.log(`Intent recorded: ${guide.title}`);
        console.log(guide.objective);
        for (const command of guide.commands) console.log(`  ${command}`);
        console.log(`Verify: ${guide.verification}`);
        console.log(
          `After verification: openslack setup onboarding reconcile-complete ${selected.id} --summary <redacted-summary> --evidence-ref <safe-reference>`,
        );
        console.log(
          `If verification proves no mutation occurred: openslack setup onboarding reconcile-retry ${selected.id}`,
        );
        const running = next.steps.find((step) => step.id === selected.id);
        console.log(`Ledger status: ${running?.status ?? 'unknown'} (attempt ${running?.attempt ?? 0})`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'Onboarding step failed.');
        process.exitCode = 1;
      }
    });

  cmd
    .command('state')
    .description('Diagnose local state schema compatibility without changing files')
    .action(() => {
      const context = resolveContext();
      const report = diagnoseLocalStateCompatibility(context.localStateRoot);
      console.log('Local state compatibility');
      if (report.checks.length === 0) console.log('[PASS] No versioned local state files yet.');
      for (const check of report.checks) {
        const label = check.status === 'incompatible' ? 'FAIL' : check.status === 'legacy' ? 'WARN' : 'PASS';
        console.log(`[${label}] ${check.file}: ${check.detail}`);
      }
      if (!report.compatible) process.exitCode = 1;
    });

  cmd
    .command('migrate-state')
    .description('Preview or apply backup-first P0 local state schema migrations')
    .option('--apply', 'Create a backup and apply each migration')
    .action((options: { apply?: boolean }) => {
      try {
        const context = resolveContext();
        const actions = migrateLocalStateSchemas(context.localStateRoot, {
          apply: options.apply,
        });
        if (actions.length === 0) {
          console.log('No local state migrations are required.');
          return;
        }
        for (const action of actions) {
          console.log(
            `[${action.applied ? 'APPLIED' : 'PREVIEW'}] ${action.file}: ${action.from} -> ${action.to}`,
          );
          if (action.backupPath) console.log(`Backup: ${action.backupPath}`);
        }
        if (!options.apply) console.log('No files changed. Re-run with --apply after review.');
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'Local state migration failed.');
        process.exitCode = 1;
      }
    });

  onboarding
    .command('reconcile-complete <step>')
    .description('Record a verified completed mutation without rerunning it')
    .requiredOption('--summary <summary>', 'Safely redacted completion summary')
    .requiredOption('--evidence-ref <reference...>', 'One or more safe evidence references')
    .action((stepId: string, options: { summary: string; evidenceRef: string[] }) => {
      try {
        const context = resolveContext();
        const store = new OnboardingStore(context.localStateRoot);
        const state = store.load();
        const next = store.reconcile(state, stepId as OnboardingStepId, 'completed', {
          summary: options.summary,
          evidenceRefs: options.evidenceRef,
        });
        renderOnboardingState(store, next);
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'Onboarding reconciliation failed.');
        process.exitCode = 1;
      }
    });

  onboarding
    .command('reconcile-retry <step>')
    .description('Retry only after verification proves the interrupted mutation did not occur')
    .action((stepId: string) => {
      try {
        const context = resolveContext();
        const store = new OnboardingStore(context.localStateRoot);
        const state = store.load();
        const next = store.reconcile(state, stepId as OnboardingStepId, 'retry');
        console.log(`Verified absent; ${stepId} is pending and may be started again.`);
        renderOnboardingState(store, next);
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'Onboarding reconciliation failed.');
        process.exitCode = 1;
      }
    });

  function confirmPrompt(message: string): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question(`${message} `, (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === 'y');
      });
    });
  }

  async function runFullChecklist(strict = false): Promise<void> {
    const context = resolveContext();
    const root = context.workspaceRoot;
    const results: Array<{ step: string; passed: boolean; detail: string; warn?: boolean }> = [];

    console.log('OpenSlack Setup\n');
    const workspace = validate(root);
    results.push({
      step: 'Workspace validate',
      passed: workspace.valid,
      detail: workspace.valid ? 'PASS' : `${workspace.errors.length} validation error(s)`,
    });
    if (context.sourceCheckout) {
      const golden = runGolden();
      const passed = golden.filter((result) => result.passed).length;
      results.push({
        step: 'Golden evals',
        passed: passed === golden.length,
        detail: `${passed}/${golden.length} passing`,
      });
    } else {
      results.push({
        step: 'Source maintenance',
        passed: true,
        detail: 'Golden and Genesis checks are not required in a normal workspace.',
      });
    }

    // GitHub doctor: WARN on failure (not FAIL unless --strict)
    try {
      const client = await getGitHubClient();
      results.push({
        step: 'GitHub doctor',
        passed: !client.isDryRun,
        detail: client.isDryRun ? 'Dry-run (no credentials)' : client.authMode,
        warn: client.isDryRun,
      });
    } catch {
      results.push({
        step: 'GitHub doctor',
        passed: false,
        detail: 'GitHub authentication diagnostic failed safely.',
        warn: true,
      });
    }

    if (context.sourceCheckout) {
      try {
        const genesis = detectGenesisShell(root);
        if (!genesis.command) throw new Error(genesis.detail);
        execSync(genesis.command, { cwd: root, stdio: 'pipe', timeout: 30000 });
        results.push({ step: 'Genesis validate', passed: true, detail: '5/5 checks passed' });
      } catch (err) {
        results.push({
          step: 'Genesis validate',
          passed: false,
          detail: `Genesis validation failed: ${(err as Error).message}`.slice(0, 200),
        });
      }
    }

    const runtimeReport = diagnoseAgentRuntime({ rootDir: root, env: process.env });
    results.push({
      step: 'Agent Runtime',
      passed: runtimeReport.readiness === 'ready',
      detail:
        runtimeReport.readiness === 'ready'
          ? 'Execution provider ready'
          : `${runtimeReport.readiness}: ${runtimeReport.remediations[0] ?? 'Run openslack agent-runtime doctor --provider aby'}`,
      // Guided setup remains usable without an external provider; --strict
      // promotes this explicit readiness warning to a non-zero exit.
      warn: runtimeReport.readiness !== 'ready',
    });

    // LLM routing status
    {
      const llmConfig = describeLLMRoutingConfig(
        process.env as Record<string, string | undefined>,
        dependencies.llmProviderRegistry,
      );
      const detail =
        llmConfig.mode === 'keyword-only'
          ? 'Keyword router active. Configure OPENSLACK_LLM_PROVIDER to enable LLM-first routing.'
          : llmConfig.mode === 'llm-first'
            ? `LLM-first routing (provider: ${llmConfig.provider}, model: ${llmConfig.model}). Keyword router serves as fallback.`
            : `LLM provider set but configuration incomplete: ${llmConfig.issues?.join(', ') ?? 'unknown'}`;
      results.push({
        step: `Intent Routing: ${llmConfig.mode}`,
        passed: llmConfig.mode !== 'misconfigured',
        detail,
        warn: llmConfig.mode === 'misconfigured',
      });
    }

    const passed = results.filter((r) => r.passed).length;
    let hasWarn = false;
    let hasFail = false;
    for (const r of results) {
      if (r.passed) {
        console.log(`[PASS] ${r.step}`);
      } else if (r.warn) {
        console.log(`[WARN] ${r.step}`);
        console.log(`      ${r.detail}`);
        hasWarn = true;
      } else {
        console.log(`[FAIL] ${r.step}`);
        console.log(`      ${r.detail}`);
        hasFail = true;
      }
    }
    const warnCount = results.filter((r) => r.warn && !r.passed).length;
    console.log(
      `\n${passed}/${results.length} passed${warnCount > 0 ? ` (${warnCount} warning(s))` : ''}`,
    );
    const exitCode = hasFail || (strict && hasWarn) ? 1 : 0;
    console.log(
      hasFail
        ? 'Fix the FAIL items above, then run: openslack setup'
        : passed === results.length
          ? 'OpenSlack is fully set up.'
          : strict && hasWarn
            ? 'Warnings treated as failures (--strict).'
            : 'OpenSlack core setup complete. Review WARN items when ready.',
    );
    process.exit(exitCode);
  }

  // Default action: run full checklist
  cmd
    .option('--strict', 'Treat warnings as failures (non-zero exit)')
    .action(async (...args: unknown[]) => runFullChecklist(readStrictFromCommander(args, cmd)));

  const runCommand = cmd
    .command('run')
    .description('Run the full OpenSlack setup checklist')
    .option('--strict', 'Treat warnings as failures (non-zero exit)');
  runCommand.action(async (...args: unknown[]) =>
    runFullChecklist(readStrictFromCommander(args, runCommand)),
  );

  cmd
    .command('github')
    .description('Guided GitHub authentication setup')
    .option('--apply', 'Apply explicitly requested setup repairs')
    .option('--repair-labels', 'Ensure required OpenSlack labels exist; requires --apply to mutate')
    .action(async (options: { apply?: boolean; repairLabels?: boolean }) => {
      const report = await buildSetupReport({ dryRun: !options.apply });
      console.log(renderSetupReport(report));

      if (options.repairLabels) {
        const { repairLabels } = await import('@openslack/github');
        const results = await repairLabels({ dryRun: !options.apply });
        console.log('');
        console.log(options.apply ? 'Applying label repair:' : 'Label repair preview:');
        for (const r of results) {
          console.log(`  [${r.fixed ? 'FIXED' : r.planned ? 'PLAN' : 'SKIP'}] ${r.detail}`);
        }
        try {
          recordEvent({
            type: options.apply ? 'repair.applied' : 'repair.previewed',
            actor: { id: 'cli', kind: 'system', provider: 'cli' },
            object: { kind: 'workspace', id: 'github:labels' },
            source: { kind: 'github', ref: 'setup.github.repair_labels' },
            summary: `${options.apply ? 'Applied' : 'Previewed'} GitHub label repair from setup (${results.length} item(s))`,
            visibility: 'local',
            redacted: false,
            containsSensitiveData: false,
            risk: options.apply ? 'medium' : 'none',
          });
        } catch {
          // best-effort event recording
        }
        if (!options.apply) {
          console.log('');
          console.log(
            'No labels were changed. Run: openslack setup github --repair-labels --apply',
          );
        }
      }
    });

  const smokeCommand = cmd
    .command('smoke')
    .description('Run read-only smoke test (no side effects)')
    .option('--strict', 'Treat warnings as failures (non-zero exit)');
  smokeCommand.action(async (...args: unknown[]) => {
    const strict = readStrictFromCommander(args, smokeCommand);
    const context = resolveContext();
    const root = context.workspaceRoot;
    const results: Array<{ check: string; passed: boolean; detail: string; warn?: boolean }> = [];

    console.log('OpenSlack Smoke Test\n');
    const workspace = validate(root);
    results.push({
      check: 'Workspace validate',
      passed: workspace.valid,
      detail: workspace.valid ? 'PASS' : `${workspace.errors.length} validation error(s)`,
    });
    if (context.sourceCheckout) {
      const golden = runGolden();
      const passed = golden.filter((result) => result.passed).length;
      results.push({
        check: 'Golden evals',
        passed: passed === golden.length,
        detail: `${passed}/${golden.length}`,
      });
    } else {
      results.push({
        check: 'Source maintenance',
        passed: true,
        detail: 'Not required in a normal workspace',
      });
    }

    // GitHub doctor: WARN on failure (not FAIL unless --strict)
    try {
      const client = await getGitHubClient();
      results.push({
        check: 'GitHub doctor',
        passed: !client.isDryRun,
        detail: client.isDryRun ? 'Dry-run: no credentials' : client.authMode,
        warn: client.isDryRun,
      });
    } catch {
      results.push({ check: 'GitHub doctor', passed: false, detail: 'Unavailable', warn: true });
    }

    if (context.sourceCheckout) {
      try {
        const genesis = detectGenesisShell(root);
        if (!genesis.command) throw new Error(genesis.detail);
        execSync(genesis.command, { cwd: root, stdio: 'pipe', timeout: 30000 });
        results.push({ check: 'Genesis validate', passed: true, detail: '5/5' });
      } catch {
        results.push({ check: 'Genesis validate', passed: false, detail: 'Failed' });
      }
    }

    // LLM routing status
    {
      const llmConfig = describeLLMRoutingConfig(
        process.env as Record<string, string | undefined>,
        dependencies.llmProviderRegistry,
      );
      const detail =
        llmConfig.mode === 'keyword-only'
          ? 'Keyword router active. Configure OPENSLACK_LLM_PROVIDER to enable LLM-first routing.'
          : llmConfig.mode === 'llm-first'
            ? `LLM-first routing (provider: ${llmConfig.provider}, model: ${llmConfig.model}). Keyword router serves as fallback.`
            : `LLM provider set but configuration incomplete: ${llmConfig.issues?.join(', ') ?? 'unknown'}`;
      results.push({
        check: `Intent Routing: ${llmConfig.mode}`,
        passed: llmConfig.mode !== 'misconfigured',
        detail,
        warn: llmConfig.mode === 'misconfigured',
      });
    }

    const passed = results.filter((r) => r.passed).length;
    const total = results.length;
    let hasWarn = false;
    let hasFail = false;
    for (const r of results) {
      if (r.passed) {
        console.log(`✓ ${r.check}`);
      } else if (r.warn) {
        console.log(`⚠ ${r.check}`);
        hasWarn = true;
      } else {
        console.log(`✗ ${r.check}`);
        hasFail = true;
      }
    }
    console.log(`\n${passed}/${total} smoke tests passed`);
    process.exit(hasFail || (strict && hasWarn) ? 1 : 0);
  });

  const ALLOWED_FIX_PREFIXES = ['setup github', 'github repair'];

  function runOpenSlackCommand(command: string): void {
    // Only allow known fix commands via argv split, never raw shell strings
    const stripped = command.replace(/^openslack\s+/, '');
    const isAllowed = ALLOWED_FIX_PREFIXES.some((p) => stripped.startsWith(p));
    if (!isAllowed) {
      console.log(`  Command not in allowlist: ${command}`);
      console.log('  Run it manually if needed.');
      return;
    }
    const argv = stripped.split(/\s+/);
    const context = resolveContext();
    const cliEntry = process.argv[1];
    if (!cliEntry) {
      console.log(
        '  Current OpenSlack executable entrypoint is unavailable. Run the command manually.',
      );
      return;
    }
    try {
      execFileSync(process.execPath, [...process.execArgv, cliEntry, ...argv], {
        cwd: context.workspaceRoot,
        stdio: 'inherit',
        timeout: 60000,
      });
    } catch (e) {
      console.log(`  Command failed: ${(e as Error).message}`);
    }
  }

  function renderNextStepsGuide(): void {
    const steps = getNextSteps();
    console.log('');
    console.log('What would you like to do next?');
    console.log('-'.repeat(30));
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      console.log(`  ${i + 1}. ${step.label}`);
      console.log(`     ${step.description}`);
      console.log(`     ${step.command}`);
    }
    console.log('');
  }

  function runValidationSteps(): PlainFinding[] {
    const results: PlainFinding[] = [];
    const context = resolveContext();
    const root = context.workspaceRoot;

    const workspace = validate(root);
    results.push({
      status: workspace.valid ? 'PASS' : 'FAIL',
      title: 'Workspace validate',
      detail: workspace.valid
        ? 'Schema and structure valid'
        : `${workspace.errors.length} validation error(s)`,
    });

    if (context.sourceCheckout) {
      const golden = runGolden();
      const passed = golden.filter((result) => result.passed).length;
      results.push({
        status: passed === golden.length ? 'PASS' : 'FAIL',
        title: 'Golden evals',
        detail: `${passed}/${golden.length} passing`,
      });
    } else {
      results.push({
        status: 'PASS',
        title: 'Source maintenance',
        detail: 'Not required in a normal workspace',
      });
    }

    return results;
  }

  // Interactive onboarding wizard
  cmd
    .command('interactive')
    .description('Guided interactive setup with step-by-step prompts')
    .option('--format <format>', 'Output format: standard, plain, or tui', 'standard')
    .action(async (options: { format: string }) => {
      const report = await buildSetupReport({ dryRun: true });
      if (options.format === 'tui') {
        try {
          const { renderSetupTui } = await import('@openslack/tui');
          await renderSetupTui(report);
        } catch (error) {
          console.error('TUI unavailable. Falling back to standard output.');
          console.log(renderSetupReport(report));
        }
        return;
      }
      const isPlain = options.format === 'plain';

      // Classify readiness
      const fixable = report.findings.filter((f) => f.status === 'fixable_by_command');
      const unfixable = report.findings.filter(
        (f) => f.status === 'requires_github_admin' || f.status === 'requires_human_approval',
      );
      const ok = report.findings.filter((f) => f.status === 'ok');
      const allOk = fixable.length === 0 && unfixable.length === 0;

      const readiness = allOk ? 'ready' : fixable.length > 0 ? 'almost ready' : 'needs setup help';

      if (isPlain) {
        const plainFindings: PlainFinding[] = report.findings.map((f) => ({
          status: f.status as PlainFinding['status'],
          title: f.title,
          detail: f.detail,
          nextAction: f.nextAction,
          command: f.command,
        }));
        console.log(renderFindingsPlain(plainFindings));
        console.log('');
        console.log(`Readiness: ${readiness}`);
        const recs = recommendNextActions({
          setupFindings: report.findings.map((f) => ({
            status: f.status,
            title: f.title,
            nextAction: f.nextAction,
            command: f.command,
          })),
        });
        if (recs.length > 0) {
          console.log('');
          for (const r of recs) {
            console.log(`${r.title}: ${r.action}`);
            if (r.command) console.log(`  Run: ${r.command}`);
          }
        }

        // Run validation and render in plain format
        const validationResults = runValidationSteps();
        if (validationResults.length > 0) {
          console.log('');
          console.log(renderFindingsPlain(validationResults));
        }
        return;
      }

      // Standard interactive flow
      console.log('OpenSlack Interactive Setup');
      console.log('='.repeat(30));
      console.log(`Readiness: ${readiness}`);
      console.log(`${ok.length}/${report.findings.length} checks passed`);
      console.log('');

      // Walk fixable items with prompts
      for (const f of fixable) {
        console.log(`[FIXABLE] ${f.title}`);
        console.log(`  ${f.detail}`);
        if (f.nextAction) console.log(`  How to fix: ${f.nextAction}`);
        if (f.command) console.log(`  Command: ${f.command}`);
        console.log('');

        if (f.command) {
          const confirmed = await confirmPrompt('Show the fix command? [y/N]');
          if (confirmed) {
            console.log(`  → ${f.command}`);
            console.log('');
            const shouldRun = await confirmPrompt('Run this command now? [y/N]');
            if (shouldRun) {
              runOpenSlackCommand(f.command);
              console.log('');
            }
          }
        }
      }

      // Explain unfixable items
      for (const f of unfixable) {
        console.log(`[NEEDS ACTION] ${f.title}`);
        console.log(`  ${f.detail}`);
        if (f.nextAction) console.log(`  Next: ${f.nextAction}`);
        console.log('');
      }

      // Run workspace validate + golden evals
      console.log('Validation:');
      const validationResults = runValidationSteps();
      for (const v of validationResults) {
        const icon = v.status === 'PASS' ? '✓' : v.status === 'WARN' ? '⚠' : '✗';
        console.log(`  ${icon} ${v.title}`);
        if (v.status !== 'PASS' && v.detail) console.log(`    ${v.detail}`);
      }
      console.log('');

      // Print next steps via recommendNextActions
      const recs = recommendNextActions({
        setupFindings: report.findings.map((f) => ({
          status: f.status,
          title: f.title,
          nextAction: f.nextAction,
          command: f.command,
        })),
      });

      if (recs.length > 0) {
        console.log('Recommended Next Steps:');
        for (let i = 0; i < recs.length; i++) {
          const r = recs[i];
          console.log(`  ${i + 1}. ${r.title}`);
          if (r.action) console.log(`     ${r.action}`);
          if (r.command) console.log(`     Run: ${r.command}`);
        }
        console.log('');
      }

      renderNextStepsGuide();

      try {
        recordEvent({
          type: 'operator.execution.completed',
          actor: { id: 'cli', kind: 'system', provider: 'cli' },
          object: { kind: 'workspace', id: 'setup' },
          source: { kind: 'operator', ref: 'setup.interactive' },
          summary: `Interactive setup completed: ${readiness}, ${ok.length}/${report.findings.length} ok`,
          visibility: 'local',
          redacted: false,
          containsSensitiveData: false,
        });
      } catch {
        // best-effort event recording
      }
    });

  return cmd;
}

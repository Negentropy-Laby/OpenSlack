import { Command } from 'commander';
import { execSync, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import {
  buildSetupReport, detectGenesisShell, renderSetupReport,
  recommendNextActions, renderFindingsPlain,
} from '@openslack/runtime';
import type { PlainFinding } from '@openslack/runtime';
import { recordEvent } from '@openslack/collaboration';

export function readStrictOption(source: unknown): boolean {
  if (!source || typeof source !== 'object') return false;
  const maybe = source as { strict?: unknown; opts?: () => { strict?: unknown }; parent?: unknown };
  if (typeof maybe.strict === 'boolean') return maybe.strict;
  if (typeof maybe.opts === 'function' && maybe.opts().strict === true) return true;
  if (maybe.parent) return readStrictOption(maybe.parent);
  return false;
}

function readStrictFromCommander(args: unknown[], command: Command): boolean {
  return readStrictOption(command) || args.some((arg) => readStrictOption(arg));
}

export function setupCommands(): Command {
  const cmd = new Command('setup').description('One-step OpenSlack setup wizard');

  function confirmPrompt(message: string): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question(`${message} `, (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === 'y');
      });
    });
  }

  function runFullChecklist(strict = false): void {
    const root = process.cwd();
    const node = process.execPath;
    const cli = join(root, 'apps', 'cli', 'src', 'index.ts');
    const results: Array<{ step: string; passed: boolean; detail: string; warn?: boolean }> = [];

    function runStep(label: string, args: string[]): void {
      try {
        const out = execSync(`"${node}" --import tsx "${cli}" ${args.join(' ')}`, {
          cwd: root,
          stdio: 'pipe',
          timeout: 60000,
        });
        results.push({
          step: label,
          passed: true,
          detail: out.toString().trim().split('\n')[0] || 'PASS',
        });
      } catch (e) {
        const stderr = (e as { stderr?: Buffer }).stderr?.toString() || (e as Error).message;
        results.push({ step: label, passed: false, detail: stderr.slice(0, 200) });
      }
    }

    console.log('OpenSlack Setup\n');
    runStep('Workspace validate', ['workspace', 'validate']);
    runStep('Golden evals', ['self', 'eval', '--suite', 'golden']);

    // GitHub doctor: WARN on failure (not FAIL unless --strict)
    try {
      const out = execSync(`"${node}" --import tsx "${cli}" github doctor`, {
        cwd: root,
        stdio: 'pipe',
        timeout: 60000,
      });
      results.push({
        step: 'GitHub doctor',
        passed: true,
        detail: out.toString().trim().split('\n')[0] || 'PASS',
      });
    } catch (e) {
      const stderr = (e as { stderr?: Buffer }).stderr?.toString() || (e as Error).message;
      results.push({
        step: 'GitHub doctor',
        passed: false,
        detail: stderr.slice(0, 200),
        warn: true,
      });
    }

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
    .action((...args: unknown[]) => runFullChecklist(readStrictFromCommander(args, cmd)));

  const runCommand = cmd
    .command('run')
    .description('Run the full OpenSlack setup checklist')
    .option('--strict', 'Treat warnings as failures (non-zero exit)');
  runCommand.action((...args: unknown[]) =>
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
  smokeCommand.action((...args: unknown[]) => {
    const strict = readStrictFromCommander(args, smokeCommand);
    const root = process.cwd();
    const node = process.execPath;
    const cli = join(root, 'apps', 'cli', 'src', 'index.ts');
    const results: Array<{ check: string; passed: boolean; detail: string; warn?: boolean }> = [];

    function runCheck(label: string, args: string[]): void {
      try {
        execSync(`"${node}" --import tsx "${cli}" ${args.join(' ')}`, {
          cwd: root,
          stdio: 'pipe',
          timeout: 60000,
        });
        results.push({ check: label, passed: true, detail: 'PASS' });
      } catch (e) {
        const stderr = (e as { stderr?: Buffer }).stderr?.toString() || (e as Error).message;
        results.push({ check: label, passed: false, detail: stderr.slice(0, 150) });
      }
    }

    console.log('OpenSlack Smoke Test\n');

    runCheck('Workspace validate', ['workspace', 'validate']);
    runCheck('Golden evals', ['self', 'eval', '--suite', 'golden', '--clean']);

    // GitHub doctor: WARN on failure (not FAIL unless --strict)
    try {
      execSync(`"${node}" --import tsx "${cli}" github doctor`, {
        cwd: root,
        stdio: 'pipe',
        timeout: 60000,
      });
      results.push({ check: 'GitHub doctor', passed: true, detail: 'PASS' });
    } catch (e) {
      const stderr = (e as { stderr?: Buffer }).stderr?.toString() || (e as Error).message;
      results.push({
        check: 'GitHub doctor',
        passed: false,
        detail: stderr.slice(0, 150),
        warn: true,
      });
    }

    try {
      const genesis = detectGenesisShell(root);
      if (!genesis.command) throw new Error(genesis.detail);
      execSync(genesis.command, { cwd: root, stdio: 'pipe', timeout: 30000 });
      results.push({ check: 'Genesis validate', passed: true, detail: '5/5' });
    } catch {
      results.push({ check: 'Genesis validate', passed: false, detail: 'Failed' });
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
    const root = process.cwd();
    const node = process.execPath;
    const cli = join(root, 'apps', 'cli', 'src', 'index.ts');
    try {
      execFileSync(node, ['--import', 'tsx', cli, ...argv], {
        cwd: root,
        stdio: 'inherit',
        timeout: 60000,
      });
    } catch (e) {
      console.log(`  Command failed: ${(e as Error).message}`);
    }
  }

  function runValidationSteps(): PlainFinding[] {
    const results: PlainFinding[] = [];
    const root = process.cwd();
    const node = process.execPath;
    const cli = join(root, 'apps', 'cli', 'src', 'index.ts');

    // Workspace validate
    try {
      execFileSync(node, ['--import', 'tsx', cli, 'workspace', 'validate'], {
        cwd: root,
        stdio: 'pipe',
        timeout: 60000,
      });
      results.push({ status: 'PASS', title: 'Workspace validate', detail: 'Schema and structure valid' });
    } catch (e) {
      const stderr = (e as { stderr?: Buffer }).stderr?.toString() || (e as Error).message;
      results.push({ status: 'FAIL', title: 'Workspace validate', detail: stderr.slice(0, 200) });
    }

    // Golden evals
    try {
      execFileSync(node, ['--import', 'tsx', cli, 'self', 'eval', '--suite', 'golden', '--clean'], {
        cwd: root,
        stdio: 'pipe',
        timeout: 120000,
      });
      results.push({ status: 'PASS', title: 'Golden evals', detail: 'All golden evals passing' });
    } catch (e) {
      const stderr = (e as { stderr?: Buffer }).stderr?.toString() || (e as Error).message;
      results.push({ status: 'FAIL', title: 'Golden evals', detail: stderr.slice(0, 200) });
    }

    return results;
  }

  // Interactive onboarding wizard
  cmd
    .command('interactive')
    .description('Guided interactive setup with step-by-step prompts')
    .option('--format <format>', 'Output format: standard or plain', 'standard')
    .action(async (options: { format: string }) => {
      const report = await buildSetupReport({ dryRun: true });
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

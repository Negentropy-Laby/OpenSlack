import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { buildSetupReport, detectGenesisShell, renderSetupReport } from '@openslack/runtime';
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

  return cmd;
}

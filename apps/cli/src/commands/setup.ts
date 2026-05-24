import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { buildSetupReport, detectGenesisShell, renderSetupReport } from '@openslack/runtime';
import { recordEvent } from '@openslack/collaboration';

export function setupCommands(): Command {
  const cmd = new Command('setup').description('One-step OpenSlack setup wizard');

  function runFullChecklist(): void {
    const root = process.cwd();
    const node = process.execPath;
    const cli = join(root, 'apps', 'cli', 'src', 'index.ts');
    const results: Array<{ step: string; passed: boolean; detail: string }> = [];

    function runStep(label: string, args: string[]): void {
      try {
        const out = execSync(`"${node}" --import tsx "${cli}" ${args.join(' ')}`, { cwd: root, stdio: 'pipe', timeout: 60000 });
        results.push({ step: label, passed: true, detail: out.toString().trim().split('\n')[0] || 'PASS' });
      } catch (e) {
        const stderr = (e as { stderr?: Buffer }).stderr?.toString() || (e as Error).message;
        results.push({ step: label, passed: false, detail: stderr.slice(0, 200) });
      }
    }

    console.log('OpenSlack Setup\n');
    runStep('Workspace validate', ['workspace', 'validate']);
    runStep('Golden evals', ['self', 'eval', '--suite', 'golden']);
    runStep('GitHub doctor', ['github', 'doctor']);
    try {
      const genesis = detectGenesisShell(root);
      if (!genesis.command) throw new Error(genesis.detail);
      execSync(genesis.command, { cwd: root, stdio: 'pipe', timeout: 30000 });
      results.push({ step: 'Genesis validate', passed: true, detail: '5/5 checks passed' });
    } catch (err) {
      results.push({ step: 'Genesis validate', passed: false, detail: `Genesis validation failed: ${(err as Error).message}`.slice(0, 200) });
    }

    const passed = results.filter((r) => r.passed).length;
    let exitCode = 0;
    for (const r of results) {
      console.log(`${r.passed ? '[PASS]' : '[FAIL]'} ${r.step}`);
      if (!r.passed) { console.log(`      ${r.detail}`); exitCode = 1; }
    }
    console.log(`\n${passed}/${results.length} passed`);
    console.log(passed === results.length ? 'OpenSlack is fully set up.' : 'Fix the FAIL items above, then run: openslack setup');
    process.exit(exitCode);
  }

  // Default action: run full checklist
  cmd.action(runFullChecklist);

  cmd
    .command('run')
    .description('Run the full OpenSlack setup checklist')
    .action(runFullChecklist);

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
          console.log('No labels were changed. Run: openslack setup github --repair-labels --apply');
        }
      }
    });

  cmd
    .command('smoke')
    .description('Run read-only smoke test (no side effects)')
    .action(() => {
      const root = process.cwd();
      const node = process.execPath;
      const cli = join(root, 'apps', 'cli', 'src', 'index.ts');
      const results: Array<{ check: string; passed: boolean; detail: string }> = [];

      function runCheck(label: string, args: string[]): void {
        try {
          execSync(`"${node}" --import tsx "${cli}" ${args.join(' ')}`, { cwd: root, stdio: 'pipe', timeout: 60000 });
          results.push({ check: label, passed: true, detail: 'PASS' });
        } catch (e) {
          const stderr = (e as { stderr?: Buffer }).stderr?.toString() || (e as Error).message;
          results.push({ check: label, passed: false, detail: stderr.slice(0, 150) });
        }
      }

      console.log('OpenSlack Smoke Test\n');

      runCheck('Workspace validate', ['workspace', 'validate']);
      runCheck('Golden evals', ['self', 'eval', '--suite', 'golden', '--clean']);
      runCheck('GitHub doctor', ['github', 'doctor']);

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
      for (const r of results) {
        console.log(`${r.passed ? '✓' : '✗'} ${r.check}`);
      }
      console.log(`\n${passed}/${total} smoke tests passed`);
      process.exit(passed === total ? 0 : 1);
    });

  return cmd;
}

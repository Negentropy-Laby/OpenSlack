import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

export function setupCommands(): Command {
  const cmd = new Command('setup').description('One-step OpenSlack setup wizard');

  cmd
    .command('run')
    .description('Run the full OpenSlack setup checklist')
    .action(() => {
      const root = process.cwd();
      const node = process.execPath;
      const cli = join(root, 'apps', 'cli', 'src', 'index.ts');
      const results: Array<{ step: string; passed: boolean; detail: string }> = [];

      function runStep(label: string, args: string[]): void {
        try {
          const out = execSync(`"${node}" --import tsx "${cli}" ${args.join(' ')}`, {
            cwd: root,
            stdio: 'pipe',
            timeout: 60000,
          });
          results.push({ step: label, passed: true, detail: out.toString().trim().split('\n')[0] || 'PASS' });
        } catch (e) {
          const stderr = (e as { stderr?: Buffer }).stderr?.toString() || (e as Error).message;
          results.push({ step: label, passed: false, detail: stderr.slice(0, 200) });
        }
      }

      console.log('OpenSlack Setup\n');

      // Step 1: Validate workspace
      runStep('Workspace validate', ['workspace', 'validate']);

      // Step 2: Golden evals
      runStep('Golden evals', ['self', 'eval', '--suite', 'golden']);

      // Step 3: Repair labels (dry-run safe, real if token present)
      runStep('GitHub labels', ['github', 'repair-labels']);

      // Step 4: GitHub doctor
      runStep('GitHub doctor', ['github', 'doctor']);

      // Step 5: Genesis validate
      try {
        execSync('bash scripts/genesis-validate.sh', { cwd: root, stdio: 'pipe', timeout: 30000 });
        results.push({ step: 'Genesis validate', passed: true, detail: '5/5 checks passed' });
      } catch {
        results.push({ step: 'Genesis validate', passed: false, detail: 'Genesis validation failed' });
      }

      // Summary
      const passed = results.filter((r) => r.passed).length;
      const total = results.length;
      let exitCode = 0;

      for (const r of results) {
        const icon = r.passed ? 'PASS' : 'FAIL';
        console.log(`[${icon}] ${r.step}`);
        if (!r.passed) {
          console.log(`      ${r.detail}`);
          exitCode = 1;
        }
      }

      console.log(`\n${passed}/${total} passed`);
      if (passed === total) {
        console.log('OpenSlack is fully set up.');
      } else {
        console.log('Fix the FAIL items above, then run: openslack setup');
      }
      process.exit(exitCode);
    });

  return cmd;
}

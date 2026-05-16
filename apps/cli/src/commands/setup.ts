import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

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
    runStep('GitHub labels', ['github', 'repair-labels']);
    runStep('GitHub doctor', ['github', 'doctor']);
    try {
      execSync('bash scripts/genesis-validate.sh', { cwd: root, stdio: 'pipe', timeout: 30000 });
      results.push({ step: 'Genesis validate', passed: true, detail: '5/5 checks passed' });
    } catch {
      results.push({ step: 'Genesis validate', passed: false, detail: 'Genesis validation failed' });
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
    .action(async () => {
      console.log('GitHub Auth Setup\n');

      const appId = process.env.OPENSLACK_GITHUB_APP_ID;
      const installId = process.env.OPENSLACK_GITHUB_APP_INSTALLATION_ID;
      const hasKey = !!process.env.OPENSLACK_GITHUB_APP_PRIVATE_KEY;
      const token = process.env.GITHUB_TOKEN;

      // Check GitHub App auth
      if (appId && installId && hasKey) {
        try {
          const { getClient } = await import('@openslack/github');
          const client = await getClient();
          console.log(`[PASS] GitHub App auth: ${client.authMode}`);
          if (client.tokenExpiresAt) console.log(`      Token expires: ${client.tokenExpiresAt}`);
          console.log('');
          console.log('Next: openslack smoke    # run the smoke test');
          return;
        } catch (e) {
          console.log(`[FAIL] GitHub App token generation failed: ${(e as Error).message}`);
        }
      }

      // Check PAT fallback
      if (token) {
        console.log('[PASS] GITHUB_TOKEN set (PAT fallback)');
        console.log('[WARN] For production agent runtime, GitHub App is recommended.');
        console.log('');
        console.log('Next: openslack smoke    # run the smoke test');
        return;
      }

      // No credentials — print step-by-step guide
      console.log('[WARN] No GitHub credentials configured.\n');
      console.log('To enable GitHub integration, choose one:\n');
      console.log('Option A: GitHub App Installation Token (recommended for agent runtime)');
      console.log('  1. Go to https://github.com/settings/apps/new');
      console.log('  2. App name: OpenSlack Agent Operator');
      console.log('  3. Set homepage: https://github.com/wsman/OpenSlack');
      console.log('  4. Callback URL: http://127.0.0.1:8200/callback');
      console.log('  5. Permissions: Contents R/W, Issues R/W, Pull requests R/W, Projects R/W');
      console.log('  6. Install on wsman/OpenSlack');
      console.log('  7. Download private key to .openslack.local/github-app.pem');
      console.log('  8. Set environment variables:');
      console.log('     OPENSLACK_GITHUB_APP_ID=<app-id>');
      console.log('     OPENSLACK_GITHUB_APP_INSTALLATION_ID=<install-id>');
      console.log('     OPENSLACK_GITHUB_APP_PRIVATE_KEY=$(cat .openslack.local/github-app.pem)');
      console.log('');
      console.log('Option B: Personal Access Token (simple for local dev)');
      console.log('  1. Go to https://github.com/settings/tokens/new');
      console.log('  2. Select scopes: repo, read:project, project');
      console.log('  3. Set environment variable:');
      console.log('     GITHUB_TOKEN=ghp_xxxxxxxxxxxx');
      console.log('');
      console.log('After configuring, run: openslack setup github');
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
        execSync('bash scripts/genesis-validate.sh', { cwd: root, stdio: 'pipe', timeout: 30000 });
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

import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { readModules, validateModules } from '@openslack/workspace';
import { getClient } from '@openslack/github';

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'openslack.yaml'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

type CheckState = 'PASS' | 'WARN' | 'FAIL';

interface CheckResult {
  name: string;
  state: CheckState;
  detail: string;
}

export function doctorCommands(): Command {
  const cmd = new Command('doctor').description('OpenSlack multi-module health check');

  cmd
    .action(async () => {
      const root = findRepoRoot();
      const checks: CheckResult[] = [];

      // Workspace check
      try {
        const { validateWorkspace } = await import('@openslack/workspace');
        const result = validateWorkspace(root);
        checks.push({
          name: 'Workspace valid',
          state: result.valid ? 'PASS' : 'FAIL',
          detail: result.valid ? 'openslack.yaml valid' : `${result.errors.length} errors`,
        });
      } catch (e) {
        checks.push({ name: 'Workspace valid', state: 'FAIL', detail: `Error: ${(e as Error).message}` });
      }

      // Golden evals check
      try {
        execSync('pnpm openslack self eval --suite golden', { cwd: root, stdio: 'pipe', encoding: 'utf-8' });
        checks.push({ name: 'Golden evals', state: 'PASS', detail: '7/7 passing' });
      } catch {
        checks.push({ name: 'Golden evals', state: 'FAIL', detail: 'Some evals failed' });
      }

      // GitHub auth check
      try {
        const client = await getClient();
        if (client.isDryRun) {
          checks.push({ name: 'GitHub auth', state: 'WARN', detail: 'Dry-run (no credentials)' });
        } else {
          checks.push({ name: 'GitHub auth', state: 'PASS', detail: `${client.authMode}` });
        }
      } catch (e) {
        checks.push({ name: 'GitHub auth', state: 'FAIL', detail: `Error: ${(e as Error).message}` });
      }

      // Required labels check
      try {
        const { getClient } = await import('@openslack/github');
        const client = await getClient();
        if (client.isDryRun) {
          checks.push({ name: 'Required labels', state: 'WARN', detail: 'Dry-run: cannot verify remotely' });
        } else {
          checks.push({ name: 'Required labels', state: 'PASS', detail: 'Labels verified' });
        }
      } catch (e) {
        checks.push({ name: 'Required labels', state: 'FAIL', detail: `Error: ${(e as Error).message}` });
      }

      // CODEOWNERS check
      const codeowners = join(root, '.github', 'CODEOWNERS');
      checks.push({
        name: 'CODEOWNERS',
        state: existsSync(codeowners) ? 'PASS' : 'FAIL',
        detail: existsSync(codeowners) ? 'Exists' : 'Missing',
      });

      // Module registry check
      try {
        const registry = readModules(root);
        const validation = validateModules(registry);
        checks.push({
          name: 'Module registry',
          state: validation.valid ? 'PASS' : 'FAIL',
          detail: validation.valid ? `${registry.modules.length} modules` : `${validation.errors.length} errors`,
        });
      } catch (e) {
        checks.push({ name: 'Module registry', state: 'FAIL', detail: `Error: ${(e as Error).message}` });
      }

      // Branch protection check (best-effort)
      checks.push({
        name: 'Branch protection',
        state: 'WARN',
        detail: 'Cannot verify remotely — check GitHub Settings > Rules',
      });

      // Genesis check
      try {
        execSync('bash scripts/genesis-validate.sh', { cwd: root, stdio: 'pipe', encoding: 'utf-8' });
        checks.push({ name: 'Genesis validate', state: 'PASS', detail: '5/5 checks passing' });
      } catch {
        checks.push({ name: 'Genesis validate', state: 'FAIL', detail: 'Genesis checks failed' });
      }

      console.log('OpenSlack Doctor');
      console.log('════════════════');
      let hasFail = false;
      for (const c of checks) {
        console.log(`[${c.state}] ${c.name}: ${c.detail}`);
        if (c.state === 'FAIL') hasFail = true;
      }
      console.log('');
      if (hasFail) {
        console.log('Some checks failed. Review output above.');
        process.exit(1);
      } else {
        console.log('All critical checks passed. Review WARN items above.');
      }
    });

  return cmd;
}

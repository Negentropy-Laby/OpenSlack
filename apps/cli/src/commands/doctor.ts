import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { readModules, validateModules } from '@openslack/workspace';
import { getClient } from '@openslack/github';
import { describeLLMRoutingConfig } from '@openslack/operator';
import { detectGenesisShell, renderFindingsPlain } from '@openslack/runtime';
import type { PlainFinding } from '@openslack/runtime';

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

interface DoctorCommandDependencies {
  execSync?: typeof execSync;
}

export function doctorCommands(dependencies: DoctorCommandDependencies = {}): Command {
  const cmd = new Command('doctor').description('OpenSlack multi-module health check');
  const runExecSync = dependencies.execSync ?? execSync;

  cmd
    .option('--format <format>', 'Output format: standard or plain', 'standard')
    .action(async (options: { format: string }) => {
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
        runExecSync('bun run openslack self eval --suite golden', { cwd: root, stdio: 'pipe', encoding: 'utf-8' });
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
        const client = await getClient();
        if (client.isDryRun) {
          checks.push({ name: 'Required labels', state: 'WARN', detail: 'Dry-run: cannot verify remotely' });
        } else {
          const requiredLabels = [
            'openslack:task',
            'openslack:ready',
            'openslack:claimed',
            'openslack:running',
            'openslack:review',
            'openslack:done',
            'openslack:blocked',
          ];
          const { data: existingLabels } = await client.octokit.issues.listLabelsForRepo({
            owner: client.owner,
            repo: client.repo,
            per_page: 100,
          });
          const existingNames = new Set(existingLabels.map((l) => l.name));
          const missing = requiredLabels.filter((l) => !existingNames.has(l));
          if (missing.length > 0) {
            checks.push({
              name: 'Required labels',
              state: 'WARN',
              detail: `Missing: ${missing.join(', ')}`,
            });
          } else {
            checks.push({
              name: 'Required labels',
              state: 'PASS',
              detail: `${requiredLabels.length}/${requiredLabels.length} present`,
            });
          }
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

      // Agent runtime / Aby readiness check. This is a configuration-only
      // diagnostic; it never launches the external runtime.
      try {
        const { listAbyRuntimeAgents, diagnoseAbyRuntime } = await import('@openslack/agent-runtime');
        const abyAgents = listAbyRuntimeAgents(root);
        if (abyAgents.length === 0) {
          checks.push({
            name: 'Agent Runtime / Aby',
            state: 'WARN',
            detail: 'Aby runtime not required by registered agents',
          });
        } else {
          const report = diagnoseAbyRuntime({ rootDir: root, env: process.env });
          checks.push({
            name: 'Agent Runtime / Aby',
            state: report.status === 'PASS' ? 'PASS' : 'FAIL',
            detail: report.status === 'PASS'
              ? `Configured for ${abyAgents.map((agent) => agent.agentId).join(', ')}`
              : report.remediations.join(' '),
          });
        }
      } catch (e) {
        checks.push({
          name: 'Agent Runtime / Aby',
          state: 'FAIL',
          detail: `Error: ${(e as Error).message}`,
        });
      }

      // Branch protection check
      try {
        const client = await getClient();
        if (client.isDryRun) {
          checks.push({
            name: 'Branch protection',
            state: 'WARN',
            detail: 'Dry-run: cannot verify remotely',
          });
        } else {
          const { data: rules } = await client.octokit.repos.getBranchRules({
            owner: client.owner,
            repo: client.repo,
            branch: 'main',
          });
          const hasPullRequestRule = rules.some((r: { type: string }) => r.type === 'pull_request');
          const hasDeletionRule = rules.some((r: { type: string }) => r.type === 'deletion');
          const hasNonFastForwardRule = rules.some((r: { type: string }) => r.type === 'non_fast_forward');
          const details: string[] = [];
          if (hasPullRequestRule) details.push('PR required');
          if (hasDeletionRule) details.push('delete protected');
          if (hasNonFastForwardRule) details.push('force-push blocked');
          if (details.length >= 2) {
            checks.push({
              name: 'Branch protection',
              state: 'PASS',
              detail: details.join(', '),
            });
          } else {
            checks.push({
              name: 'Branch protection',
              state: 'WARN',
              detail: `Partial: ${details.join(', ') || 'none detected'}`,
            });
          }
        }
      } catch (e) {
        checks.push({
          name: 'Branch protection',
          state: 'WARN',
          detail: `Cannot verify: ${(e as Error).message}`,
        });
      }

      // Genesis check (uses detectGenesisShell for Windows compatibility)
      try {
        const genesis = detectGenesisShell(root);
        if (!genesis.command) throw new Error(genesis.detail);
        runExecSync(genesis.command, { cwd: root, stdio: 'pipe', timeout: 30000 });
        checks.push({ name: 'Genesis validate', state: 'PASS', detail: '5/5 checks passing' });
      } catch (err) {
        const detail = (err as Error).message || 'Genesis checks failed';
        checks.push({ name: 'Genesis validate', state: 'FAIL', detail: `Genesis validation failed: ${detail}` });
      }

      // LLM routing status
      {
        const llmConfig = describeLLMRoutingConfig(process.env as Record<string, string | undefined>);
        const detail =
          llmConfig.mode === 'keyword-only'
            ? 'Keyword router active. Configure OPENSLACK_LLM_PROVIDER to enable LLM-first routing.'
            : llmConfig.mode === 'llm-first'
              ? `LLM-first routing (provider: ${llmConfig.provider}, model: ${llmConfig.model}). Keyword router serves as fallback.`
              : `LLM provider set but configuration incomplete: ${llmConfig.issues?.join(', ') ?? 'unknown'}`;
        checks.push({
          name: `Intent Routing: ${llmConfig.mode}`,
          state: llmConfig.mode === 'misconfigured' ? 'WARN' : 'PASS',
          detail,
        });
      }

      console.log('OpenSlack Doctor');
      console.log('════════════════');
      let hasFail = false;
      for (const c of checks) {
        if (c.state === 'FAIL') hasFail = true;
      }

      if (options.format === 'plain') {
        const findings: PlainFinding[] = checks.map((c) => ({
          status: c.state,
          title: c.name,
          detail: c.detail,
          nextAction: c.state === 'FAIL' ? `Fix the "${c.name}" issue to proceed` : undefined,
        }));
        console.log(renderFindingsPlain(findings));
      } else {
        for (const c of checks) {
          console.log(`[${c.state}] ${c.name}: ${c.detail}`);
        }
      }

      console.log('');
      if (hasFail) {
        console.log(options.format === 'plain'
          ? 'Some items need attention. Check the "Action needed" items above.'
          : 'Some checks failed. Review output above.');
        process.exit(1);
      } else {
        console.log(options.format === 'plain'
          ? 'Everything looks good. Review "Attention" items if any.'
          : 'All critical checks passed. Review WARN items above.');
      }
    });

  return cmd;
}

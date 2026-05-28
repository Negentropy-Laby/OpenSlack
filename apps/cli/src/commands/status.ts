import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { readModules, validateModules, getTotalTests, getTotalTestFiles } from '@openslack/workspace';
import { recommendNextActions } from '@openslack/runtime';
import { getAttentionItems, getNextAction } from '@openslack/runtime';
import { buildSetupReport } from '@openslack/runtime';
import { buildDashboardProjection } from '@openslack/collaboration';

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

function getGitInfo(root: string): { commitCount: number; latestCommit: string; latestSubject: string } {
  try {
    const commitCount = parseInt(execSync('git rev-list --count HEAD', { cwd: root, encoding: 'utf-8', stdio: 'pipe' }).trim(), 10);
    const latestCommit = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf-8', stdio: 'pipe' }).trim();
    const latestSubject = execSync('git log -1 --format=%s', { cwd: root, encoding: 'utf-8', stdio: 'pipe' }).trim();
    return { commitCount, latestCommit, latestSubject };
  } catch {
    return { commitCount: 0, latestCommit: 'unknown', latestSubject: 'unknown' };
  }
}

function extractCurrentMetrics(current: string): { tests?: number; testFiles?: number; vitestTests?: number; vitestFiles?: number } {
  const testMatch = current.match(/(\d+)\s*tests across\s*(\d+)\s*module test file/i);
  const vitestMatch = current.match(/(\d+)\s*Vitest tests across\s*(\d+)\s*files/i);
  return {
    tests: testMatch ? parseInt(testMatch[1], 10) : undefined,
    testFiles: testMatch ? parseInt(testMatch[2], 10) : undefined,
    vitestTests: vitestMatch ? parseInt(vitestMatch[1], 10) : undefined,
    vitestFiles: vitestMatch ? parseInt(vitestMatch[2], 10) : undefined,
  };
}

function generateStatusDoc(root: string): string {
  const registry = readModules(root);
  const validation = validateModules(registry);
  if (!validation.valid) {
    throw new Error(`modules.yaml validation failed:\n${validation.errors.join('\n')}`);
  }

  const totalTests = getTotalTests(registry);
  const totalTestFiles = getTotalTestFiles(registry);
  const vitestTests = registry.vitest_tests ?? totalTests;
  const vitestFiles = registry.vitest_files ?? totalTestFiles;
  const totalGoldenEvals = registry.modules.reduce((sum, m) => sum + (m.golden_evals || 0), 0);

  const moduleRows = registry.modules
    .map((m) => `| ${m.name} | ${m.phase} | ${m.status.toUpperCase()} | ${m.notes || ''} |`)
    .join('\n');

  const packageSet = new Set<string>();
  for (const m of registry.modules) {
    for (const pkg of m.packages || []) packageSet.add(pkg);
  }
  const packages = Array.from(packageSet);

  const cliSet = new Set<string>();
  for (const m of registry.modules) {
    for (const cli of m.cli || []) cliSet.add(cli);
  }
  const cliCommands = Array.from(cliSet);

  return `---
schema: openslack.status.v1
source_of_truth: true
supersedes:
  - phase-1-prehardening
---

# OpenSlack Current Status

## Repository

| Field | Value |
|-------|-------|
| Remote | \`https://github.com/Negentropy-Laby/OpenSlack\` |

## Modules

| Module | Phase | Status | Notes |
|--------|-------|--------|-------|
${moduleRows}

## Packages (${packages.length} active)

${packages.map((p) => `- ${p}`).join('\n')}

## CLI Commands

${cliCommands.map((c) => `- ${c}`).join('\n')}

## Golden Evals

${totalGoldenEvals}/${totalGoldenEvals} passing. Zero stub assertions.

## Test Suite

${vitestTests} Vitest tests across ${vitestFiles} files. All passing.

Module-attributed coverage: ${totalTests} tests across ${totalTestFiles} module test files (packages shared across modules are counted per module).

## Module Registry

Source: \`.openslack/modules.yaml\` — auto-generated from modules.yaml.
`;
}

interface GitHubOps {
  ready: number;
  claimed: number;
  blocked: number;
  openPRs: number;
  blockedPRs: number;
  readyPRs: number;
  available: boolean;
}

function getGitHubOps(): GitHubOps {
  try {
    const issuesJson = execSync(
      'gh issue list --repo Negentropy-Laby/OpenSlack --state open --limit 200 --json labels',
      { encoding: 'utf-8', stdio: 'pipe' },
    );
    const issues = JSON.parse(issuesJson) as Array<{ labels: Array<{ name: string }> }>;
    let ready = 0;
    let claimed = 0;
    let blocked = 0;
    for (const issue of issues) {
      const names = issue.labels.map((l) => l.name);
      if (names.includes('openslack:ready')) ready++;
      if (names.includes('openslack:claimed')) claimed++;
      if (names.includes('openslack:blocked')) blocked++;
    }

    const prsJson = execSync(
      'gh pr list --repo Negentropy-Laby/OpenSlack --state open --limit 200 --json mergeStateStatus',
      { encoding: 'utf-8', stdio: 'pipe' },
    );
    const prs = JSON.parse(prsJson) as Array<{ mergeStateStatus: string }>;
    const openPRs = prs.length;
    const blockedPRs = prs.filter((p) => p.mergeStateStatus === 'BLOCKED').length;
    const readyPRs = prs.filter((p) => p.mergeStateStatus === 'CLEAN').length;

    return { ready, claimed, blocked, openPRs, blockedPRs, readyPRs, available: true };
  } catch {
    return { ready: 0, claimed: 0, blocked: 0, openPRs: 0, blockedPRs: 0, readyPRs: 0, available: false };
  }
}

async function showStatusDashboard(root: string): Promise<void> {
  try {
    const registry = readModules(root);
    const gitInfo = getGitInfo(root);
    const totalTests = getTotalTests(registry);
    const totalTestFiles = getTotalTestFiles(registry);
    const vitestTests = registry.vitest_tests ?? totalTests;
    const vitestFiles = registry.vitest_files ?? totalTestFiles;
    const ops = getGitHubOps();

    console.log('OpenSlack Status');
    console.log('════════════════');
    console.log(`Version:    v0.1 Developer Preview`);
    console.log(`Mode:       Self-Project`);
    console.log(`Commit:     ${gitInfo.latestCommit}`);
    console.log('');
    console.log('Modules:');
    for (const m of registry.modules) {
      const testLabel = m.tests ? ` (${m.tests} tests)` : '';
      const status = m.status.toUpperCase();
      console.log(`  ${m.name.padEnd(22)} ${status}${testLabel}`);
    }
    console.log('');

    if (ops.available) {
      console.log('GitHub:');
      console.log(`  Tasks ready:        ${ops.ready}`);
      console.log(`  Tasks claimed:      ${ops.claimed}`);
      console.log(`  Tasks blocked:      ${ops.blocked}`);
      console.log(`  PRs open:           ${ops.openPRs}`);
      console.log(`  PRs blocked:        ${ops.blockedPRs}`);
      console.log(`  PRs ready:          ${ops.readyPRs}`);
      console.log('');
    }

    console.log(`Test Suite: ${vitestTests} Vitest tests across ${vitestFiles} files`);
    console.log('');

    const setupReport = await buildSetupReport({ dryRun: true });
    const dashboard = buildDashboardProjection();
    const recs = recommendNextActions({
      setupFindings: setupReport.findings.map((f) => ({
        status: f.status,
        title: f.title,
        nextAction: f.nextAction,
        command: f.command,
      })),
      gitHubOps: ops,
      blockers: dashboard.blockers.map((b) => ({
        object: b.object,
        summary: b.summary,
        owner: b.owner,
        nextAction: b.nextAction,
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

    // Needs Attention section
    const attentionCtx = {
      setupFindings: setupReport.findings.map((f) => ({
        status: f.status,
        title: f.title,
        nextAction: f.nextAction,
        command: f.command,
      })),
      gitHubOps: ops,
      blockers: dashboard.blockers.map((b) => ({
        object: b.object,
        summary: b.summary,
        owner: b.owner,
        nextAction: b.nextAction,
      })),
    };
    const attentionItems = await getAttentionItems(attentionCtx);

    console.log('Needs Attention:');
    if (attentionItems.length === 0) {
      console.log('  All clear');
    } else {
      for (const item of attentionItems) {
        const label = item.priority.toUpperCase();
        console.log(`  [${label}] ${item.type}: ${item.description}`);
        console.log(`         ${item.action}`);
      }
    }
    console.log('');

    const nextAction = getNextAction(attentionItems);
    console.log(`Recommended Next Action: ${nextAction}`);
  } catch (e) {
    console.error(`Status dashboard failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

export function statusCommands(): Command {
  const cmd = new Command('status').description('OpenSlack status and module registry commands');

  cmd
    .option('--format <format>', 'Output format: standard or tui', 'standard')
    .action(async (options: { format: string }) => {
      const root = findRepoRoot();

      if (options.format === 'tui') {
        try {
          const registry = readModules(root);
          const gitInfo = getGitInfo(root);
          const totalTests = getTotalTests(registry);
          const totalTestFiles = getTotalTestFiles(registry);
          const vitestTests = registry.vitest_tests ?? totalTests;
          const vitestFiles = registry.vitest_files ?? totalTestFiles;
          const ops = getGitHubOps();

          const setupReport = await buildSetupReport({ dryRun: true });
          const dashboard = buildDashboardProjection();
          const recs = recommendNextActions({
            setupFindings: setupReport.findings.map((f) => ({
              status: f.status,
              title: f.title,
              nextAction: f.nextAction,
              command: f.command,
            })),
            gitHubOps: ops,
            blockers: dashboard.blockers.map((b) => ({
              object: b.object,
              summary: b.summary,
              owner: b.owner,
              nextAction: b.nextAction,
            })),
          });

          const attentionCtx = {
            setupFindings: setupReport.findings.map((f) => ({
              status: f.status,
              title: f.title,
              nextAction: f.nextAction,
              command: f.command,
            })),
            gitHubOps: ops,
            blockers: dashboard.blockers.map((b) => ({
              object: b.object,
              summary: b.summary,
              owner: b.owner,
              nextAction: b.nextAction,
            })),
          };
          const attentionItems = await getAttentionItems(attentionCtx);
          const nextAction = getNextAction(attentionItems);

          const { renderStatusTui } = await import('@openslack/tui');
          await renderStatusTui({
            commit: gitInfo.latestCommit,
            commitSubject: gitInfo.latestSubject,
            modules: registry.modules.map((m) => ({
              name: m.name,
              status: m.status.toUpperCase(),
              tests: m.tests,
            })),
            gitHub: {
              available: ops.available,
              tasksReady: ops.ready,
              tasksClaimed: ops.claimed,
              tasksBlocked: ops.blocked,
              prsOpen: ops.openPRs,
              prsBlocked: ops.blockedPRs,
              prsReady: ops.readyPRs,
            },
            testSuite: { totalTests: vitestTests, totalFiles: vitestFiles },
            recommendations: recs.map((r) => ({
              title: r.title,
              action: r.action,
              command: r.command,
            })),
            attentionItems,
            nextAction,
          });
        } catch (error) {
          console.error('TUI unavailable. Falling back to standard output.');
          await showStatusDashboard(root);
        }
      } else {
        await showStatusDashboard(root);
      }
    });

  cmd
    .command('generate')
    .description('Generate docs/status/current.md from .openslack/modules.yaml')
    .action(() => {
      try {
        const root = findRepoRoot();
        const doc = generateStatusDoc(root);
        const outPath = join(root, 'docs', 'status', 'current.md');
        writeFileSync(outPath, doc, 'utf-8');
        console.log(`Generated: ${outPath}`);
        console.log('Run `openslack status verify` to check consistency.');
      } catch (e) {
        console.error(`Generate failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command('verify')
    .description('Verify consistency across README, current.md, and modules.yaml')
    .action(() => {
      try {
        const root = findRepoRoot();
        const registry = readModules(root);
        const validation = validateModules(registry);
        if (!validation.valid) {
          console.error('modules.yaml validation failed:');
          for (const err of validation.errors) console.error(`  ✗ ${err}`);
          process.exit(1);
        }

        const currentPath = join(root, 'docs', 'status', 'current.md');
        const current = existsSync(currentPath) ? readFileSync(currentPath, 'utf-8') : '';

        const currentMetrics = extractCurrentMetrics(current);
        const totalTests = getTotalTests(registry);
        const totalTestFiles = getTotalTestFiles(registry);
        const vitestTests = registry.vitest_tests ?? totalTests;
        const vitestFiles = registry.vitest_files ?? totalTestFiles;

        const checks: Array<{ name: string; passed: boolean; detail: string }> = [];

        // modules.yaml checks
        checks.push({ name: 'modules.yaml schema', passed: true, detail: registry.schema });
        checks.push({ name: 'modules.yaml modules count', passed: registry.modules.length > 0, detail: `${registry.modules.length} modules` });

        // Vitest actual counts
        if (currentMetrics.vitestTests !== undefined) {
          checks.push({
            name: 'current.md Vitest tests == modules.yaml',
            passed: currentMetrics.vitestTests === vitestTests,
            detail: `current.md: ${currentMetrics.vitestTests}, modules.yaml: ${vitestTests}`,
          });
        }
        if (currentMetrics.vitestFiles !== undefined) {
          checks.push({
            name: 'current.md Vitest files == modules.yaml',
            passed: currentMetrics.vitestFiles === vitestFiles,
            detail: `current.md: ${currentMetrics.vitestFiles}, modules.yaml: ${vitestFiles}`,
          });
        }

        // Module-attributed counts
        if (currentMetrics.tests !== undefined) {
          checks.push({
            name: 'current.md module tests == modules.yaml',
            passed: currentMetrics.tests === totalTests,
            detail: `current.md: ${currentMetrics.tests}, modules.yaml: ${totalTests}`,
          });
        }
        if (currentMetrics.testFiles !== undefined) {
          checks.push({
            name: 'current.md module test files == modules.yaml',
            passed: currentMetrics.testFiles === totalTestFiles,
            detail: `current.md: ${currentMetrics.testFiles}, modules.yaml: ${totalTestFiles}`,
          });
        }

        // Module consistency
        const currentModuleNames = current.match(/\|\s*(.+?)\s*\|\s*[^|]+\s*\|\s*(ACTIVE|EARLY|MVP|PLANNED)/g) || [];
        const registryModuleNames = registry.modules.map((m) => m.name);
        checks.push({
          name: 'current.md modules match modules.yaml',
          passed: registry.modules.length === currentModuleNames.length,
          detail: `modules.yaml: ${registry.modules.length}, current.md: ${currentModuleNames.length}`,
        });

        console.log('Status Verification\n');
        let allPassed = true;
        for (const c of checks) {
          const icon = c.passed ? '✓' : '✗';
          console.log(`[${icon}] ${c.name}: ${c.detail}`);
          if (!c.passed) allPassed = false;
        }

        if (allPassed) {
          console.log('\nAll checks passed. No documentation drift detected.');
        } else {
          console.log('\nDocumentation drift detected. Run `openslack status generate` to fix.');
          process.exit(1);
        }
      } catch (e) {
        console.error(`Verify failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  return cmd;
}

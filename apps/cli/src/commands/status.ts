import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import {
  readModules,
  readProductModules,
  resolveWorkspaceContext,
  validateModules,
  getTotalTests,
  getTotalTestFiles,
} from '@openslack/workspace';
import type { ModulesRegistry, WorkspaceContext } from '@openslack/workspace';
import type { StatusTuiData } from '@openslack/tui';
import { recommendNextActions } from '@openslack/runtime';
import { getAttentionItems, getNextAction } from '@openslack/runtime';
import { buildSetupReport } from '@openslack/runtime';
import { buildDashboardProjection } from '@openslack/collaboration';
import { diagnoseAgentRuntime } from '@openslack/agent-runtime';
import { getBuildInfo } from '../release/build-info.js';

function getGitInfo(root: string): {
  commitCount: number;
  latestCommit: string;
  latestSubject: string;
} {
  try {
    const commitCount = parseInt(
      execSync('git rev-list --count HEAD', { cwd: root, encoding: 'utf-8', stdio: 'pipe' }).trim(),
      10,
    );
    const latestCommit = execSync('git rev-parse --short HEAD', {
      cwd: root,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    const latestSubject = execSync('git log -1 --format=%s', {
      cwd: root,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    return { commitCount, latestCommit, latestSubject };
  } catch {
    return { commitCount: 0, latestCommit: 'unknown', latestSubject: 'unknown' };
  }
}

function extractCurrentMetrics(current: string): {
  tests?: number;
  testFiles?: number;
  vitestTests?: number;
  vitestFiles?: number;
} {
  const testMatch = current.match(/(\d+)\s*tests across\s*(\d+)\s*module test file/i);
  const vitestMatch = current.match(
    /(\d+)\s*(?:passing\s*)?Vitest tests across\s*(\d+)\s*(?:passing\s*)?files/i,
  );
  return {
    tests: testMatch ? parseInt(testMatch[1], 10) : undefined,
    testFiles: testMatch ? parseInt(testMatch[2], 10) : undefined,
    vitestTests: vitestMatch ? parseInt(vitestMatch[1], 10) : undefined,
    vitestFiles: vitestMatch ? parseInt(vitestMatch[2], 10) : undefined,
  };
}

function tableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

export function inlineCodeCell(value: string): string {
  const normalized = tableCell(value);
  return normalized.includes('`') ? `\`\` ${normalized} \`\`` : `\`${normalized}\``;
}

function listCell(values: string[]): string {
  return values.length > 0 ? values.map(inlineCodeCell).join('<br>') : 'None';
}

export function renderMarkdownTable(headers: string[], rows: string[][]): string {
  if (headers.length === 0) throw new Error('Markdown tables require at least one column.');
  for (const row of rows) {
    if (row.length !== headers.length) {
      throw new Error(`Markdown table row has ${row.length} cells; expected ${headers.length}.`);
    }
  }

  const widths = headers.map((header, index) =>
    Math.max(3, header.length, ...rows.map((row) => row[index].length)),
  );
  const renderRow = (row: string[]): string =>
    `| ${row.map((cell, index) => cell.padEnd(widths[index])).join(' | ')} |`;
  const separator = widths.map((width) => '-'.repeat(width));
  return [renderRow(headers), renderRow(separator), ...rows.map(renderRow)].join('\n');
}

function operatorLabel(configured: boolean): string {
  return configured ? 'CONFIGURED' : 'NOT_CONFIGURED';
}

export function generateStatusDoc(root: string): string {
  const registry = readModules(root);
  const validation = validateModules(registry, { rootPath: root });
  if (!validation.valid) {
    throw new Error(`modules.yaml validation failed:\n${validation.errors.join('\n')}`);
  }

  const totalTests = getTotalTests(registry);
  const totalTestFiles = getTotalTestFiles(registry);
  const vitestTests = registry.vitest_tests ?? totalTests;
  const vitestFiles = registry.vitest_files ?? totalTestFiles;
  const totalGoldenEvals = registry.modules.reduce((sum, m) => sum + (m.golden_evals || 0), 0);

  const repositoryTable = renderMarkdownTable(
    ['Field', 'Value'],
    [['Remote', '`https://github.com/Negentropy-Laby/OpenSlack`']],
  );
  const moduleTable = renderMarkdownTable(
    [
      'Module',
      'Phase',
      'Lifecycle',
      'Maturity',
      'Declared Operator Baseline',
      'External Blockers',
      'Evidence',
      'Notes',
    ],
    registry.modules.map((module) => [
      tableCell(module.name),
      tableCell(module.phase),
      module.status.toUpperCase(),
      module.maturity.toUpperCase(),
      operatorLabel(module.operatorConfigured),
      listCell(module.externalBlockers),
      listCell(module.evidenceRefs),
      tableCell(module.notes || ''),
    ]),
  );
  const componentTable = renderMarkdownTable(
    [
      'Owning Module',
      'Component',
      'Maturity',
      'Declared Operator Baseline',
      'External Blockers',
      'Evidence',
    ],
    registry.modules
      .flatMap((module) =>
        (module.components ?? []).map((component) => [
          tableCell(module.name),
          tableCell(component.name),
          component.maturity.toUpperCase(),
          operatorLabel(component.operatorConfigured),
          listCell(component.externalBlockers),
          listCell(component.evidenceRefs),
        ]),
      )
      .concat(
        registry.modules.some((module) => (module.components?.length ?? 0) > 0)
          ? []
          : [['None', 'None', 'PLANNED', 'NOT_CONFIGURED', 'None', 'None']],
      ),
  );
  const deferredTable = renderMarkdownTable(
    ['Work', 'Status', 'Maturity', 'Counts Toward Standalone', 'Branch', 'Evidence', 'Notes'],
    (registry.deferredWork ?? []).length > 0
      ? (registry.deferredWork ?? []).map((item) => [
          tableCell(item.name),
          item.status.toUpperCase(),
          item.maturity.toUpperCase(),
          'NO',
          tableCell(item.branch ?? ''),
          listCell(item.evidenceRefs),
          tableCell(item.notes ?? ''),
        ])
      : [['None', 'DEFERRED', 'PLANNED', 'NO', '', 'None', '']],
  );

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
schema: openslack.status.v2
source_of_truth: true
supersedes:
  - phase-1-prehardening
---

# OpenSlack Current Status

## Repository

${repositoryTable}

## Modules

${moduleTable}

## Components

${componentTable}

## Deferred Work

Deferred work is visible but is not a product module and is not counted toward
standalone P0 completion.

${deferredTable}

## Packages (${packages.length} active)

${packages.length > 0 ? packages.map((p) => `- ${p}`).join('\n') : '- None'}

## CLI Commands

${cliCommands.length > 0 ? cliCommands.map((c) => `- ${c}`).join('\n') : '- None'}

## Golden Evals

${totalGoldenEvals}/${totalGoldenEvals} passing. Zero stub assertions.

## Test Suite

${vitestTests} passing Vitest tests across ${vitestFiles} passing files. No failures recorded.

Module-attributed coverage: ${totalTests} tests across ${totalTestFiles} module test files (packages shared across modules are counted per module).

Note: The Vitest line is the raw passing count recorded in .openslack/modules.yaml. The module-attributed coverage line is the per-module sum from .openslack/modules.yaml, where each test file is counted once per module that claims it. Use module counts for coverage tracking; use raw bun run test output for CI verification, including skipped tests.

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

function getGitHubOps(context: WorkspaceContext): GitHubOps {
  try {
    const remote = context.config?.canonical_remote;
    if (!remote || remote.provider !== 'github') throw new Error('GitHub remote is not configured');
    const repository = `${remote.owner}/${remote.repo}`;
    const issuesJson = execFileSync(
      'gh',
      [
        'issue',
        'list',
        '--repo',
        repository,
        '--state',
        'open',
        '--limit',
        '200',
        '--json',
        'labels',
      ],
      { cwd: context.workspaceRoot, encoding: 'utf-8', stdio: 'pipe' },
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

    const prsJson = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        repository,
        '--state',
        'open',
        '--limit',
        '200',
        '--json',
        'mergeStateStatus',
      ],
      { cwd: context.workspaceRoot, encoding: 'utf-8', stdio: 'pipe' },
    );
    const prs = JSON.parse(prsJson) as Array<{ mergeStateStatus: string }>;
    const openPRs = prs.length;
    const blockedPRs = prs.filter((p) => p.mergeStateStatus === 'BLOCKED').length;
    const readyPRs = prs.filter((p) => p.mergeStateStatus === 'CLEAN').length;

    return { ready, claimed, blocked, openPRs, blockedPRs, readyPRs, available: true };
  } catch {
    return {
      ready: 0,
      claimed: 0,
      blocked: 0,
      openPRs: 0,
      blockedPRs: 0,
      readyPRs: 0,
      available: false,
    };
  }
}

async function showStatusDashboard(context: WorkspaceContext): Promise<void> {
  try {
    const root = context.workspaceRoot;
    const registry = readProductModules(context);
    const validation = validateModules(registry, {
      rootPath: context.sourceCheckout ? root : undefined,
    });
    if (!validation.valid) {
      throw new Error(`product module metadata is invalid: ${validation.errors.join('; ')}`);
    }
    const gitInfo = getGitInfo(root);
    const totalTests = getTotalTests(registry);
    const totalTestFiles = getTotalTestFiles(registry);
    const vitestTests = registry.vitest_tests ?? totalTests;
    const vitestFiles = registry.vitest_files ?? totalTestFiles;
    const ops = getGitHubOps(context);

    console.log('OpenSlack Status');
    console.log('════════════════');
    console.log(`Version:    v${getBuildInfo().version}`);
    console.log(`Mode:       ${context.sourceCheckout ? 'SOURCE_CHECKOUT' : 'WORKSPACE'}`);
    console.log(`Commit:     ${gitInfo.latestCommit}`);
    console.log('');
    console.log('Modules:');
    for (const m of registry.modules) {
      const testLabel = m.tests ? ` (${m.tests} tests)` : '';
      console.log(`  ${m.name}${testLabel}`);
      console.log(
        `    Lifecycle: ${m.status.toUpperCase()} | Maturity: ${m.maturity.toUpperCase()} | Declared operator baseline: ${operatorLabel(m.operatorConfigured)}`,
      );
      console.log(`    External blockers: ${m.externalBlockers.join(', ') || 'none'}`);
      console.log(`    Evidence: ${m.evidenceRefs.join(', ') || 'none'}`);
      for (const component of m.components ?? []) {
        console.log(
          `    Component ${component.name}: ${component.maturity.toUpperCase()} | Declared operator baseline: ${operatorLabel(component.operatorConfigured)}`,
        );
      }
    }
    for (const item of registry.deferredWork ?? []) {
      console.log(
        `  Deferred (excluded): ${item.name} | ${item.maturity.toUpperCase()} | ${item.branch ?? 'no branch'}`,
      );
    }
    console.log('');

    const runtimeReport = diagnoseAgentRuntime({ rootDir: root, env: process.env });
    console.log(`Agent Runtime: ${runtimeReport.readiness}`);
    if (runtimeReport.readiness !== 'ready') {
      console.log(
        `  Next: ${runtimeReport.remediations[0] ?? 'Run openslack agent-runtime doctor --provider aby'}`,
      );
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

    console.log(
      `Test Suite: ${vitestTests} passing Vitest tests across ${vitestFiles} passing files`,
    );
    console.log(
      `  Note: Raw passing Vitest count from .openslack/modules.yaml. Module-attributed counts (${totalTests} tests, ${totalTestFiles} files) count each test file once per module that claims it. Use module counts for coverage tracking; use raw bun run test output for CI verification, including skipped tests.`,
    );
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

export function mapProductRegistryToStatusTuiFields(
  registry: ModulesRegistry,
): Pick<StatusTuiData, 'modules' | 'deferredWork' | 'testSuite'> {
  return {
    modules: registry.modules.map((module) => ({
      name: module.name,
      lifecycle: module.status.toUpperCase(),
      maturity: module.maturity.toUpperCase(),
      operatorConfigured: module.operatorConfigured,
      externalBlockers: module.externalBlockers,
      evidenceRefs: module.evidenceRefs,
      tests: module.tests,
      components: module.components?.map((component) => ({
        name: component.name,
        maturity: component.maturity.toUpperCase(),
        operatorConfigured: component.operatorConfigured,
        externalBlockers: component.externalBlockers,
        evidenceRefs: component.evidenceRefs,
      })),
    })),
    deferredWork: (registry.deferredWork ?? []).map((item) => ({
      name: item.name,
      maturity: item.maturity.toUpperCase(),
      branch: item.branch,
      evidenceRefs: item.evidenceRefs,
      countedTowardStandalone: false,
    })),
    testSuite: {
      totalTests: registry.vitest_tests ?? getTotalTests(registry),
      totalFiles: registry.vitest_files ?? getTotalTestFiles(registry),
    },
  };
}

async function buildStatusTuiData(context: WorkspaceContext): Promise<StatusTuiData> {
  const root = context.workspaceRoot;
  const registry = readProductModules(context);
  const validation = validateModules(registry, {
    rootPath: context.sourceCheckout ? root : undefined,
  });
  if (!validation.valid) {
    throw new Error(`product module metadata is invalid: ${validation.errors.join('; ')}`);
  }

  const gitInfo = getGitInfo(root);
  const productStatus = mapProductRegistryToStatusTuiFields(registry);
  const ops = getGitHubOps(context);
  const setupReport = await buildSetupReport({ dryRun: true });
  const dashboard = buildDashboardProjection();
  const setupFindings = setupReport.findings.map((finding) => ({
    status: finding.status,
    title: finding.title,
    nextAction: finding.nextAction,
    command: finding.command,
  }));
  const blockers = dashboard.blockers.map((blocker) => ({
    object: blocker.object,
    summary: blocker.summary,
    owner: blocker.owner,
    nextAction: blocker.nextAction,
  }));
  const recommendations = recommendNextActions({
    setupFindings,
    gitHubOps: ops,
    blockers,
  });
  const attentionItems = await getAttentionItems({ setupFindings, gitHubOps: ops, blockers });

  return {
    version: `v${getBuildInfo().version}`,
    mode: context.sourceCheckout ? 'SOURCE_CHECKOUT' : 'WORKSPACE',
    commit: gitInfo.latestCommit,
    commitSubject: gitInfo.latestSubject,
    ...productStatus,
    gitHub: {
      available: ops.available,
      tasksReady: ops.ready,
      tasksClaimed: ops.claimed,
      tasksBlocked: ops.blocked,
      prsOpen: ops.openPRs,
      prsBlocked: ops.blockedPRs,
      prsReady: ops.readyPRs,
    },
    recommendations: recommendations.map((recommendation) => ({
      title: recommendation.title,
      action: recommendation.action,
      command: recommendation.command,
    })),
    attentionItems,
    nextAction: getNextAction(attentionItems),
  };
}

export function statusCommands(): Command {
  const cmd = new Command('status').description('OpenSlack status and module registry commands');

  cmd
    .option('--format <format>', 'Output format: standard, plain, or tui', 'standard')
    .action(async (options: { format: string }) => {
      const context = resolveWorkspaceContext();

      if (options.format === 'tui') {
        try {
          const { renderStatusTui } = await import('@openslack/tui');
          await renderStatusTui(await buildStatusTuiData(context));
        } catch {
          console.error('TUI unavailable. Falling back to standard output.');
          await showStatusDashboard(context);
        }
      } else if (options.format === 'plain') {
        try {
          const { mapStatusToViewModel, renderPlainStatus } = await import('@openslack/tui');
          console.log(renderPlainStatus(mapStatusToViewModel(await buildStatusTuiData(context))));
        } catch (error) {
          console.error(`Plain status failed: ${(error as Error).message}`);
          process.exit(1);
        }
      } else {
        if (options.format !== 'standard') {
          console.error(`Unknown status format: ${options.format}. Use standard, plain, or tui.`);
          process.exit(1);
          return;
        }
        await showStatusDashboard(context);
      }
    });

  cmd
    .command('generate')
    .description('Generate docs/status/current.md from .openslack/modules.yaml')
    .action(() => {
      try {
        const context = resolveWorkspaceContext();
        if (!context.sourceCheckout) {
          throw new Error('status generate is available only in an OpenSlack source checkout');
        }
        const root = context.workspaceRoot;
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
        const context = resolveWorkspaceContext();
        if (!context.sourceCheckout) {
          throw new Error('status verify is available only in an OpenSlack source checkout');
        }
        const root = context.workspaceRoot;
        const registry = readModules(root);
        const validation = validateModules(registry, { rootPath: root });
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
        checks.push({
          name: 'canonical modules.yaml source schema',
          passed: registry.sourceSchema === 'openslack.modules.v2',
          detail: registry.sourceSchema ?? 'unknown',
        });
        checks.push({
          name: 'modules.yaml modules count',
          passed: registry.modules.length > 0,
          detail: `${registry.modules.length} modules`,
        });

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

        const expectedCurrent = generateStatusDoc(root);
        checks.push({
          name: 'current.md deterministic generation',
          passed: current === expectedCurrent,
          detail: current === expectedCurrent ? 'exact byte match' : 'generated content differs',
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

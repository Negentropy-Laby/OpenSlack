import { Command } from 'commander';

export function tuiCommands(): Command {
  return new Command('tui')
    .description('Launch the interactive TUI workbench')
    .action(async () => {
      try {
        const { isTuiSupported } = await import('@openslack/tui');
        if (!isTuiSupported()) {
          console.error('TUI requires an interactive terminal with at least 40 columns and 12 rows.');
          console.error('Use --format standard for text output.');
          process.exit(1);
        }

        const { renderShellTui, mapDashboardToViewModel, mapStatusToViewModel, mapPrQueueToViewModel, mapWorkflowGalleryToViewModel, mapApprovalCenterToViewModel } = await import('@openslack/tui');
        const data: import('@openslack/tui').ShellViewData = {};

        // Resolve repo root
        const { existsSync } = await import('node:fs');
        const { join, dirname } = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        let dir = process.cwd();
        for (let i = 0; i < 10; i++) {
          if (existsSync(join(dir, 'openslack.yaml'))) break;
          const parent = join(dir, '..');
          if (parent === dir) break;
          dir = parent;
        }
        const root = dir;
        if (process.cwd() !== root) {
          process.chdir(root);
        }

        // Pre-fetch dashboard data
        try {
          const { buildDashboardProjection } = await import('@openslack/collaboration');
          const projection = buildDashboardProjection();
          data.dashboard = mapDashboardToViewModel(projection);
        } catch {
          // Dashboard data unavailable
        }

        // Pre-fetch PR queue data
        try {
          const { buildPRQueue } = await import('@openslack/pr');
          const items = await buildPRQueue();
          data.prQueue = mapPrQueueToViewModel(items);
        } catch {
          // PR queue data unavailable
        }

        // Pre-fetch status data
        try {
          const { execSync } = await import('node:child_process');
          const { readModules, getTotalTests, getTotalTestFiles } = await import('@openslack/workspace');

          const registry = readModules(root);
          const totalTests = getTotalTests(registry);
          const totalTestFiles = getTotalTestFiles(registry);
          const vitestTests = registry.vitest_tests ?? totalTests;
          const vitestFiles = registry.vitest_files ?? totalTestFiles;

          let commit = 'unknown';
          let commitSubject = 'unknown';
          try {
            commit = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf-8', stdio: 'pipe' }).trim();
            commitSubject = execSync('git log -1 --format=%s', { cwd: root, encoding: 'utf-8', stdio: 'pipe' }).trim();
          } catch {}

          data.status = mapStatusToViewModel({
            commit,
            commitSubject,
            modules: registry.modules.map(m => ({ name: m.name, status: m.status.toUpperCase(), tests: m.tests })),
            gitHub: { available: false, tasksReady: 0, tasksClaimed: 0, tasksBlocked: 0, prsOpen: 0, prsBlocked: 0, prsReady: 0 },
            testSuite: { totalTests: vitestTests, totalFiles: vitestFiles },
            recommendations: [],
            attentionItems: [],
            nextAction: 'Run openslack status for full report',
          });
        } catch {
          // Status data unavailable
        }

        // Pre-fetch workflow gallery data
        try {
          const { discoverJsWorkflows, discoverYamlTemplates, TrustStore } = await import('@openslack/workflows');
          const trustStore = new TrustStore({ rootDir: root });
          const jsWorkflows = await discoverJsWorkflows(root);
          const yamlDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'templates', 'workflows');
          const yamlWorkflows = await discoverYamlTemplates(yamlDir);

          const workflows = [
            ...yamlWorkflows.map(w => ({
              name: w.name,
              description: w.displayName,
              format: 'yaml' as const,
              trustLevel: trustStore.get(w.name),
              risk: 'unknown',
              phases: w.phases,
            })),
            ...jsWorkflows.map(w => ({
              name: w.name,
              description: w.description ?? w.displayName,
              format: 'js' as const,
              trustLevel: trustStore.get(w.name),
              risk: 'unknown',
              phases: w.phases,
            })),
          ];

          data.workflowGallery = mapWorkflowGalleryToViewModel({ workflows });
        } catch {
          // Workflow gallery data unavailable
        }

        // Pre-fetch approval data
        try {
          const { listPendingPlans } = await import('@openslack/operator');
          const { listHandoffs } = await import('@openslack/collaboration');

          const pendingPlans = listPendingPlans(root);
          const openHandoffs = listHandoffs().filter(h => h.status === 'open');

          const pendingApprovals = [
            ...pendingPlans
              .filter(p => p.state === 'pending')
              .map(p => ({
                id: p.planId,
                category: 'plan' as const,
                title: `Plan: ${p.query}`,
                detail: `Plan ${p.planId} with ${p.plan.steps.length} steps, risk: ${p.plan.riskLevel}`,
                risk: p.plan.riskLevel === 'high' ? 'high' : p.plan.riskLevel === 'medium' ? 'medium' : 'low',
                requestedBy: p.actorId ?? 'system',
                requestedAt: p.createdAt,
                planId: p.planId,
              })),
            ...openHandoffs.map(h => ({
              id: h.id,
              category: 'workflow-effect' as const,
              title: `Handoff: ${h.context}`,
              detail: `From ${h.from} to ${h.to}${h.nextSteps.length ? ', next: ' + h.nextSteps.join(', ') : ''}`,
              risk: 'low',
              requestedBy: h.from,
              requestedAt: h.createdAt,
            })),
          ];

          data.approvals = mapApprovalCenterToViewModel({ pendingApprovals });
        } catch {
          // Approval data unavailable
        }

        // Inject action handlers (side-effect execution stays in CLI layer)
        try {
          const { createActionHandlers } = await import('./tui-executors.js');
          data.actionHandlers = createActionHandlers(root);
        } catch {
          // Action handlers unavailable — TUI will show CLI fallbacks
        }

        await renderShellTui(data);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`TUI unavailable: ${message}`);
        console.error('Use --format standard for text output.');
        process.exit(1);
      }
    });
}

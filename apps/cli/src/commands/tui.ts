import { Command } from 'commander';

export function tuiCommands(): Command {
  return new Command('tui')
    .description('Launch the interactive TUI workbench')
    .addCommand(
      new Command('doctor')
        .description('Diagnose terminal capabilities for TUI support')
        .action(async () => {
          const { diagnoseTui, renderDiagnosticsPlain } = await import('@openslack/tui');
          const report = diagnoseTui();
          console.log(renderDiagnosticsPlain(report));
        }),
    )
    .action(async () => {
      try {
        const { isTuiSupported, renderPlain, renderPlainHome, mapDashboardToViewModel } = await import('@openslack/tui');
        if (!isTuiSupported()) {
          // Fall back to plain-text renderer for unsupported terminals
          const { mapHomeToViewModel } = await import('@openslack/tui');
          const homeVm = mapHomeToViewModel();
          console.log(renderPlainHome(homeVm));
          process.exit(0);
        }

        const { renderShellTui, mapStatusToViewModel, mapPrQueueToViewModel, mapWorkflowGalleryToViewModel, mapApprovalCenterToViewModel, mapWorkflowLifecycleToViewModel } = await import('@openslack/tui');
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
              format: w.format ?? 'openslack-native',
              trustLevel: trustStore.get(w.name),
              risk: 'unknown',
              phases: w.phases,
            })),
          ];

          data.workflowGallery = mapWorkflowGalleryToViewModel({ workflows });

          // Pre-fetch workflow lifecycle base data (cheap local data only)
          try {
            const { findWorkflow, loadWorkflow, RunStore } = await import('@openslack/workflows');
            const lifecycleBase: Record<string, { workflowHash: string; trustLevel: string; risk: string; sourcePath: string; currentRun?: { runId: string; status: string; startedAt: string } }> = {};

            for (const wf of workflows) {
              const found = await findWorkflow(wf.name, root);
              if (!found) continue;
              const mod = await loadWorkflow(found.path);
              const runStore = new RunStore({ baseDir: join(root, '.openslack.local', 'workflows') });

              // Find most recent run for this workflow across all statuses
              let currentRun: { runId: string; status: string; startedAt: string } | undefined;
              for (const status of ['running', 'paused_waiting_approval', 'paused', 'completed', 'failed', 'cancelled']) {
                const runs = await runStore.listRunsByStatus(status as 'running' | 'paused_waiting_approval' | 'paused' | 'completed' | 'failed' | 'cancelled');
                const match = runs.find(r => r.workflowName === wf.name);
                if (match) {
                  currentRun = { runId: match.runId, status: match.status, startedAt: match.startedAt };
                  break;
                }
              }

              lifecycleBase[wf.name] = {
                workflowHash: mod.hash.slice(0, 16),
                trustLevel: wf.trustLevel,
                risk: mod.meta.risk ?? 'unknown',
                sourcePath: mod.source ?? found.path,
                currentRun,
              };
            }

            data.workflowLifecycleBase = lifecycleBase;
          } catch {
            // Lifecycle base data unavailable
          }
        } catch {
          // Workflow gallery data unavailable
        }

        data.workflowLifecycleLoader = async (
          workflowName: string,
          baseData?: import('@openslack/tui').WorkflowLifecycleBaseData,
        ): Promise<import('@openslack/tui').WorkflowLifecycleViewModel | null> => {
          const { fetchWorkflowLifecycleIssues } = await import('@openslack/github');
          const gh = await fetchWorkflowLifecycleIssues(workflowName);

          const stages: import('@openslack/tui').LifecycleStage[] = [];

          if (gh.proposalIssue) {
            stages.push({
              name: 'proposal',
              label: 'Proposal',
              status: gh.proposalIssue.state === 'open' ? 'pending' : 'complete',
              icon: '\u{1F4DD}',
              issueNumber: gh.proposalIssue.number,
              issueUrl: gh.proposalIssue.url,
              detail: `Proposal issue #${gh.proposalIssue.number}`,
            });
          }

          if (gh.reviewIssue) {
            stages.push({
              name: 'review',
              label: 'Review',
              status: gh.reviewIssue.state === 'open' ? 'in-progress' : 'complete',
              icon: '\u{1F50D}',
              issueNumber: gh.reviewIssue.number,
              issueUrl: gh.reviewIssue.url,
              detail: `Review issue #${gh.reviewIssue.number}`,
            });
          }

          if (gh.splitIssue) {
            stages.push({
              name: 'split',
              label: 'Split',
              status: gh.splitIssue.state === 'open' ? 'pending' : 'complete',
              icon: '⚡',
              issueNumber: gh.splitIssue.number,
              issueUrl: gh.splitIssue.url,
              detail: `Split into ${gh.phaseIssues.length} phase${gh.phaseIssues.length === 1 ? '' : 's'}`,
            });
          }

          for (const pi of gh.phaseIssues) {
            stages.push({
              name: `phase-${pi.phase}`,
              label: `Phase: ${pi.phase}`,
              status: pi.state === 'open' ? (pi.blockedBy && pi.blockedBy.length > 0 ? 'blocked' : 'in-progress') : 'complete',
              icon: pi.blockedBy && pi.blockedBy.length > 0 ? '\u{1F512}' : '✓',
              issueNumber: pi.number,
              issueUrl: pi.url,
              detail: pi.blockedBy && pi.blockedBy.length > 0
                ? `Blocked by #${pi.blockedBy.join(', #')}`
                : `Phase issue #${pi.number}`,
            });
          }

          if (gh.runIssues.length > 0) {
            const latest = gh.runIssues[0];
            stages.push({
              name: 'run',
              label: 'Run Audit',
              status: latest.status === 'completed' ? 'complete' : latest.status === 'failed' ? 'failed' : 'in-progress',
              icon: '\u{1F3C3}',
              issueNumber: latest.number,
              issueUrl: latest.url,
              detail: `Run ${latest.runId} — ${latest.status}`,
            });
          }

          if (gh.improvementIssues.length > 0) {
            stages.push({
              name: 'improvement',
              label: 'Improvements',
              status: gh.improvementIssues.every(i => i.state === 'closed') ? 'complete' : 'in-progress',
              icon: '\u{1F4A1}',
              detail: `${gh.improvementIssues.length} improvement issue${gh.improvementIssues.length === 1 ? '' : 's'}`,
            });
          }

          if (gh.linkedPRs.length > 0) {
            const pr = gh.linkedPRs[0];
            stages.push({
              name: 'pr',
              label: 'Pull Request',
              status: pr.state === 'closed' ? 'complete' : pr.state === 'merged' ? 'complete' : 'in-progress',
              icon: '\u{1F4E6}',
              detail: `PR #${pr.number}`,
            });
          }

          const phaseIssues: import('@openslack/tui').PhaseIssueItem[] = gh.phaseIssues.map(pi => ({
            phase: pi.phase,
            issueNumber: pi.number,
            status: pi.state,
            blockedBy: pi.blockedBy?.map(String),
            trackingMode: pi.trackingMode,
          }));

          let nextAction: string | undefined;
          if (!gh.proposalIssue) {
            nextAction = 'Publish proposal issue (p in Issues menu)';
          } else if (gh.proposalIssue.state === 'open') {
            nextAction = 'Awaiting proposal approval';
          } else if (!gh.reviewIssue) {
            nextAction = 'Request security review (r in Issues menu)';
          } else if (gh.reviewIssue.state === 'open') {
            nextAction = 'Security review in progress';
          } else if (!gh.splitIssue && gh.phaseIssues.length === 0) {
            nextAction = 'Split into phase issues (s in Issues menu)';
          } else if (gh.phaseIssues.some(p => p.state === 'open')) {
            nextAction = `Complete ${gh.phaseIssues.filter(p => p.state === 'open').length} open phase issue(s)`;
          } else if (gh.runIssues.length === 0) {
            nextAction = 'Run workflow audit (r to run)';
          } else if (gh.linkedPRs.length === 0) {
            nextAction = 'Create PR and finalize';
          } else if (gh.linkedPRs[0].state === 'open') {
            nextAction = 'Awaiting PR merge';
          } else {
            nextAction = 'Lifecycle complete';
          }

          return mapWorkflowLifecycleToViewModel({
            workflowName,
            workflowHash: baseData?.workflowHash ?? '',
            trustLevel: baseData?.trustLevel ?? 'untrusted',
            risk: baseData?.risk ?? 'unknown',
            sourcePath: baseData?.sourcePath ?? '',
            stages,
            phaseIssues,
            currentRun: baseData?.currentRun
              ? {
                  runId: baseData.currentRun.runId,
                  status: baseData.currentRun.status,
                  startedAt: baseData.currentRun.startedAt,
                  phaseIndex: 0,
                }
              : undefined,
            prNumber: gh.linkedPRs[0]?.number,
            prStatus: gh.linkedPRs[0]?.state,
            nextAction,
            subIssueMode: gh.subIssueMode,
            dependencyMode: gh.dependencyMode,
            fallbackReasons: gh.fallbackReasons,
            parentIssueNumber: gh.splitIssue?.number ?? gh.proposalIssue?.number,
          });
        };

        // Pre-fetch digest data
        try {
          const { readEvents, filterEvents, buildDigest } = await import('@openslack/collaboration');
          const { mapDigestToViewModel } = await import('@openslack/tui');
          const events = readEvents();
          const filtered = filterEvents(events, { since: new Date(Date.now() - 24 * 60 * 60 * 1000) });
          const digest = buildDigest(filtered, 24);
          data.digest = mapDigestToViewModel(digest);
        } catch {
          // Digest data unavailable
        }

        // Pre-fetch handoff list data
        try {
          const { listHandoffs } = await import('@openslack/collaboration');
          const { mapHandoffListToViewModel } = await import('@openslack/tui');
          const handoffs = listHandoffs();
          data.handoffs = mapHandoffListToViewModel(handoffs);
        } catch {
          // Handoff data unavailable
        }

        // Pre-fetch decision list data
        try {
          const { listDecisions } = await import('@openslack/collaboration');
          const { mapDecisionListToViewModel } = await import('@openslack/tui');
          const decisions = listDecisions();
          data.decisions = mapDecisionListToViewModel(decisions);
        } catch {
          // Decision data unavailable
        }

        // Pre-fetch approval data
        try {
          const { listPendingPlans } = await import('@openslack/operator');
          const { listHandoffs } = await import('@openslack/collaboration');
          const { RunStore } = await import('@openslack/workflows');

          const pendingPlans = listPendingPlans(root);
          const openHandoffs = listHandoffs().filter(h => h.status === 'open');

          // Pre-fetch paused workflow runs
          let pausedRuns: Array<{ runId: string; workflowName: string; startedAt: string }> = [];
          try {
            const store = new RunStore({ baseDir: join(root, '.openslack.local', 'workflows') });
            pausedRuns = await store.listRunsByStatus('paused_waiting_approval');
          } catch {
            // Run store may not be initialized
          }

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
            ...pausedRuns.map(run => ({
              id: run.runId,
              category: 'workflow-effect' as const,
              title: `Workflow "${run.workflowName}" paused — unexpected side effect`,
              detail: `Run ${run.runId} paused waiting for approval`,
              risk: 'medium' as const,
              requestedBy: 'workflow-runtime',
              requestedAt: run.startedAt,
              workflowName: run.workflowName,
              runId: run.runId,
            })),
            ...openHandoffs.map(h => ({
              id: h.id,
              category: 'workflow-effect' as const,
              title: `Handoff: ${h.context}`,
              detail: `From ${h.from} to ${h.to}${h.nextSteps.length ? ', next: ' + h.nextSteps.join(', ') : ''}`,
              risk: 'low' as const,
              requestedBy: h.from,
              requestedAt: h.createdAt,
            })),
          ];

          data.approvals = mapApprovalCenterToViewModel({ pendingApprovals });
        } catch {
          // Approval data unavailable
        }

        // Pre-fetch profile data
        try {
          const { mapProfileToViewModel } = await import('@openslack/tui');
          const { readEvents, filterEvents } = await import('@openslack/collaboration');
          const events = readEvents();
          const profileEvents = filterEvents(events, { type: 'profile_sync.completed' as never });
          const lastEvent = profileEvents.length > 0 ? profileEvents[profileEvents.length - 1] : null;

          // Try to load config and run a quick check
          let markerStatus: 'present' | 'missing' | 'unknown' = 'unknown';
          let validationSummary = { total: 0, published: 0, failed: 0 };
          let pendingPR: { number: number; url: string; branch: string } | undefined;
          let syncDetails: import('@openslack/tui').ProfileSyncDetails | undefined;
          let failureDetails: import('@openslack/tui').ProfileFailureDetails | undefined;
          let psMode: import('@openslack/tui').ProfileSyncMode = 'manual'; // conservative default if config load fails below
          let syncStatus: 'synced' | 'pending' | 'failed' | 'never' = 'never';

          try {
            const { loadProfileSyncConfig, checkProfileSync, listOpenPRs } = await import('@openslack/github');
            const psConfig = loadProfileSyncConfig(root);
            const checkResult = await checkProfileSync(psConfig);
            markerStatus = checkResult.target.markerExists ? 'present' : 'missing';
            validationSummary = checkResult.posts;
            psMode = psConfig.mode;

            // Derive sync status from check result
            if (!checkResult.ok && checkResult.errors.length > 0) {
              syncStatus = 'failed';
              failureDetails = {
                reason: checkResult.errors[0],
                nextAction: 'Run `openslack collaboration workflow profile-sync check` for details',
              };
            } else if (checkResult.ok) {
              syncStatus = lastEvent ? 'synced' : 'pending';
            } else {
              syncStatus = 'never';
            }

            // Build sync details from check result
            syncDetails = {
              sourceCommit: checkResult.source.sourceCommit,
              sourceDate: checkResult.source.sourceDate,
              targetHash: checkResult.target.markerExists ? 'present' : undefined,
              mode: psConfig.mode,
            };

            const openPRs = await listOpenPRs(20);
            const profileSyncPR = openPRs.find((p) =>
              p.title.includes('profile: sync latest') || p.title.includes('Profile Sync'),
            );
            if (profileSyncPR) {
              pendingPR = {
                number: profileSyncPR.number,
                url: profileSyncPR.url,
                branch: profileSyncPR.branch,
              };
              syncDetails.pendingPR = {
                number: profileSyncPR.number,
                status: 'open',
              };
            }

            // Last sync from event history
            if (lastEvent) {
              syncDetails.lastSync = {
                timestamp: new Date(lastEvent.timestamp).toISOString().slice(0, 10),
                result: (lastEvent.metadata?.result as string) === 'failed' ? 'failed' : 'success',
              };
            }
          } catch {
            // Check unavailable — use defaults
            syncStatus = lastEvent ? 'synced' : 'never';
          }

          data.profile = mapProfileToViewModel({
            targetRepo: lastEvent?.metadata?.targetRepo as string | undefined ?? 'Negentropy-Laby/.github',
            targetPath: lastEvent?.metadata?.targetPath as string | undefined ?? 'profile/README.md',
            marker: lastEvent?.metadata?.marker as string | undefined ?? 'latest-insights',
            syncStatus,
            lastSyncDate: lastEvent ? new Date(lastEvent.timestamp).toISOString().slice(0, 10) : undefined,
            lastPrUrl: lastEvent?.metadata?.prUrl as string | undefined,
            markerStatus,
            pendingPR,
            posts: (lastEvent?.metadata?.postsIncluded as Array<{ title: string; slug: string; date: string }> | undefined)?.map((p) => ({
              title: p.title,
              date: p.date,
              summary: '',
              sourcePath: p.slug + '.md',
              url: '',
            })) ?? [],
            validationSummary,
            syncDetails,
            failureDetails,
            mode: psMode,
          });
        } catch {
          // Profile data unavailable
        }

        // Resolve actor identity for TUI actions
        let actorId = 'tui-user';
        try {
          const { execSync } = await import('node:child_process');
          // Try git user name first, then OS user
          actorId = execSync('git config user.name', { encoding: 'utf-8', stdio: 'pipe' }).trim() || process.env.USER || process.env.USERNAME || 'tui-user';
        } catch {
          actorId = process.env.USER || process.env.USERNAME || 'tui-user';
        }

        // Inject action handlers (side-effect execution stays in CLI layer)
        try {
          const { createActionHandlers } = await import('./tui-executors.js');
          data.actionHandlers = createActionHandlers(root, actorId);
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

import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createWorktree,
  cleanupWorktree,
  checkDirty,
  proposeWorkspacePR,
  repairWorktrees,
  renderWorktreeRepair,
  resolveAgentPrincipal,
} from '@openslack/runtime';
import { recordEvent } from '@openslack/collaboration';

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

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function taskCommands(): Command {
  const cmd = new Command('task').description('Task management commands');

  cmd
    .command('create')
    .description('Preview or create a valid GitHub Issue task')
    .option(
      '--template <kind>',
      'Task template: bugfix, docs, test-fix, refactor, review, investigation',
      'investigation',
    )
    .requiredOption('--title <title>', 'Issue title')
    .option('--description <text>', 'Issue description')
    .option('--agent-type <type>', 'Required agent type', 'codex')
    .option('--priority <priority>', 'Priority p0|p1|p2|p3')
    .option('--risk <level>', 'Risk level low|medium|high|critical')
    .option('--path <glob>', 'Allowed path glob; can be repeated', collect, [])
    .option('--paths <globs>', 'Comma-separated allowed path globs')
    .option('--forbidden-path <glob>', 'Forbidden path glob; can be repeated', collect, [])
    .option('--capability <name>', 'Required capability; can be repeated', collect, [])
    .option('--capabilities <items>', 'Comma-separated required capabilities')
    .option('--success <item>', 'Success criterion; can be repeated', collect, [])
    .option(
      '--human-approval <items>',
      'Comma-separated human approval requirements, e.g. red_zone_change',
    )
    .option('--preview', 'Preview only; this is the default')
    .option('--create-issue', 'Create the GitHub Issue after validation')
    .action(
      async (options: {
        template: string;
        title: string;
        description?: string;
        agentType: string;
        priority?: string;
        risk?: string;
        path: string[];
        paths?: string;
        forbiddenPath: string[];
        capability: string[];
        capabilities?: string;
        success: string[];
        humanApproval?: string;
        createIssue?: boolean;
      }) => {
        const { previewTaskCreation, createTaskFromPreview } = await import('@openslack/github');
        const allowedPaths = [...options.path, ...(splitList(options.paths) ?? [])];
        const requiredCapabilities = [
          ...options.capability,
          ...(splitList(options.capabilities) ?? []),
        ];
        const preview = previewTaskCreation({
          template: options.template as never,
          title: options.title,
          description: options.description,
          agentType: options.agentType,
          priority: options.priority as never,
          riskLevel: options.risk as never,
          allowedPaths: allowedPaths.length > 0 ? allowedPaths : undefined,
          forbiddenPaths: options.forbiddenPath.length > 0 ? options.forbiddenPath : undefined,
          requiredCapabilities: requiredCapabilities.length > 0 ? requiredCapabilities : undefined,
          successCriteria: options.success.length > 0 ? options.success : undefined,
          humanApprovalRequiredFor: splitList(options.humanApproval) as never,
        });

        console.log('Task Issue Preview');
        console.log('==================');
        console.log(`Title: ${preview.issueTitle}`);
        console.log(`Risk zone: ${preview.riskZone}`);
        console.log(`Labels: ${preview.labels.join(', ')}`);
        console.log(`Agent matching: ${preview.agentMatchingHint}`);
        console.log('');
        console.log(preview.body);

        if (preview.errors.length > 0) {
          console.log('');
          console.log('Errors:');
          for (const error of preview.errors) console.log(`  - ${error}`);
          process.exit(1);
        }

        if (!options.createIssue) {
          console.log('');
          console.log('Preview only. Re-run with --create-issue to create the GitHub Issue.');
          return;
        }

        const result = await createTaskFromPreview(preview);
        if (!result.created) {
          console.error('Task issue was not created.');
          process.exit(1);
        }

        try {
          recordEvent({
            type: 'task.created',
            actor: { id: 'cli', kind: 'system', provider: 'cli' },
            object: { kind: 'issue', id: String(result.issueNumber ?? 0), url: result.url },
            source: { kind: 'github', ref: 'task.create' },
            summary: `Task issue created: ${result.issueTitle}`,
            visibility: 'local',
            redacted: false,
            containsSensitiveData: false,
            risk:
              result.riskZone === 'red' || result.riskZone === 'black'
                ? 'high'
                : result.riskZone === 'yellow'
                  ? 'medium'
                  : 'low',
          });
        } catch {
          // best-effort event recording
        }

        console.log('');
        console.log(`Created issue #${result.issueNumber}: ${result.url}`);
      },
    );

  cmd
    .command('checkout')
    .description('Create an isolated worktree for a task')
    .option('--task-id <id>', 'Task ID')
    .option('--issue-number <n>', 'GitHub issue number (auto-derives task-id and run-id)')
    .requiredOption('--agent-id <id>', 'Agent ID')
    .option('--run-id <id>', 'Run ID')
    .action((options) => {
      const taskId =
        options.taskId || (options.issueNumber ? `ISSUE-${options.issueNumber}` : undefined);
      const runId = options.runId || `RUN-${Date.now()}`;
      if (!taskId) {
        console.error('Either --task-id or --issue-number is required.');
        process.exit(1);
      }
      console.log(`Creating worktree for task ${taskId}...`);
      const result = createWorktree(taskId, options.agentId, runId);
      if (result.success) {
        console.log(`Worktree created: ${result.worktreePath}`);
        console.log(`Branch: ${result.branchName}`);
        console.log(`\nTo work in isolation: cd "${result.worktreePath}"`);
      } else {
        console.error('Failed to create worktree:');
        for (const err of result.errors) console.error(`  - ${err}`);
        process.exit(1);
      }
    });

  cmd
    .command('cleanup')
    .description('Remove a task worktree')
    .requiredOption('--run-id <id>', 'Run ID of the worktree to clean up')
    .action((options) => {
      console.log(`Cleaning up worktree for run ${options.runId}...`);
      const ok = cleanupWorktree(options.runId);
      if (ok) {
        console.log('Worktree removed successfully.');
      } else {
        console.error('Failed to remove worktree. Manual cleanup may be needed.');
        console.error(`  rm -rf .worktrees/${options.runId}`);
        console.error('  git worktree prune');
        process.exit(1);
      }
    });

  cmd
    .command('status')
    .description('Check if worktree has uncommitted changes')
    .requiredOption('--worktree <path>', 'Path to worktree')
    .action((options) => {
      const dirty = checkDirty(options.worktree);
      if (dirty.status === 'error') {
        console.log(`ERROR: ${dirty.reason}`);
        process.exit(1);
      } else if (dirty.status === 'dirty') {
        console.log(`DIRTY: ${dirty.reason}`);
      } else {
        console.log('CLEAN: No uncommitted changes.');
      }
    });

  cmd
    .command('sync')
    .description('Propose a workspace PR from local changes')
    .requiredOption('--agent-id <id>', 'Agent ID')
    .requiredOption('--task-id <id>', 'Task ID')
    .requiredOption('--run-id <id>', 'Run ID')
    .requiredOption('--paths <paths>', 'Comma-separated changed paths')
    .option('--description <text>', 'PR description')
    .option('--issue-number <n>', 'GitHub issue number to link')
    .action(async (options) => {
      const root = findRepoRoot();
      const paths = options.paths.split(',').map((p: string) => p.trim());

      // Resolve agent principal — fail closed
      const resolved = resolveAgentPrincipal({ root, agentId: options.agentId, provider: 'cli' });
      if ('error' in resolved) {
        console.error(`Authorization failed: ${resolved.error}`);
        process.exit(1);
      }
      const { principal, snapshot } = resolved;

      const result = await proposeWorkspacePR({
        agentId: options.agentId,
        taskId: options.taskId,
        runId: options.runId,
        changedPaths: paths,
        description: options.description,
        principal,
        snapshot,
        rootDir: root,
      });
      if (!result.success) {
        console.error('PR proposal failed:');
        for (const err of result.errors) console.error(`  - ${err}`);
        process.exit(1);
      }
      console.log(`Branch: ${result.branchName}`);
      console.log(`Risk zone: ${result.riskZone.toUpperCase()}`);
      if (result.prUrl) {
        console.log(`PR URL: ${result.prUrl}`);
        // Move linked issue to review
        if (options.issueNumber) {
          try {
            const { moveIssueToReview } = await import('@openslack/github');
            await moveIssueToReview(parseInt(options.issueNumber, 10), result.prUrl);
            console.log(`Issue #${options.issueNumber} → review`);
          } catch {
            /* best-effort */
          }
        }
      }
      console.log(result.prBody);
    });

  const repair = new Command('repair').description('Preview or apply local task repairs');

  repair
    .command('worktrees')
    .description('Preview or remove orphaned local task worktree directories')
    .option('--apply', 'Apply repair; default is dry-run')
    .action((options: { apply?: boolean }) => {
      const result = repairWorktrees({ dryRun: !options.apply });
      console.log(renderWorktreeRepair(result));
      if (options.apply && result.items.length > 0) {
        try {
          recordEvent({
            type: 'repair.applied',
            actor: { id: 'cli', kind: 'system', provider: 'cli' },
            object: { kind: 'workspace', id: 'worktrees' },
            source: { kind: 'openslack', ref: 'task.repair.worktrees' },
            summary: `Repaired ${result.items.length} orphaned task worktree(s)`,
            visibility: 'local',
            redacted: false,
            containsSensitiveData: false,
            risk: 'low',
          });
        } catch {
          // best-effort event recording
        }
      }
    });

  cmd.addCommand(repair);

  return cmd;
}

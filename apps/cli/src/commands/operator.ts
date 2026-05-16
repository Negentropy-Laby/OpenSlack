import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

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

interface Intent {
  command: string;
  args: string[];
  description: string;
}

function routeIntent(query: string): Intent {
  const q = query.toLowerCase();

  // Diagnostics
  if (q.includes('check') && (q.includes('status') || q.includes('health') || q.includes('doctor')))
    return { command: 'github', args: ['doctor'], description: 'System health check' };
  if (q.includes('status') && (q.includes('workspace') || q.includes('overview') || q.includes('index')))
    return { command: 'workspace', args: ['status'], description: 'Workspace status' };
  if (q.includes('workspace') && q.includes('validate'))
    return { command: 'workspace', args: ['validate'], description: 'Workspace validation' };
  if (q.includes('metrics') || q.includes('stats') || q.includes('count'))
    return { command: 'github', args: ['metrics'], description: 'Task loop metrics' };
  if (q.includes('digest') || q.includes('summary') || q.includes('report') || q.includes('today'))
    return { command: 'github', args: ['metrics'], description: 'Task loop metrics' };

  // Task creation
  if (q.includes('create') && (q.includes('task') || q.includes('issue')))
    return { command: 'self', args: ['triage', '--create-issues'], description: 'Observe and create EVOL tasks via GitHub Issues' };

  // Agent operations
  const defaultAgentId = 'anthropic_architect_aby'; // fallback: user should override via --agent-id or query text
  if (q.includes('claim') || q.includes('tick') || q.includes('pick up') || q.includes('get task'))
    return { command: 'agent', args: ['tick', '--source', 'github-issues', '--agent-id', defaultAgentId], description: 'Agent tick via GitHub Issues (use your own --agent-id)' };
  if (q.includes('hire'))
    return { command: 'agent', args: ['hire', '--agent-id', 'codex_developer'], description: 'Hire new agent (default: codex_developer)' };
  if (q.includes('bootstrap'))
    return { command: 'agent', args: ['bootstrap', '--agent-id', defaultAgentId], description: 'Verify agent readiness (use your own --agent-id)' };

  // Worktree + PR
  if (q.includes('checkout') || q.includes('worktree') || q.includes('work on')) {
    const numMatch = q.match(/#?(\d+)/);
    const issueNum = numMatch ? numMatch[1] : '1';
    return { command: 'task', args: ['checkout', '--task-id', `ISSUE-${issueNum}`, '--agent-id', defaultAgentId, '--run-id', `RUN-${Date.now()}`], description: `Create worktree for issue #${issueNum} (override -a/--agent-id as needed)` };
  }
  if (q.includes('sync') || q.includes('submit') || q.includes('pr') || q.includes('pull request')) {
    const numMatch = q.match(/#?(\d+)/);
    const issueNum = numMatch ? numMatch[1] : '1';
    return { command: 'task', args: ['sync', '--agent-id', defaultAgentId, '--task-id', `ISSUE-${issueNum}`, '--run-id', `RUN-${Date.now()}`, '--paths', 'docs/test.md', '--issue-number', issueNum], description: `Propose workspace PR for issue #${issueNum}` };
  }

  // Eval
  if (q.includes('eval') || q.includes('evaluate') || q.includes('test') || q.includes('golden'))
    return { command: 'self', args: ['eval', '--suite', 'golden'], description: 'Run golden evals' };

  // Review + Scorecard
  if (q.includes('review') || q.includes('approve'))
    return { command: 'self', args: ['review', '--pr', '1', '--implementer', 'agent-a', '--reviewer', 'agent-b'], description: 'Review PR' };
  if (q.includes('scorecard') || q.includes('fitness'))
    return { command: 'self', args: ['scorecard', '--experiment', 'EXP-001'], description: 'Compute fitness score' };

  // Repair
  if (q.includes('repair') && (q.includes('label') || q.includes('labels')))
    return { command: 'github', args: ['repair-labels'], description: 'Repair missing labels' };
  if (q.includes('repair') && (q.includes('claim') || q.includes('claims') || q.includes('stale')))
    return { command: 'github', args: ['repair-claims'], description: 'Repair expired claims' };
  if (q.includes('repair all') || q.includes('fix all') || q.includes('repair-all'))
    return { command: 'github', args: ['repair-all'], description: 'Repair labels + claims' };

  // Issue lifecycle
  if (q.includes('issue') && (q.includes('done') || q.includes('complete') || q.includes('finish'))) {
    const numMatch = q.match(/#?(\d+)/);
    const issueNum = numMatch ? numMatch[1] : '1';
    return { command: 'github', args: ['issue-done', '--issue-number', issueNum], description: `Mark issue #${issueNum} as done` };
  }
  if (q.includes('block') || q.includes('stuck')) {
    const numMatch = q.match(/#?(\d+)/);
    const issueNum = numMatch ? numMatch[1] : '1';
    return { command: 'self', args: ['observe'], description: `Block issue #${issueNum} — mark as blocked on GitHub` };
  }

  // PR classification
  if (q.includes('classify') || q.includes('risk') || q.includes('zone'))
    return { command: 'self', args: ['classify-pr', '--paths', 'docs/test.md'], description: 'Classify PR risk zone' };
  if (q.includes('validate') && q.includes('pr'))
    return { command: 'self', args: ['validate', '--pr', '1', '--paths', 'docs/test.md'], description: 'Validate PR' };

  // Index
  if (q.includes('index'))
    return { command: 'workspace', args: ['index'], description: 'Build workspace index' };

  // Rollback
  if (q.includes('rollback') || q.includes('revert'))
    return { command: 'self', args: ['monitor', '--experiment', 'EXP-001'], description: 'Check for regression' };

  // Observe
  if (q.includes('observe') || q.includes('monitor health'))
    return { command: 'self', args: ['observe'], description: 'Health observation' };

  // Catch-all: ask for clarification instead of silent wrong action
  return { command: '_unknown', args: [], description: `I don't understand "${q}". Try: check status, create task, claim a task, eval, repair labels, metrics.` };
}

export function operatorCommands(): Command {
  const cmd = new Command('operator').description('OpenSlack Operator Agent');

  cmd
    .command('ask')
    .description('Ask the Operator Agent to perform a task (natural language)')
    .argument('<query...>', 'What do you want to do?')
    .action(async (queryParts: string[]) => {
      const query = queryParts.join(' ');
      const intent = routeIntent(query);
      const root = findRepoRoot();

      console.log(`\nOperator: "${query}"`);
      console.log(`→ ${intent.description}`);

      // Unknown intent: just print the help message, don't execute
      if (intent.command === '_unknown') {
        console.log('');
        return;
      }

      console.log(`→ openslack ${intent.command} ${intent.args.join(' ')}`);
      console.log('');

      const result = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'apps', 'cli', 'src', 'index.ts'), intent.command, ...intent.args], { cwd: root, stdio: 'inherit' });
      if (result.error) console.error('\nOperator: failed to execute:', result.error.message);
      else if (result.status !== 0) console.log('\nOperator: command exited non-zero (may be expected — e.g. doctor fails on missing config).');
      else console.log('\nOperator: complete.');
    });

  return cmd;
}

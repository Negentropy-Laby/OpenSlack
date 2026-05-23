import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

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

function isHighRisk(intent: Intent): boolean {
  if (intent.command === 'pr' && intent.args[0] === 'merge') return true;
  if (intent.command === 'task' && intent.args[0] === 'sync') return true;
  if (intent.command === 'github' && intent.args[0] === 'issue-done') return true;
  if (intent.command === 'github' && intent.args[0] === 'repair-all') return true;
  if (intent.command === 'self' && intent.args[0] === 'monitor') return true;
  return false;
}

function confirmPrompt(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

function routeIntent(query: string): Intent {
  const q = query.toLowerCase();

  // Diagnostics
  if ((q.includes('check') || q.includes('检查') || q.includes('诊断')) && (q.includes('status') || q.includes('health') || q.includes('doctor') || q.includes('状态')))
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
  if (q.includes('claim') || q.includes('tick') || q.includes('pick up') || q.includes('get task'))
    return { command: 'agent', args: ['tick', '--source', 'github-issues'], description: 'Agent tick via GitHub Issues (specify --agent-id with your agent)' };
  if (q.includes('hire'))
    return { command: '_unknown', args: [], description: 'Please specify agent name: openslack agent hire --agent-id <id> --department <dept> --role <role>' };
  if (q.includes('bootstrap'))
    return { command: '_unknown', args: [], description: 'Please specify agent ID: openslack agent bootstrap --agent-id <id>' };

  // PRMS — natural language PR management (must come before generic 'pr' task routing)
  const prMatch = q.match(/pr\s*#?(\d+)|pull\s*request\s*#?(\d+)/);
  const prNumber = prMatch ? (prMatch[1] || prMatch[2]) : null;

  if (prNumber) {
    // Check if user wants to merge
    if (q.includes('merge') || q.includes('合')) {
      return { command: 'pr', args: ['merge', prNumber], description: `Merge PR #${prNumber} after governance gates` };
    }
    // Check if user wants diagnosis
    if (q.includes('why') || q.includes('不能') || q.includes('block') || q.includes('doctor') || q.includes('诊断') || q.includes(' diagnose')) {
      return { command: 'pr', args: ['doctor', prNumber], description: `Diagnose PR #${prNumber} governance` };
    }
    // Check if user wants review/report
    if (q.includes('review') || q.includes('审查') || q.includes('report') || q.includes('报告')) {
      return { command: 'pr', args: ['review', prNumber], description: `Review PR #${prNumber}` };
    }
    // Default: status
    if (q.includes('status') || q.includes('check') || q.includes('检查') || q.includes('状态')) {
      return { command: 'pr', args: ['status', prNumber], description: `Status of PR #${prNumber}` };
    }
    // Ambiguous PR query — default to doctor (most informative)
    return { command: 'pr', args: ['doctor', prNumber], description: `Diagnose PR #${prNumber}` };
  }

  // Worktree + PR — require explicit issue number
  if (q.includes('checkout') || q.includes('worktree') || q.includes('work on')) {
    const numMatch = q.match(/#?(\d+)/);
    if (!numMatch) return { command: '_unknown', args: [], description: 'I need an issue number.\nExample: openslack ask "checkout issue #12"' };
    const agentMatch = query.match(/--agent-id\s+(\S+)/) || query.match(/agent[:\s]+(\w+)/i) || query.match(/for\s+(\w+)$/i);
    if (!agentMatch) return { command: '_unknown', args: [], description: 'I need an agent ID.\nExample: openslack ask "checkout issue #12 for agent anthropic_architect_aby"' };
    return { command: 'task', args: ['checkout', '--issue-number', numMatch[1], '--agent-id', agentMatch[1]], description: `Create worktree for issue #${numMatch[1]}` };
  }
  if (q.includes('sync') || q.includes('submit')) {
    const numMatch = q.match(/#?(\d+)/);
    if (!numMatch) return { command: '_unknown', args: [], description: 'I need an issue number.\nExample: openslack ask "sync issue #12"' };
    const agentMatch = query.match(/--agent-id\s+(\S+)/) || query.match(/agent[:\s]+(\w+)/i) || query.match(/for\s+(\w+)$/i);
    if (!agentMatch) return { command: '_unknown', args: [], description: 'I need an agent ID.\nExample: openslack ask "sync issue #12 for agent anthropic_architect_aby"' };
    const pathsMatch = query.match(/--paths\s+"([^"]+)"/);
    if (!pathsMatch) return { command: '_unknown', args: [], description: 'I need paths to sync.\nExample: openslack ask "sync issue #12 --paths \\"packages/foo/src/**\\""' };
    return { command: 'task', args: ['sync', '--issue-number', numMatch[1], '--agent-id', agentMatch[1], '--task-id', `ISSUE-${numMatch[1]}`, '--run-id', `RUN-${Date.now()}`, '--paths', pathsMatch[1]], description: `Propose workspace PR for issue #${numMatch[1]}` };
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
    if (!numMatch) return { command: '_unknown', args: [], description: 'I need an issue number.\nExample: openslack ask "mark issue #12 done"' };
    return { command: 'github', args: ['issue-done', '--issue-number', numMatch[1]], description: `Mark issue #${numMatch[1]} as done` };
  }
  if (q.includes('block') || q.includes('stuck')) {
    const numMatch = q.match(/#?(\d+)/);
    if (!numMatch) return { command: '_unknown', args: [], description: 'I need an issue number.\nExample: openslack ask "block issue #12"' };
    return { command: 'self', args: ['observe'], description: `Block issue #${numMatch[1]} — mark as blocked on GitHub` };
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
    .option('--plan', 'Show the execution plan without running it')
    .action(async (queryParts: string[], options: { plan?: boolean }) => {
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

      const fullCommand = `openslack ${intent.command} ${intent.args.join(' ')}`;
      console.log(`→ ${fullCommand}`);

      if (options.plan) {
        console.log('\nPlan mode: no changes will be made.');
        console.log('Run without --plan to execute.');
        console.log('');
        return;
      }

      if (isHighRisk(intent)) {
        const confirmed = await confirmPrompt(`This action is high-risk: ${intent.description}. Proceed?`);
        if (!confirmed) {
          console.log('Cancelled by user.');
          console.log('');
          return;
        }
      }

      console.log('');

      const result = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'apps', 'cli', 'src', 'index.ts'), intent.command, ...intent.args], { cwd: root, stdio: 'inherit' });

      // Execution summary
      console.log('\nOperator Summary');
      console.log('────────────────');
      console.log(`Request:  "${query}"`);
      console.log(`Command:  ${fullCommand}`);
      if (result.error) {
        console.log(`Status:   Failed to execute`);
        console.error(`Error:    ${result.error.message}`);
      } else if (result.status !== 0) {
        console.log(`Status:   Blocked / Non-zero exit`);
      } else {
        console.log(`Status:   Success`);
      }
      console.log('');
    });

  return cmd;
}

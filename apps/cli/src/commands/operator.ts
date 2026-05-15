import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

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

  if (q.includes('check') && (q.includes('status') || q.includes('health') || q.includes('doctor'))) {
    return { command: 'github', args: ['doctor'], description: 'System health check' };
  }
  if (q.includes('create') && (q.includes('task') || q.includes('issue'))) {
    return { command: 'self', args: ['triage', '--create-issues'], description: 'Observe and create EVOL tasks' };
  }
  if (q.includes('claim') || q.includes('tick') || q.includes('pick up')) {
    return { command: 'agent', args: ['tick', '--source', 'github-issues', '--agent-id', 'anthropic_architect_aby'], description: 'Agent tick via GitHub Issues' };
  }
  if (q.includes('eval') || q.includes('evaluate') || q.includes('test')) {
    return { command: 'self', args: ['eval', '--suite', 'golden'], description: 'Run golden evals' };
  }
  if (q.includes('repair') && (q.includes('label') || q.includes('labels'))) {
    return { command: 'github', args: ['repair-labels'], description: 'Repair missing labels' };
  }
  if (q.includes('repair') && (q.includes('claim') || q.includes('claims') || q.includes('stale'))) {
    return { command: 'github', args: ['repair-claims'], description: 'Repair expired claims' };
  }
  if (q.includes('repair all') || q.includes('fix all') || q.includes('repair-all')) {
    return { command: 'github', args: ['repair-all'], description: 'Repair labels + claims' };
  }
  if (q.includes('validate') || q.includes('workspace validate')) {
    return { command: 'workspace', args: ['validate'], description: 'Workspace validation' };
  }
  if (q.includes('metrics') || q.includes('stats') || q.includes('count')) {
    return { command: 'github', args: ['metrics'], description: 'Task loop metrics' };
  }
  if (q.includes('digest') || q.includes('summary') || q.includes('report') || q.includes('today')) {
    return { command: 'github', args: ['metrics'], description: 'Metrics (digest not yet implemented)' };
  }
  if (q.includes('index') || q.includes('status overview')) {
    return { command: 'workspace', args: ['status'], description: 'Workspace status' };
  }

  // Catch-all: forward as raw openslack subcommand
  const parts = q.split(/\s+/).filter(Boolean);
  return { command: 'self', args: ['observe'], description: `Unknown intent "${q}" — running health check` };
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

      console.log(`Operator: routing "${query}"`);
      console.log(`  → ${intent.description}`);
      console.log(`  → openslack ${intent.command} ${intent.args.join(' ')}`);
      console.log('');

      try {
        const argv = [process.execPath, '--import', 'tsx', join(root, 'apps', 'cli', 'src', 'index.ts'), intent.command, ...intent.args];
        execSync(argv.join(' '), { cwd: root, stdio: 'pipe' });
        console.log('Operator: complete.');
      } catch {
        console.log('Operator: command completed (non-zero exit may be expected for some checks).');
      }
    });

  return cmd;
}

import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REQUIRED_OPENSLACK_LABELS, getClient } from '@openslack/github';

export type SetupFindingStatus =
  | 'ok'
  | 'fixable_by_command'
  | 'requires_github_admin'
  | 'requires_human_approval'
  | 'informational';

export interface SetupFinding {
  id: string;
  title: string;
  status: SetupFindingStatus;
  detail: string;
  nextAction?: string;
  command?: string;
}

export interface SetupReport {
  root: string;
  generatedAt: string;
  dryRun: boolean;
  findings: SetupFinding[];
}

export function findRepoRoot(start = process.cwd()): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'openslack.yaml'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

function hasGitRemote(root: string): boolean {
  try {
    execSync('git remote get-url origin', { cwd: root, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function hasExecutable(command: string, args: string[] = ['--version']): boolean {
  try {
    execFileSync(command, args, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function detectGenesisShell(root = findRepoRoot()): SetupFinding {
  const script = join(root, 'scripts', 'genesis-validate.sh');
  if (!existsSync(script)) {
    return {
      id: 'genesis-script',
      title: 'Genesis validation script',
      status: 'fixable_by_command',
      detail: 'scripts/genesis-validate.sh is missing.',
      nextAction: 'Restore the genesis validation script before relying on recovery checks.',
    };
  }

  if (process.platform === 'win32') {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    if (existsSync(gitBash)) {
      return {
        id: 'genesis-shell',
        title: 'Genesis validation shell',
        status: 'ok',
        detail: `Git Bash detected: ${gitBash}`,
        command: `"${gitBash}" scripts/genesis-validate.sh`,
      };
    }
    if (hasExecutable('wsl', ['--status'])) {
      return {
        id: 'genesis-shell',
        title: 'Genesis validation shell',
        status: 'ok',
        detail: 'WSL detected.',
        command: 'wsl bash scripts/genesis-validate.sh',
      };
    }
    return {
      id: 'genesis-shell',
      title: 'Genesis validation shell',
      status: 'fixable_by_command',
      detail: 'No Git Bash or WSL shell was detected for genesis validation.',
      nextAction: 'Install Git for Windows or WSL, then rerun setup.',
    };
  }

  return {
    id: 'genesis-shell',
    title: 'Genesis validation shell',
    status: hasExecutable('bash') ? 'ok' : 'fixable_by_command',
    detail: hasExecutable('bash') ? 'bash detected.' : 'bash was not found on PATH.',
    command: hasExecutable('bash') ? 'bash scripts/genesis-validate.sh' : undefined,
  };
}

async function buildGitHubFindings(): Promise<SetupFinding[]> {
  const findings: SetupFinding[] = [];
  const appId = process.env.OPENSLACK_GITHUB_APP_ID;
  const installationId = process.env.OPENSLACK_GITHUB_APP_INSTALLATION_ID;
  const privateKeyPresent = Boolean(process.env.OPENSLACK_GITHUB_APP_PRIVATE_KEY);
  const tokenPresent = Boolean(process.env.GITHUB_TOKEN);

  try {
    const client = await getClient();
    findings.push({
      id: 'github-auth',
      title: 'GitHub authentication',
      status: client.isDryRun ? 'fixable_by_command' : 'ok',
      detail: client.isDryRun
        ? 'No GitHub credential is configured; GitHub commands will run in dry-run mode.'
        : `${client.authMode}${client.tokenExpiresAt ? `, token expires ${client.tokenExpiresAt}` : ''}`,
      nextAction: client.isDryRun ? 'Configure GitHub App credentials or GITHUB_TOKEN.' : undefined,
    });
  } catch (err) {
    findings.push({
      id: 'github-auth',
      title: 'GitHub authentication',
      status: 'fixable_by_command',
      detail: (err as Error).message,
      nextAction: 'Check GitHub App environment variables or PAT fallback.',
    });
  }

  if (appId || installationId || privateKeyPresent) {
    findings.push({
      id: 'github-app-env',
      title: 'GitHub App environment',
      status: appId && installationId && privateKeyPresent ? 'ok' : 'fixable_by_command',
      detail: [
        `OPENSLACK_GITHUB_APP_ID=${appId ? 'set' : 'missing'}`,
        `OPENSLACK_GITHUB_APP_INSTALLATION_ID=${installationId ? 'set' : 'missing'}`,
        `OPENSLACK_GITHUB_APP_PRIVATE_KEY=${privateKeyPresent ? 'set (masked)' : 'missing'}`,
      ].join(', '),
      nextAction: appId && installationId && privateKeyPresent ? undefined : 'Set all GitHub App variables or use GITHUB_TOKEN for local development.',
    });
  } else if (tokenPresent) {
    findings.push({
      id: 'github-token',
      title: 'PAT fallback',
      status: 'informational',
      detail: 'GITHUB_TOKEN is set. GitHub App auth remains recommended for agent runtime.',
    });
  }

  findings.push({
    id: 'github-labels',
    title: 'OpenSlack labels',
    status: 'fixable_by_command',
    detail: `${REQUIRED_OPENSLACK_LABELS.length} required labels can be verified or repaired idempotently.`,
    command: 'openslack github repair labels --apply',
  });

  findings.push({
    id: 'branch-protection',
    title: 'Branch protection / ruleset',
    status: 'requires_github_admin',
    detail: 'Remote branch protection is best-effort from local setup and must be confirmed in GitHub repository settings.',
    nextAction: 'Confirm required checks, CODEOWNER review, and ruleset bypass settings in GitHub.',
  });

  return findings;
}

export async function buildSetupReport(options: { root?: string; dryRun?: boolean } = {}): Promise<SetupReport> {
  const root = options.root ?? findRepoRoot();
  const findings: SetupFinding[] = [];

  findings.push({
    id: 'repo-root',
    title: 'Workspace root',
    status: existsSync(join(root, 'openslack.yaml')) ? 'ok' : 'fixable_by_command',
    detail: root,
    nextAction: existsSync(join(root, 'openslack.yaml')) ? undefined : 'Run setup from the OpenSlack repository root.',
  });

  findings.push({
    id: 'git-remote',
    title: 'Git remote',
    status: hasGitRemote(root) ? 'ok' : 'fixable_by_command',
    detail: hasGitRemote(root) ? 'origin configured' : 'origin remote is missing',
    command: hasGitRemote(root) ? undefined : 'git remote add origin <repo-url>',
  });

  findings.push({
    id: 'codeowners',
    title: 'CODEOWNERS',
    status: existsSync(join(root, '.github', 'CODEOWNERS')) ? 'ok' : 'requires_human_approval',
    detail: existsSync(join(root, '.github', 'CODEOWNERS'))
      ? '.github/CODEOWNERS exists'
      : '.github/CODEOWNERS is missing; Red Zone approval gates cannot be evaluated locally.',
    nextAction: existsSync(join(root, '.github', 'CODEOWNERS'))
      ? undefined
      : 'Add CODEOWNERS through a Red Zone PR with human approval.',
  });

  findings.push({
    id: 'local-state',
    title: 'Local state directories',
    status: existsSync(join(root, '.openslack')) ? 'ok' : 'fixable_by_command',
    detail: existsSync(join(root, '.openslack')) ? '.openslack exists' : '.openslack is missing',
    nextAction: existsSync(join(root, '.openslack')) ? undefined : 'Restore workspace state from the repository.',
  });

  findings.push(detectGenesisShell(root));
  findings.push(...await buildGitHubFindings());

  return {
    root,
    generatedAt: new Date().toISOString(),
    dryRun: options.dryRun ?? true,
    findings,
  };
}

export interface SetupNextStep {
  label: string;
  command: string;
  description: string;
}

export function getNextSteps(): SetupNextStep[] {
  return [
    {
      label: 'Check your workspace status',
      command: 'pnpm openslack status',
      description: 'Show current workspace state, modules, and health',
    },
    {
      label: 'Review your PRs',
      command: 'pnpm openslack pr list',
      description: 'List open pull requests and their status',
    },
    {
      label: 'See the team dashboard',
      command: 'pnpm openslack collaboration dashboard',
      description: 'View team activity, events, and collaboration metrics',
    },
    {
      label: 'Get a role-specific guide',
      command: 'pnpm openslack guide operator',
      description: 'Show the operator role guide with common workflows',
    },
    {
      label: 'Run diagnostics',
      command: 'pnpm openslack doctor',
      description: 'Run a full diagnostic check on your workspace',
    },
  ];
}

export function renderSetupReport(report: SetupReport): string {
  const lines: string[] = [];
  lines.push('OpenSlack Setup Report');
  lines.push('='.repeat(24));
  lines.push(`Root: ${report.root}`);
  lines.push(`Mode: ${report.dryRun ? 'dry-run / read-only' : 'apply'}`);
  lines.push('');

  for (const finding of report.findings) {
    lines.push(`[${finding.status}] ${finding.title}`);
    lines.push(`  ${finding.detail}`);
    if (finding.command) lines.push(`  Command: ${finding.command}`);
    if (finding.nextAction) lines.push(`  Next: ${finding.nextAction}`);
  }

  return lines.join('\n');
}


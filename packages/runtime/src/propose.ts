import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyPaths } from '@openslack/kernel';
import { authorizeAgentAction } from '@openslack/kernel';
import type { AgentPrincipal, AgentPermissionSnapshot, RiskZone } from '@openslack/kernel';
import { assessPRAuthorRisk, parseCODEOWNERS, resolveCodeowners } from '@openslack/pr';
import type { PRAuthorRiskPreflight } from '@openslack/pr';
import { DeliveryError, GitHubDeliveryService } from '@openslack/delivery';
import type { GitHubDeliveryInput, GitHubDeliveryResult } from '@openslack/delivery';

export interface PRProposalInput {
  agentId: string;
  taskId: string;
  runId: string;
  issueNumber?: number;
  changedPaths: string[];
  description?: string;
  principal?: AgentPrincipal;
  snapshot?: AgentPermissionSnapshot;
  rootDir?: string;
  baseBranch?: string;
  remote?: string;
  deliveryService?: { publish(input: GitHubDeliveryInput): Promise<GitHubDeliveryResult> };
}

export interface PRProposalResult {
  success: boolean;
  prBody: string;
  branchName: string;
  riskZone: string;
  errors: string[];
  prUrl?: string;
  authorRisk?: PRAuthorRiskPreflight;
  delivery?: GitHubDeliveryResult;
}

export interface TaskLinkMetadata {
  schema: 'openslack.task_link.v1';
  issue_number: number;
  agent_id: string;
  task_id: string;
  run_id: string;
  claim_ref: string;
}

const TASK_LINK_AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function renderTaskLinkMetadata(metadata: TaskLinkMetadata): string {
  return `<!-- openslack-task-link\n${JSON.stringify(metadata, null, 2)}\n-->`;
}

export function parseTaskLinkMetadata(body: string | null | undefined): TaskLinkMetadata | null {
  if (!body) return null;
  const match = body.match(/<!--\s*openslack-task-link\s*([\s\S]*?)-->/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim()) as Partial<TaskLinkMetadata>;
    if (
      parsed.schema !== 'openslack.task_link.v1' ||
      !Number.isSafeInteger(parsed.issue_number) ||
      (parsed.issue_number ?? 0) <= 0 ||
      typeof parsed.agent_id !== 'string' ||
      !TASK_LINK_AGENT_ID_PATTERN.test(parsed.agent_id) ||
      typeof parsed.task_id !== 'string' ||
      parsed.task_id.length === 0 ||
      typeof parsed.run_id !== 'string' ||
      parsed.run_id.length === 0 ||
      parsed.claim_ref !== `refs/heads/openslack/claims/issue-${parsed.issue_number}`
    ) {
      return null;
    }
    return parsed as TaskLinkMetadata;
  } catch {
    return null;
  }
}

function loadLocalCodeowners(root: string, changedPaths: string[]): string[] {
  const codeownersPath = join(root, '.github', 'CODEOWNERS');
  if (!existsSync(codeownersPath)) return [];
  const entries = parseCODEOWNERS(readFileSync(codeownersPath, 'utf-8'));
  return resolveCodeowners(changedPaths, entries);
}

export async function proposeWorkspacePR(input: PRProposalInput): Promise<PRProposalResult> {
  const errors: string[] = [];

  if (input.changedPaths.length === 0) {
    errors.push('No changed paths provided');
    return { success: false, prBody: '', branchName: '', riskZone: 'unknown', errors };
  }
  if (input.baseBranch !== undefined && input.baseBranch !== 'main') {
    errors.push(
      `DELIVERY_BASE_FORBIDDEN: pull requests must target "main"; received "${input.baseBranch}".`,
    );
    return { success: false, prBody: '', branchName: '', riskZone: 'unknown', errors };
  }
  if (
    input.issueNumber !== undefined &&
    (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0)
  ) {
    errors.push('Issue number must be a positive integer');
    return { success: false, prBody: '', branchName: '', riskZone: 'unknown', errors };
  }

  const riskZone = classifyPaths(input.changedPaths);
  const blackViolations = input.changedPaths.filter((p) => classifyPaths([p]) === 'black');
  const redViolations = input.changedPaths.filter((p) => classifyPaths([p]) === 'red');
  const branchName = `agent/${input.agentId}/${input.taskId}/${input.runId}`;
  const taskLink = input.issueNumber
    ? renderTaskLinkMetadata({
        schema: 'openslack.task_link.v1',
        issue_number: input.issueNumber,
        agent_id: input.agentId,
        task_id: input.taskId,
        run_id: input.runId,
        claim_ref: `refs/heads/openslack/claims/issue-${input.issueNumber}`,
      })
    : '';

  // Authorization gate — if snapshot provided, enforce
  if (input.snapshot) {
    const auth = authorizeAgentAction({
      snapshot: input.snapshot,
      action: 'pr.propose',
      changedPaths: input.changedPaths,
      riskZone: riskZone as RiskZone,
    });
    if (auth.decision !== 'allow') {
      const prefix =
        auth.decision === 'ask' ? 'Authorization requires confirmation' : 'Authorization denied';
      return {
        success: false,
        prBody: '',
        branchName: '',
        riskZone,
        errors: [`${prefix}: ${auth.evidence.reason}`],
      };
    }
  }
  const prBody = `## OpenSlack Self-Evolution PR

### Task Information
- **Task ID:** ${input.taskId}
- **Agent ID:** ${input.agentId}
- **Run ID:** ${input.runId}
${input.issueNumber ? `- **Issue:** #${input.issueNumber}` : ''}

${taskLink}

### Risk
- **Zone:** ${riskZone.toUpperCase()}
${redViolations.length > 0 ? `- **⚠ Red Zone paths touched:**\n${redViolations.map((p) => `  - ${p}`).join('\n')}\n` : ''}
${blackViolations.length > 0 ? `- **❌ Black Zone paths touched:**\n${blackViolations.map((p) => `  - ${p}`).join('\n')}\n` : ''}

### Changed Paths
${input.changedPaths.map((p) => `- ${p}`).join('\n')}

### Description
${input.description || 'No description provided.'}

${
  input.principal
    ? `### Principal
- **Registry ID:** ${input.principal.registry_id}
- **Run ID:** ${input.principal.run_id}
- **Provider:** ${input.principal.provider}
`
    : ''
}
### Validation
- [ ] \`openslack workspace validate\`
- [ ] \`bun run typecheck\`
- [ ] \`bun run test\`
- [ ] \`openslack self eval --suite golden\`

### Rollback
To revert this change:
1. Run \`bash scripts/genesis-rollback.sh\`
2. Or manually: \`git revert <commit-sha>\`

### Approval
${riskZone === 'red' ? '- [ ] **Human approval required** (Red Zone files modified)' : ''}
- [ ] Independent agent review
`;

  if (blackViolations.length > 0) {
    return {
      success: false,
      prBody,
      branchName,
      riskZone,
      errors: ['PR cannot be proposed: Black Zone files modified'],
    };
  }

  // Stage and commit locally, then delegate every publication side effect to
  // the installation-scoped delivery service.
  let prUrl: string | undefined;
  let authorRisk: PRAuthorRiskPreflight | undefined;
  let delivery: GitHubDeliveryResult | undefined;
  try {
    const root = input.rootDir ?? process.cwd();
    const commitMsg = `runtime: deliver ${input.taskId} workspace changes`;
    const preStaged = listGitPaths(root, ['diff', '--cached', '--name-only']);
    if (preStaged.length > 0) {
      return {
        success: false,
        prBody,
        branchName,
        riskZone,
        errors: [
          'PR cannot be proposed: the Git index already contains staged paths outside this delivery.',
        ],
      };
    }

    if (redViolations.length > 0) {
      const { getAuthenticatedIdentity } = await import('@openslack/github');
      const identity = await getAuthenticatedIdentity({
        auth: 'app',
        requireLive: true,
        cwd: root,
      });
      const author = identity.login;
      authorRisk = assessPRAuthorRisk({
        author,
        authorIsBot: identity.isBot,
        changedPaths: input.changedPaths,
        codeowners: loadLocalCodeowners(root, input.changedPaths),
      });
      if (authorRisk.status !== 'safe') {
        return {
          success: false,
          prBody,
          branchName,
          riskZone,
          errors: [`PR cannot be proposed: ${authorRisk.reason} ${authorRisk.recommendation}`],
          authorRisk,
        };
      }
    }

    execFileSync('git', ['add', '--', ...input.changedPaths], { cwd: root, stdio: 'pipe' });
    const stagedPaths = listGitPaths(root, ['diff', '--cached', '--name-only']);
    if (!samePathSet(stagedPaths, input.changedPaths)) {
      execFileSync('git', ['reset', '--', ...input.changedPaths], { cwd: root, stdio: 'pipe' });
      throw new Error('Staged paths do not exactly match the declared delivery paths.');
    }
    execFileSync('git', ['commit', '-m', commitMsg], { cwd: root, stdio: 'pipe' });
    const committedPaths = listGitPaths(root, [
      'diff-tree',
      '--root',
      '--no-commit-id',
      '--name-only',
      '-r',
      'HEAD',
    ]);
    if (!samePathSet(committedPaths, input.changedPaths)) {
      throw new Error('Committed paths do not exactly match the declared delivery paths.');
    }
    const { resolveGitHubRepoTarget } = await import('@openslack/github');
    const target = resolveGitHubRepoTarget({ cwd: root });
    delivery = await (input.deliveryService ?? new GitHubDeliveryService()).publish({
      rootDir: root,
      owner: target.owner,
      repo: target.repo,
      branch: branchName,
      base: 'main',
      remote: input.remote ?? 'origin',
      title: commitMsg,
      body: prBody,
      requireIssuesWrite: false,
    });
    prUrl = delivery.prUrl;
  } catch (error) {
    const summary =
      error instanceof DeliveryError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : 'Unknown delivery failure.';
    return {
      success: false,
      prBody,
      branchName,
      riskZone,
      errors: [summary],
      authorRisk,
      delivery,
    };
  }

  return { success: true, prBody, branchName, riskZone, prUrl, errors, authorRisk, delivery };
}

function listGitPaths(root: string, args: string[]): string[] {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split(/\r?\n/)
    .map((path) => path.trim().replaceAll('\\', '/'))
    .filter(Boolean);
}

function samePathSet(left: string[], right: string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right.map((path) => path.replaceAll('\\', '/')))].sort();
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((path, index) => path === normalizedRight[index])
  );
}

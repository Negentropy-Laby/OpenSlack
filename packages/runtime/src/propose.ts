import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyPaths } from '@openslack/kernel';
import { authorizeAgentAction } from '@openslack/kernel';
import type { AgentPrincipal, AgentPermissionSnapshot, RiskZone } from '@openslack/kernel';
import { assessPRAuthorRisk, parseCODEOWNERS, resolveCodeowners } from '@openslack/pr';
import type { PRAuthorRiskPreflight } from '@openslack/pr';

export interface PRProposalInput {
  agentId: string;
  taskId: string;
  runId: string;
  changedPaths: string[];
  description?: string;
  principal?: AgentPrincipal;
  snapshot?: AgentPermissionSnapshot;
}

export interface PRProposalResult {
  success: boolean;
  prBody: string;
  branchName: string;
  riskZone: string;
  errors: string[];
  prUrl?: string;
  authorRisk?: PRAuthorRiskPreflight;
}

function hasGitRemote(root: string): boolean {
  try {
    const result = execSync('git remote get-url origin', { cwd: root, stdio: 'pipe' });
    return result.toString().trim().length > 0;
  } catch {
    return false;
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

  const riskZone = classifyPaths(input.changedPaths);
  const blackViolations = input.changedPaths.filter((p) => classifyPaths([p]) === 'black');
  const redViolations = input.changedPaths.filter((p) => classifyPaths([p]) === 'red');
  const branchName = `agent/${input.agentId}/${input.taskId}/${input.runId}`;

  // Authorization gate — if snapshot provided, enforce
  if (input.snapshot) {
    const auth = authorizeAgentAction({ snapshot: input.snapshot, action: 'pr.propose', changedPaths: input.changedPaths, riskZone: riskZone as RiskZone });
    if (auth.decision !== 'allow') {
      const prefix = auth.decision === 'ask' ? 'Authorization requires confirmation' : 'Authorization denied';
      return { success: false, prBody: '', branchName: '', riskZone, errors: [`${prefix}: ${auth.evidence.reason}`] };
    }
  }
  const prBody = `## OpenSlack Self-Evolution PR

### Task Information
- **Task ID:** ${input.taskId}
- **Agent ID:** ${input.agentId}
- **Run ID:** ${input.runId}

### Risk
- **Zone:** ${riskZone.toUpperCase()}
${redViolations.length > 0 ? `- **⚠ Red Zone paths touched:**\n${redViolations.map((p) => `  - ${p}`).join('\n')}\n` : ''}
${blackViolations.length > 0 ? `- **❌ Black Zone paths touched:**\n${blackViolations.map((p) => `  - ${p}`).join('\n')}\n` : ''}

### Changed Paths
${input.changedPaths.map((p) => `- ${p}`).join('\n')}

### Description
${input.description || 'No description provided.'}

${input.principal ? `### Principal
- **Registry ID:** ${input.principal.registry_id}
- **Run ID:** ${input.principal.run_id}
- **Provider:** ${input.principal.provider}
` : ''}
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
    return { success: false, prBody, branchName, riskZone, errors: ['PR cannot be proposed: Black Zone files modified'] };
  }

  // Attempt git commit + push + draft PR if remote is configured
  let prUrl: string | undefined;
  let authorRisk: PRAuthorRiskPreflight | undefined;
  try {
    const root = process.cwd();
    const commitMsg = `[OpenSlack][${input.taskId}][${input.agentId}] ${input.description || 'Workspace changes'}`;

    if (redViolations.length > 0) {
      const { getAuthenticatedIdentity } = await import('@openslack/github');
      const identity = await getAuthenticatedIdentity();
      const author = process.env.OPENSLACK_PR_AUTHOR_LOGIN || identity.login;
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

    if (hasGitRemote(root)) {
      execFileSync('git', ['add', ...input.changedPaths], { cwd: root, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', commitMsg], { cwd: root, stdio: 'pipe' });
      try {
        execFileSync('git', ['push', 'origin', branchName], { cwd: root, stdio: 'pipe', timeout: 30000 });

        // Try to create a draft PR via GitHub provider if token is available
        try {
          const { createDraftPR } = await import('@openslack/github');
          const draftResult = await createDraftPR(branchName, 'main', commitMsg, prBody);
          prUrl = draftResult.url;
        } catch {
          // Fallback: compare URL when token not available
          prUrl = `https://github.com/wsman/OpenSlack/compare/main...${branchName}`;
        }
      } catch {
        errors.push('Git push failed — branch may already exist or no credentials configured');
      }
    }
  } catch {
    // Graceful fallback: commit/push are optional; PR body is the minimum deliverable
  }

  return { success: true, prBody, branchName, riskZone, prUrl, errors, authorRisk };
}

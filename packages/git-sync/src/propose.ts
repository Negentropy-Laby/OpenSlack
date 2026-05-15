import { execSync } from 'node:child_process';
import { classifyPaths } from '@openslack/kernel';

export interface PRProposalInput {
  agentId: string;
  taskId: string;
  runId: string;
  changedPaths: string[];
  description?: string;
}

export interface PRProposalResult {
  success: boolean;
  prBody: string;
  branchName: string;
  riskZone: string;
  errors: string[];
  prUrl?: string;
}

function hasGitRemote(root: string): boolean {
  try {
    const result = execSync('git remote get-url origin', { cwd: root, stdio: 'pipe' });
    return result.toString().trim().length > 0;
  } catch {
    return false;
  }
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

### Validation
- [ ] \`openslack workspace validate\`
- [ ] \`pnpm typecheck\`
- [ ] \`pnpm test\`
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
  try {
    const root = process.cwd();
    const commitMsg = `[OpenSlack][${input.taskId}][${input.agentId}] ${input.description || 'Workspace changes'}`;

    if (hasGitRemote(root)) {
      execSync(`git add ${input.changedPaths.join(' ')}`, { cwd: root, stdio: 'pipe' });
      execSync(`git commit -m "${commitMsg}"`, { cwd: root, stdio: 'pipe' });
      try {
        execSync(`git push origin "${branchName}"`, { cwd: root, stdio: 'pipe', timeout: 30000 });

        // Try to create a draft PR via GitHub provider if token is available
        try {
          const { createDraftPR } = await import('@openslack/github-provider');
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

  return { success: true, prBody, branchName, riskZone, prUrl, errors };
}

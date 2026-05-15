import { classifyPaths } from '@openslack/policy';

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
}

export function proposeWorkspacePR(input: PRProposalInput): PRProposalResult {
  const errors: string[] = [];

  if (input.changedPaths.length === 0) {
    errors.push('No changed paths provided');
    return { success: false, prBody: '', branchName: '', riskZone: 'unknown', errors };
  }

  // Classify risk
  const riskZone = classifyPaths(input.changedPaths);

  // Detect protected path violations
  const blackViolations = input.changedPaths.filter((p) => classifyPaths([p]) === 'black');
  const redViolations = input.changedPaths.filter((p) => classifyPaths([p]) === 'red');

  const branchName = `agent/${input.agentId}/${input.taskId}/${input.runId}`;

  // Generate PR body
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

  return { success: true, prBody, branchName, riskZone, errors };
}

import type { WorkflowGateResult, WorkflowGateCriterion } from './types.js';

const WORKFLOW_PATH_PATTERNS = [
  /^\.claude\/workflows\//,
  /^\.openslack\/workflows\//,
  /^packages\/workflows\/src\//,
];

export function touchesWorkflowFiles(changedFiles: string[]): boolean {
  return changedFiles.some((f) => WORKFLOW_PATH_PATTERNS.some((p) => p.test(f)));
}

function hasProposalIssueLink(body: string): boolean {
  // Matches: "workflow proposal #123", "proposal issue #123", "closes #123" etc.
  return /workflow\s+proposal\s+#\d+|proposal\s+issue\s+#\d+|closes?\s+#\d+|fixes?\s+#\d+/i.test(body);
}

function hasReviewIssueLink(body: string): boolean {
  return /workflow\s+review\s+#\d+|review\s+issue\s+#\d+/i.test(body);
}

function hasWorkflowHash(body: string): boolean {
  return /hash[:\s]+sha256:[a-f0-9]{64}|workflow[-\s]?hash[:\s]*[a-f0-9]{64}/i.test(body);
}

function hasTrustDecision(body: string): boolean {
  return /trust\s+decision[:\s]+(trusted|untrusted|core)/i.test(body);
}

export function evaluateWorkflowGate(
  changedFiles: string[],
  body: string,
): WorkflowGateResult {
  const touched = touchesWorkflowFiles(changedFiles);

  if (!touched) {
    return {
      touchedWorkflowFiles: false,
      overall: 'N/A',
      criteria: [
        { name: 'Workflow files touched', status: 'N/A', detail: 'No workflow files modified' },
        { name: 'Proposal issue linked', status: 'N/A' },
        { name: 'Review issue linked', status: 'N/A' },
        { name: 'Workflow hash present', status: 'N/A' },
        { name: 'Trust decision recorded', status: 'N/A' },
      ],
    };
  }

  const criteria: WorkflowGateCriterion[] = [
    {
      name: 'Workflow files touched',
      status: 'PASS',
      detail: `Modified: ${changedFiles.filter((f) => WORKFLOW_PATH_PATTERNS.some((p) => p.test(f))).join(', ')}`,
    },
    {
      name: 'Proposal issue linked',
      status: hasProposalIssueLink(body) ? 'PASS' : 'FAIL',
      detail: hasProposalIssueLink(body)
        ? 'Workflow proposal issue found in PR body'
        : 'No workflow proposal issue link found. Expected format: "workflow proposal #N" or "closes #N"',
    },
    {
      name: 'Review issue linked',
      status: hasReviewIssueLink(body) ? 'PASS' : 'FAIL',
      detail: hasReviewIssueLink(body)
        ? 'Workflow review issue found in PR body'
        : 'No workflow review issue link found. Expected format: "workflow review #N"',
    },
    {
      name: 'Workflow hash present',
      status: hasWorkflowHash(body) ? 'PASS' : 'FAIL',
      detail: hasWorkflowHash(body)
        ? 'Workflow hash found in PR body'
        : 'No workflow hash found. Expected format: "hash: sha256:..."',
    },
    {
      name: 'Trust decision recorded',
      status: hasTrustDecision(body) ? 'PASS' : 'FAIL',
      detail: hasTrustDecision(body)
        ? 'Trust decision found in PR body'
        : 'No trust decision found. Expected format: "trust decision: trusted|untrusted"',
    },
  ];

  const allPass = criteria.every((c) => c.status === 'PASS' || c.status === 'N/A');

  return {
    touchedWorkflowFiles: true,
    overall: allPass ? 'PASS' : 'FAIL',
    criteria,
  };
}

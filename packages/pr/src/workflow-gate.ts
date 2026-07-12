import { createHash } from 'node:crypto';
import { isBotUser } from './approvals.js';
import type {
  PRReviewEvidence,
  WorkflowArtifactChangeKind,
  WorkflowEvidence,
  WorkflowGateCriterion,
  WorkflowGateResult,
  WorkflowGovernanceIssueEvidence,
  WorkflowTreeEntry,
  WorkflowTrustDecision,
} from './types.js';

const WORKFLOW_ARTIFACT_ROOTS = [
  '.openslack/workflows/',
  '.claude/workflows/',
  'templates/workflows/',
  'packages/workflows/src/builtins/',
];

const CORE_WORKFLOW_ARTIFACTS = new Set([
  'packages/workflows/src/workflow-catalog.ts',
  'packages/workflows/src/pattern-registry.ts',
]);

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function isWorkflowArtifactPath(path: string): boolean {
  const normalized = normalizePath(path);
  return WORKFLOW_ARTIFACT_ROOTS.some((root) => normalized.startsWith(root))
    || CORE_WORKFLOW_ARTIFACTS.has(normalized);
}

export function isCoreWorkflowArtifactPath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized.startsWith('packages/workflows/src/builtins/')
    || CORE_WORKFLOW_ARTIFACTS.has(normalized);
}

/** Compatibility name retained for callers; it now means governed artifacts only. */
export function touchesWorkflowFiles(changedFiles: string[]): boolean {
  return changedFiles.some(isWorkflowArtifactPath);
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeTree(entries: WorkflowTreeEntry[]): WorkflowTreeEntry[] {
  return entries
    .map((entry) => ({ ...entry, path: normalizePath(entry.path) }))
    .filter((entry) => entry.type !== 'tree' && isWorkflowArtifactPath(entry.path))
    .sort((a, b) => comparePaths(a.path, b.path));
}

function renderTree(entries: WorkflowTreeEntry[]): string {
  return entries
    .map((entry) => `${entry.path}\0${entry.mode}\0${entry.type}\0${entry.sha}`)
    .join('\n');
}

function changeKind(
  addedFiles: string[],
  modifiedFiles: string[],
  deletedFiles: string[],
): WorkflowArtifactChangeKind {
  const populated = [addedFiles, modifiedFiles, deletedFiles].filter((files) => files.length > 0);
  if (populated.length > 1) return 'mixed';
  if (addedFiles.length > 0) return 'added';
  if (deletedFiles.length > 0) return 'deleted';
  return 'modified';
}

export function createWorkflowEvidence(input: {
  baseSha: string;
  headSha: string;
  baseTree: WorkflowTreeEntry[];
  headTree: WorkflowTreeEntry[];
}): WorkflowEvidence {
  const baseTree = normalizeTree(input.baseTree);
  const headTree = normalizeTree(input.headTree);
  const baseByPath = new Map(baseTree.map((entry) => [entry.path, entry]));
  const headByPath = new Map(headTree.map((entry) => [entry.path, entry]));
  const addedFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const deletedFiles: string[] = [];

  for (const [path, head] of headByPath) {
    const base = baseByPath.get(path);
    if (!base) {
      addedFiles.push(path);
    } else if (base.sha !== head.sha || base.mode !== head.mode || base.type !== head.type) {
      modifiedFiles.push(path);
    }
  }
  for (const path of baseByPath.keys()) {
    if (!headByPath.has(path)) deletedFiles.push(path);
  }

  addedFiles.sort(comparePaths);
  modifiedFiles.sort(comparePaths);
  deletedFiles.sort(comparePaths);
  const artifactFiles = [...addedFiles, ...modifiedFiles, ...deletedFiles].sort(comparePaths);
  if (artifactFiles.length === 0) {
    throw new Error('Workflow evidence requested without an artifact tree change.');
  }

  const payload = [
    'openslack.workflow-evidence.v1',
    `base:${input.baseSha}`,
    renderTree(baseTree),
    `head:${input.headSha}`,
    renderTree(headTree),
  ].join('\n');

  return {
    schema: 'openslack.workflow-evidence.v1',
    baseSha: input.baseSha,
    headSha: input.headSha,
    evidenceHash: `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`,
    artifactFiles,
    addedFiles,
    modifiedFiles,
    deletedFiles,
    changeKind: changeKind(addedFiles, modifiedFiles, deletedFiles),
  };
}

interface ParsedTrustMarker {
  decision?: WorkflowTrustDecision;
  error?: string;
}

function parseTrustMarker(body: string): ParsedTrustMarker {
  const markerLines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^workflow-trust\s*:/i.test(line));
  if (markerLines.length === 0) return {};
  if (markerLines.length !== 1) return { error: 'Review must contain exactly one Workflow-Trust marker.' };
  const match = markerLines[0].match(/^workflow-trust\s*:\s*(untrusted|trusted|core)$/i);
  if (!match) return { error: 'Workflow-Trust must be untrusted, trusted, or core.' };
  return { decision: match[1].toLowerCase() as WorkflowTrustDecision };
}

function normalizeOwner(owner: string): string {
  return owner.replace(/^@/, '').toLowerCase();
}

function governanceIssueNumber(body: string): number | undefined {
  const match = body.match(/workflow\s+governance\s+#(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

export interface EvaluateWorkflowGateInput {
  changedFiles: string[];
  body: string;
  author: string;
  baseSha?: string;
  headSha?: string;
  reviews: PRReviewEvidence[];
  workflowEvidence?: WorkflowEvidence;
  governanceIssue?: WorkflowGovernanceIssueEvidence;
  codeowners?: string[];
}

function governanceIssueMatches(
  issue: WorkflowGovernanceIssueEvidence | undefined,
  linkedIssueNumber: number | undefined,
  evidence: WorkflowEvidence | undefined,
): boolean {
  if (
    !issue
    || !linkedIssueNumber
    || issue.issueNumber !== linkedIssueNumber
    || !isBotUser(issue.author)
    || !evidence
  ) return false;
  try {
    const body = issue.body;
    const artifactBlock = body.match(/artifact_files:\s*\n([\s\S]*?)\n```/)?.[1] ?? '';
    const issueArtifacts = artifactBlock
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*-\s*("(?:[^"\\]|\\.)*")\s*$/)?.[1])
      .filter((value): value is string => Boolean(value))
      .map((value) => JSON.parse(value) as string)
      .sort(comparePaths);
    return body.includes('schema: "openslack.workflow_governance.v1"')
      && body.includes(`pr: ${issue.prNumber}`)
      && body.includes(`base_sha: ${JSON.stringify(evidence.baseSha)}`)
      && body.includes(`head_sha: ${JSON.stringify(evidence.headSha)}`)
      && body.includes(`evidence_hash: ${JSON.stringify(evidence.evidenceHash)}`)
      && JSON.stringify(issueArtifacts) === JSON.stringify(evidence.artifactFiles);
  } catch {
    return false;
  }
}

export function evaluateWorkflowGate(input: EvaluateWorkflowGateInput): WorkflowGateResult {
  const touchedArtifacts = input.changedFiles
    .map(normalizePath)
    .filter(isWorkflowArtifactPath)
    .sort(comparePaths);

  if (touchedArtifacts.length === 0) {
    return {
      touchedWorkflowFiles: false,
      overall: 'N/A',
      criteria: [
        { name: 'Workflow artifacts touched', status: 'N/A', detail: 'No governed workflow artifacts modified' },
        { name: 'Current-head evidence', status: 'N/A' },
        { name: 'Human trust review', status: 'N/A' },
        { name: 'Trust scope', status: 'N/A' },
        { name: 'Governance issue', status: 'N/A' },
      ],
    };
  }

  const evidence = input.workflowEvidence;
  // GitHub's changed-file surface may report only the destination of a rename.
  // The base/head trees are authoritative, so require every reported artifact
  // to be present without rejecting additional deleted/renamed tree entries.
  const evidenceFilesMatch = evidence !== undefined
    && touchedArtifacts.every((path) => evidence.artifactFiles.includes(path));
  const evidenceCurrent = evidence !== undefined
    && evidence.schema === 'openslack.workflow-evidence.v1'
    && evidence.baseSha === input.baseSha
    && evidence.headSha === input.headSha
    && evidenceFilesMatch;

  const currentHumanReviews = input.reviews.filter((review) =>
    review.state === 'APPROVED'
      && normalizeOwner(review.user) !== normalizeOwner(input.author)
      && !isBotUser(review.user)
      && Boolean(input.headSha)
      && review.commitOid === input.headSha,
  );
  const parsedReviews = currentHumanReviews.map((review) => ({ review, marker: parseTrustMarker(review.body ?? '') }));
  const invalidMarker = parsedReviews.find(({ marker }) => marker.error);
  const trustReviews = parsedReviews.filter(({ marker }) => marker.decision);
  const decisions = new Set(trustReviews.map(({ marker }) => marker.decision));
  const conflicting = decisions.size > 1;
  const trustDecision = !invalidMarker && !conflicting && decisions.size === 1
    ? [...decisions][0]
    : undefined;
  const trustReviewers = trustReviews
    .filter(({ marker }) => marker.decision === trustDecision)
    .map(({ review }) => review.user)
    .sort(comparePaths);
  const trustReviewCommitOid = trustReviews.find(({ marker }) => marker.decision === trustDecision)?.review.commitOid;

  const artifactFiles = evidence?.artifactFiles ?? touchedArtifacts;
  const includesCoreArtifact = artifactFiles.some(isCoreWorkflowArtifactPath);
  const codeowners = new Set((input.codeowners ?? []).map(normalizeOwner));
  const coreReviewerValid = trustDecision !== 'core'
    || trustReviewers.some((reviewer) => codeowners.has(normalizeOwner(reviewer)));
  const trustScopeValid = trustDecision !== undefined
    && (includesCoreArtifact ? trustDecision === 'core' : trustDecision !== 'core')
    && coreReviewerValid;

  const issueNumber = governanceIssueNumber(input.body);
  const governanceRequired = evidence !== undefined
    && (evidence.addedFiles.length > 0 || includesCoreArtifact);
  const governanceValid = !governanceRequired
    || governanceIssueMatches(input.governanceIssue, issueNumber, evidence);

  const criteria: WorkflowGateCriterion[] = [
    {
      name: 'Workflow artifacts touched',
      status: 'PASS',
      detail: `Modified: ${artifactFiles.join(', ')}`,
    },
    {
      name: 'Current-head evidence',
      status: evidenceCurrent ? 'PASS' : 'FAIL',
      detail: evidenceCurrent
        ? `${evidence?.evidenceHash} for ${input.headSha}`
        : 'Workflow tree evidence is missing, stale, or does not match the changed artifact set.',
    },
    {
      name: 'Human trust review',
      status: trustDecision ? 'PASS' : 'FAIL',
      detail: invalidMarker?.marker.error
        ?? (conflicting
          ? 'Current-head human approvals contain conflicting Workflow-Trust decisions.'
          : trustDecision
            ? `${trustDecision} by ${trustReviewers.join(', ')}`
            : 'Approve the current head with exactly one Workflow-Trust marker.'),
    },
    {
      name: 'Trust scope',
      status: trustScopeValid ? 'PASS' : 'FAIL',
      detail: trustScopeValid
        ? includesCoreArtifact ? 'Core artifact approved as core by a CODEOWNER.' : `Non-core artifact approved as ${trustDecision}.`
        : includesCoreArtifact
          ? 'Builtins, catalog, and pattern artifacts require Workflow-Trust: core from a CODEOWNER.'
          : 'Non-core artifacts only allow Workflow-Trust: trusted or untrusted.',
    },
    {
      name: 'Governance issue',
      status: governanceRequired ? governanceValid ? 'PASS' : 'FAIL' : 'N/A',
      detail: governanceRequired
        ? governanceValid
          ? `Workflow governance #${issueNumber}`
          : 'New or core artifacts require a matching bot-created Workflow Governance Issue bound to the current evidence.'
        : 'Existing non-core artifact updates use the PR as the governance record.',
    },
  ];

  const overall = criteria.every((criterion) => criterion.status === 'PASS' || criterion.status === 'N/A')
    ? 'PASS'
    : 'FAIL';
  return {
    touchedWorkflowFiles: true,
    overall,
    criteria,
    artifactFiles,
    changeKind: evidence?.changeKind,
    evidenceHash: evidence?.evidenceHash,
    trustDecision,
    trustReviewer: trustReviewers[0],
    trustReviewCommitOid,
    trustSource: trustDecision ? 'human-review' : undefined,
    governanceIssue: issueNumber,
  };
}

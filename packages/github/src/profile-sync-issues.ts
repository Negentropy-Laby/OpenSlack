// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProfileSyncProposalIssue {
  schema: 'openslack.profile_sync_proposal.v1';
  sourceRepo: string;
  targetRepo: string;
  targetPath: string;
  marker: string;
  maxPosts: number;
  requestedBy: string;
}

export interface ProfileSyncFailureIssue {
  schema: 'openslack.profile_sync_failure.v1';
  sourceRepo: string;
  targetRepo: string;
  error: string;
  phase: string;
  runId?: string;
}

export interface ProfileSyncImprovementIssue {
  schema: 'openslack.profile_sync_improvement.v1';
  problem: string;
  proposedChange: string;
  affectedPhase?: string;
}

// ── Profile Sync Proposal Issue ───────────────────────────────────────────────

export function renderProfileSyncProposalBody(proposal: ProfileSyncProposalIssue): string {
  const lines: string[] = [];
  lines.push(`## Profile Sync Proposal`);
  lines.push('');
  lines.push('```openslack-profile-sync-proposal');
  lines.push(`schema: ${JSON.stringify(proposal.schema)}`);
  lines.push(`source_repo: ${JSON.stringify(proposal.sourceRepo)}`);
  lines.push(`target_repo: ${JSON.stringify(proposal.targetRepo)}`);
  lines.push(`target_path: ${JSON.stringify(proposal.targetPath)}`);
  lines.push(`marker: ${JSON.stringify(proposal.marker)}`);
  lines.push(`max_posts: ${JSON.stringify(proposal.maxPosts)}`);
  lines.push(`requested_by: ${JSON.stringify(proposal.requestedBy)}`);
  lines.push('```');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('### Pre-flight Checklist');
  lines.push('- [ ] Source repository exists and is accessible');
  lines.push('- [ ] Target repository exists and has profile/README.md');
  lines.push('- [ ] Marker comments are present in target README');
  lines.push('- [ ] Whitepapers posts have valid frontmatter');
  lines.push('');
  lines.push('### Configuration');
  lines.push(`| Setting | Value |`);
  lines.push(`|---------|-------|`);
  lines.push(`| Source | ${proposal.sourceRepo} |`);
  lines.push(`| Target | ${proposal.targetRepo} |`);
  lines.push(`| Path | ${proposal.targetPath} |`);
  lines.push(`| Marker | \`<!-- openslack:${proposal.marker}:start/end -->\` |`);
  lines.push(`| Max Posts | ${proposal.maxPosts} |`);
  return lines.join('\n');
}

export function profileSyncProposalLabels(): string[] {
  return ['profile-sync:proposal'];
}

// ── Profile Sync Failure Issue ────────────────────────────────────────────────

export function renderProfileSyncFailureBody(failure: ProfileSyncFailureIssue): string {
  const lines: string[] = [];
  lines.push(`## Profile Sync Failure`);
  lines.push('');
  lines.push('```openslack-profile-sync-failure');
  lines.push(`schema: ${JSON.stringify(failure.schema)}`);
  lines.push(`source_repo: ${JSON.stringify(failure.sourceRepo)}`);
  lines.push(`target_repo: ${JSON.stringify(failure.targetRepo)}`);
  lines.push(`phase: ${JSON.stringify(failure.phase)}`);
  if (failure.runId) lines.push(`run_id: ${JSON.stringify(failure.runId)}`);
  lines.push('```');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('### Error');
  lines.push('```');
  lines.push(failure.error);
  lines.push('```');
  lines.push('');
  lines.push('### Retry Instructions');
  lines.push('1. Fix the reported error');
  lines.push('2. Run `openslack collaboration workflow profile-sync run` to retry');
  lines.push('3. If the error persists, check the marker in the target README');
  return lines.join('\n');
}

export function profileSyncFailureLabels(phase: string): string[] {
  const labels = ['profile-sync:failure'];
  if (phase) labels.push(`phase:${phase}`);
  return labels;
}

// ── Profile Sync Improvement Issue ────────────────────────────────────────────

export function renderProfileSyncImprovementBody(improvement: ProfileSyncImprovementIssue): string {
  const lines: string[] = [];
  lines.push(`## Profile Sync Improvement`);
  lines.push('');
  lines.push('```openslack-profile-sync-improvement');
  lines.push(`schema: ${JSON.stringify(improvement.schema)}`);
  if (improvement.affectedPhase)
    lines.push(`affected_phase: ${JSON.stringify(improvement.affectedPhase)}`);
  lines.push('```');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('### Problem');
  lines.push(improvement.problem);
  lines.push('');
  lines.push('### Proposed Change');
  lines.push(improvement.proposedChange);
  lines.push('');
  lines.push('### Related PR');
  lines.push('<!-- Link the PR that implements this improvement -->');
  return lines.join('\n');
}

export function profileSyncImprovementLabels(): string[] {
  return ['profile-sync:improvement'];
}

// ── Label Definitions ─────────────────────────────────────────────────────────

export const PROFILE_SYNC_LABEL_DEFINITIONS: Array<{
  name: string;
  color: string;
  description: string;
}> = [
  {
    name: 'profile-sync:proposal',
    color: '0366d6',
    description: 'Profile sync configuration proposal',
  },
  { name: 'profile-sync:failure', color: 'd73a4a', description: 'Profile sync run failure' },
  {
    name: 'profile-sync:improvement',
    color: 'ffd54f',
    description: 'Profile sync improvement request',
  },
  { name: 'phase:collect', color: '6f42c1', description: 'Collect phase' },
  { name: 'phase:validate', color: '6f42c1', description: 'Validate phase' },
  { name: 'phase:render', color: '6f42c1', description: 'Render phase' },
  { name: 'phase:patch', color: '6f42c1', description: 'Patch phase' },
  { name: 'phase:pr', color: '6f42c1', description: 'PR phase' },
  { name: 'phase:audit', color: '6f42c1', description: 'Audit phase' },
];

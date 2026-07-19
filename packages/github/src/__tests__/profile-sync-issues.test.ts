import { describe, it, expect } from 'vitest';
import {
  renderProfileSyncProposalBody,
  renderProfileSyncFailureBody,
  renderProfileSyncImprovementBody,
  profileSyncProposalLabels,
  profileSyncFailureLabels,
  profileSyncImprovementLabels,
  PROFILE_SYNC_LABEL_DEFINITIONS,
} from '../profile-sync-issues.js';

// ── renderProfileSyncProposalBody ─────────────────────────────────────────────

describe('renderProfileSyncProposalBody', () => {
  it('renders proposal with all fields', () => {
    const proposal = {
      schema: 'openslack.profile_sync_proposal.v1' as const,
      sourceRepo: 'Negentropy-Laby/whitepapers',
      targetRepo: 'Negentropy-Laby/.github',
      targetPath: 'profile/README.md',
      marker: 'latest-insights',
      maxPosts: 5,
      requestedBy: 'openslack-agent-operator',
    };
    const body = renderProfileSyncProposalBody(proposal);
    expect(body).toContain('Profile Sync Proposal');
    expect(body).toContain('openslack.profile_sync_proposal.v1');
    expect(body).toContain('Negentropy-Laby/whitepapers');
    expect(body).toContain('Negentropy-Laby/.github');
    expect(body).toContain('profile/README.md');
    expect(body).toContain('latest-insights');
    expect(body).toContain('Pre-flight Checklist');
  });
});

// ── renderProfileSyncFailureBody ──────────────────────────────────────────────

describe('renderProfileSyncFailureBody', () => {
  it('renders failure with phase and error', () => {
    const failure = {
      schema: 'openslack.profile_sync_failure.v1' as const,
      sourceRepo: 'Negentropy-Laby/whitepapers',
      targetRepo: 'Negentropy-Laby/.github',
      error: 'Marker "openslack:latest-insights" not found in target content.',
      phase: 'patch',
      runId: 'run-abc123',
    };
    const body = renderProfileSyncFailureBody(failure);
    expect(body).toContain('Profile Sync Failure');
    expect(body).toContain('openslack.profile_sync_failure.v1');
    expect(body).toContain('patch');
    expect(body).toContain('run-abc123');
    expect(body).toContain('Marker "openslack:latest-insights" not found');
    expect(body).toContain('Retry Instructions');
  });

  it('renders failure without optional runId', () => {
    const failure = {
      schema: 'openslack.profile_sync_failure.v1' as const,
      sourceRepo: 'Negentropy-Laby/whitepapers',
      targetRepo: 'Negentropy-Laby/.github',
      error: 'No published posts found.',
      phase: 'validate',
    };
    const body = renderProfileSyncFailureBody(failure);
    expect(body).toContain('No published posts found');
    expect(body).not.toContain('run_id:');
  });
});

// ── renderProfileSyncImprovementBody ──────────────────────────────────────────

describe('renderProfileSyncImprovementBody', () => {
  it('renders improvement with affected phase', () => {
    const improvement = {
      schema: 'openslack.profile_sync_improvement.v1' as const,
      problem: 'Currently only supports one marker section.',
      proposedChange: 'Add support for multiple marker sections like featured posts.',
      affectedPhase: 'render',
    };
    const body = renderProfileSyncImprovementBody(improvement);
    expect(body).toContain('Profile Sync Improvement');
    expect(body).toContain('openslack.profile_sync_improvement.v1');
    expect(body).toContain('render');
    expect(body).toContain('Currently only supports one marker section');
    expect(body).toContain('Add support for multiple marker sections');
  });

  it('renders improvement without affected phase', () => {
    const improvement = {
      schema: 'openslack.profile_sync_improvement.v1' as const,
      problem: 'Summary limit is too low.',
      proposedChange: 'Increase summary limit to 500 characters.',
    };
    const body = renderProfileSyncImprovementBody(improvement);
    expect(body).toContain('Profile Sync Improvement');
    expect(body).not.toContain('affected_phase');
  });
});

// ── Label Builders ────────────────────────────────────────────────────────────

describe('profileSyncProposalLabels', () => {
  it('returns proposal label', () => {
    expect(profileSyncProposalLabels()).toEqual(['profile-sync:proposal']);
  });
});

describe('profileSyncFailureLabels', () => {
  it('returns failure label with phase', () => {
    expect(profileSyncFailureLabels('patch')).toEqual(['profile-sync:failure', 'phase:patch']);
  });

  it('returns failure label without phase', () => {
    expect(profileSyncFailureLabels('')).toEqual(['profile-sync:failure']);
  });
});

describe('profileSyncImprovementLabels', () => {
  it('returns improvement label', () => {
    expect(profileSyncImprovementLabels()).toEqual(['profile-sync:improvement']);
  });
});

// ── Label Definitions ─────────────────────────────────────────────────────────

describe('PROFILE_SYNC_LABEL_DEFINITIONS', () => {
  it('contains expected labels', () => {
    const names = PROFILE_SYNC_LABEL_DEFINITIONS.map((d) => d.name);
    expect(names).toContain('profile-sync:proposal');
    expect(names).toContain('profile-sync:failure');
    expect(names).toContain('profile-sync:improvement');
    expect(names).toContain('phase:collect');
    expect(names).toContain('phase:validate');
    expect(names).toContain('phase:render');
    expect(names).toContain('phase:patch');
    expect(names).toContain('phase:pr');
    expect(names).toContain('phase:audit');
  });

  it('has valid hex colors', () => {
    for (const def of PROFILE_SYNC_LABEL_DEFINITIONS) {
      expect(def.color).toMatch(/^[0-9a-fA-F]{6}$/);
    }
  });

  it('has descriptions', () => {
    for (const def of PROFILE_SYNC_LABEL_DEFINITIONS) {
      expect(def.description.length).toBeGreaterThan(0);
    }
  });
});

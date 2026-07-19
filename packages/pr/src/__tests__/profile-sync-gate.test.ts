import { describe, it, expect } from 'vitest';
import { evaluateProfileSyncGate } from '../profile-sync-gate.js';

describe('evaluateProfileSyncGate', () => {
  it('returns N/A for non-profile-sync PR', () => {
    const result = evaluateProfileSyncGate(
      ['src/index.ts'],
      'Regular PR body',
      'feature/new-stuff',
    );
    expect(result.overall).toBe('N/A');
    expect(result.touchedProfileSyncFiles).toBe(false);
  });

  it('PASS for legal profile-sync PR', () => {
    const body = `## Profile Sync
\`\`\`openslack-profile-sync-metadata
source_repo: owner/whitepapers
source_commit: abc1234
target_repo: owner/.github
target_path: profile/README.md
marker: openslack:latest-insights
workflow_run_id: run-xyz789
posts_included: 3
validation_summary: 5 valid, 3 published, 3 selected
\`\`\``;
    const patch = `@@ -10,5 +10,7 @@
 <!-- openslack:latest-insights:start -->
-Old post
+New post 1
+New post 2
 <!-- openslack:latest-insights:end -->`;
    const result = evaluateProfileSyncGate(
      ['profile/README.md'],
      body,
      'openslack/profile-sync/latest-insights-20260531-abc1234-xyz789',
      [{ filename: 'profile/README.md', patch }],
    );
    expect(result.overall).toBe('PASS');
    expect(result.touchedProfileSyncFiles).toBe(true);
    expect(result.criteria.every((c) => c.status === 'PASS' || c.status === 'N/A')).toBe(true);
  });

  it('FAIL when modifying extra files', () => {
    const body = `## Profile Sync
\`\`\`openslack-profile-sync-metadata
source_repo: owner/whitepapers
source_commit: abc1234
target_repo: owner/.github
target_path: profile/README.md
marker: openslack:latest-insights
workflow_run_id: run-xyz789
posts_included: 3
\`\`\``;
    const result = evaluateProfileSyncGate(
      ['profile/README.md', 'src/index.ts'],
      body,
      'openslack/profile-sync/latest-insights-20260531-abc1234-xyz789',
    );
    expect(result.overall).toBe('FAIL');
    expect(
      result.criteria.some(
        (c) => c.name === 'Only modifies profile/README.md' && c.status === 'FAIL',
      ),
    ).toBe(true);
  });

  it('FAIL when missing metadata', () => {
    const result = evaluateProfileSyncGate(
      ['profile/README.md'],
      'profile: sync latest latest-insights',
      'openslack/profile-sync/latest-insights-20260531-abc1234-xyz789',
    );
    expect(result.overall).toBe('FAIL');
    expect(
      result.criteria.some((c) => c.name === 'Required metadata present' && c.status === 'FAIL'),
    ).toBe(true);
  });

  it('FAIL when direct-main write', () => {
    const body = `## Profile Sync
\`\`\`openslack-profile-sync-metadata
source_repo: owner/whitepapers
source_commit: abc1234
target_repo: owner/.github
target_path: profile/README.md
marker: openslack:latest-insights
workflow_run_id: run-xyz789
posts_included: 3
\`\`\``;
    const result = evaluateProfileSyncGate(['profile/README.md'], body, 'main');
    expect(result.overall).toBe('FAIL');
    expect(
      result.criteria.some((c) => c.name === 'Not direct-main write' && c.status === 'FAIL'),
    ).toBe(true);
  });

  it('detects profile-sync PR by branch prefix', () => {
    const result = evaluateProfileSyncGate(
      ['profile/README.md'],
      'Some body without metadata',
      'openslack/profile-sync/latest-insights-20260531-abc1234-xyz789',
    );
    expect(result.touchedProfileSyncFiles).toBe(true);
  });

  it('detects profile-sync PR by body title', () => {
    const result = evaluateProfileSyncGate(
      ['profile/README.md'],
      'profile: sync latest latest-insights',
      'feature/something',
    );
    expect(result.touchedProfileSyncFiles).toBe(true);
  });

  it('FAIL when headRef is empty (missing branch information)', () => {
    const body = `## Profile Sync
\`\`\`openslack-profile-sync-metadata
source_repo: owner/whitepapers
source_commit: abc1234
target_repo: owner/.github
target_path: profile/README.md
marker: openslack:latest-insights
workflow_run_id: run-xyz789
posts_included: 3
\`\`\``;
    const result = evaluateProfileSyncGate(['profile/README.md'], body, '');
    expect(result.overall).toBe('FAIL');
    expect(
      result.criteria.some((c) => c.name === 'Not direct-main write' && c.status === 'FAIL'),
    ).toBe(true);
  });

  it('PASS when patch changes are within marker block', () => {
    const body = `## Profile Sync
\`\`\`openslack-profile-sync-metadata
source_repo: owner/whitepapers
source_commit: abc1234
target_repo: owner/.github
target_path: profile/README.md
marker: openslack:latest-insights
workflow_run_id: run-xyz789
posts_included: 3
\`\`\``;
    const patch = `@@ -10,5 +10,8 @@
 <!-- openslack:latest-insights:start -->
-Old post 1
-Old post 2
+New post 1
+New post 2
+New post 3
 <!-- openslack:latest-insights:end -->`;
    const result = evaluateProfileSyncGate(
      ['profile/README.md'],
      body,
      'openslack/profile-sync/latest-insights-20260531-abc1234-xyz789',
      [{ filename: 'profile/README.md', patch }],
    );
    expect(result.overall).toBe('PASS');
    const markerOnly = result.criteria.find((c) => c.name === 'Marker-only patch');
    expect(markerOnly?.status).toBe('PASS');
    expect(markerOnly?.detail).toContain('All changes within');
  });

  it('FAIL when patch changes are outside marker block', () => {
    const body = `## Profile Sync
\`\`\`openslack-profile-sync-metadata
source_repo: owner/whitepapers
source_commit: abc1234
target_repo: owner/.github
target_path: profile/README.md
marker: openslack:latest-insights
workflow_run_id: run-xyz789
posts_included: 3
\`\`\``;
    const patch = `@@ -1,5 +1,8 @@
+Added before marker
 <!-- openslack:latest-insights:start -->
-Old post 1
+New post 1
 <!-- openslack:latest-insights:end -->`;
    const result = evaluateProfileSyncGate(
      ['profile/README.md'],
      body,
      'openslack/profile-sync/latest-insights-20260531-abc1234-xyz789',
      [{ filename: 'profile/README.md', patch }],
    );
    expect(result.overall).toBe('FAIL');
    const markerOnly = result.criteria.find((c) => c.name === 'Marker-only patch');
    expect(markerOnly?.status).toBe('FAIL');
    expect(markerOnly?.detail).toContain('before marker');
  });

  it('FAIL when patch modifies the marker comment itself', () => {
    const body = `## Profile Sync
\`\`\`openslack-profile-sync-metadata
source_repo: owner/whitepapers
source_commit: abc1234
target_repo: owner/.github
target_path: profile/README.md
marker: openslack:latest-insights
workflow_run_id: run-xyz789
posts_included: 3
\`\`\``;
    const patch = `@@ -10,5 +10,5 @@
-<!-- openslack:latest-insights:start -->
+<!-- openslack:latest-insights:modified -->
 Old post 1
 <!-- openslack:latest-insights:end -->`;
    const result = evaluateProfileSyncGate(
      ['profile/README.md'],
      body,
      'openslack/profile-sync/latest-insights-20260531-abc1234-xyz789',
      [{ filename: 'profile/README.md', patch }],
    );
    expect(result.overall).toBe('FAIL');
    const markerOnly = result.criteria.find((c) => c.name === 'Marker-only patch');
    expect(markerOnly?.status).toBe('FAIL');
    expect(markerOnly?.detail).toContain('Marker comment itself');
  });

  it('FAIL when patch evidence is omitted', () => {
    const body = `## Profile Sync
\`\`\`openslack-profile-sync-metadata
source_repo: owner/whitepapers
source_commit: abc1234
target_repo: owner/.github
target_path: profile/README.md
marker: openslack:latest-insights
workflow_run_id: run-xyz789
posts_included: 3
\`\`\``;
    const result = evaluateProfileSyncGate(
      ['profile/README.md'],
      body,
      'openslack/profile-sync/latest-insights-20260531-abc1234-xyz789',
    );
    expect(result.overall).toBe('FAIL');
    const markerOnly = result.criteria.find((c) => c.name === 'Marker-only patch');
    expect(markerOnly?.status).toBe('FAIL');
    expect(markerOnly?.detail).toContain('Patch data unavailable');
  });

  it('FAIL when patch evidence is empty', () => {
    const body = `## Profile Sync
\`\`\`openslack-profile-sync-metadata
source_repo: owner/whitepapers
source_commit: abc1234
target_repo: owner/.github
target_path: profile/README.md
marker: openslack:latest-insights
workflow_run_id: run-xyz789
posts_included: 3
\`\`\``;
    const result = evaluateProfileSyncGate(
      ['profile/README.md'],
      body,
      'openslack/profile-sync/latest-insights-20260531-abc1234-xyz789',
      [],
    );
    expect(result.overall).toBe('FAIL');
    const markerOnly = result.criteria.find((c) => c.name === 'Marker-only patch');
    expect(markerOnly?.status).toBe('FAIL');
    expect(markerOnly?.detail).toContain('Patch data unavailable');
  });

  it('FAIL when patch list is missing profile README', () => {
    const body = `## Profile Sync
\`\`\`openslack-profile-sync-metadata
source_repo: owner/whitepapers
source_commit: abc1234
target_repo: owner/.github
target_path: profile/README.md
marker: openslack:latest-insights
workflow_run_id: run-xyz789
posts_included: 3
\`\`\``;
    const result = evaluateProfileSyncGate(
      ['profile/README.md'],
      body,
      'openslack/profile-sync/latest-insights-20260531-abc1234-xyz789',
      [{ filename: 'README.md', patch: '@@ -1 +1 @@\n-old\n+new' }],
    );
    expect(result.overall).toBe('FAIL');
    const markerOnly = result.criteria.find((c) => c.name === 'Marker-only patch');
    expect(markerOnly?.status).toBe('FAIL');
    expect(markerOnly?.detail).toContain('Expected patch');
  });
});

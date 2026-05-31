import type { ProfileSyncGateResult, ProfileSyncGateCriterion } from './types.js';

const PROFILE_SYNC_BRANCH_PREFIX = 'openslack/profile-sync/';
const PROFILE_SYNC_TARGET_PATH = 'profile/README.md';

function isProfileSyncPR(changedFiles: string[], branchName: string, body: string): boolean {
  // Check branch prefix
  if (branchName.startsWith(PROFILE_SYNC_BRANCH_PREFIX)) {
    return true;
  }
  // Check PR body metadata block
  if (body.includes('```openslack-profile-sync-metadata') || body.includes('profile: sync latest')) {
    return true;
  }
  // Check if only profile/README.md is modified
  if (changedFiles.length === 1 && changedFiles[0] === PROFILE_SYNC_TARGET_PATH) {
    return true;
  }
  return false;
}

function extractMarkerFromBody(body: string): string | null {
  const match = body.match(/marker:\s*openslack:([^\s]+)/);
  return match ? match[1] : null;
}

function extractSourceCommit(body: string): string | null {
  const match = body.match(/source_commit:\s*(\S+)/);
  return match ? match[1] : null;
}

function extractRunId(body: string): string | null {
  const match = body.match(/workflow_run_id:\s*(\S+)/);
  return match ? match[1] : null;
}

function extractPostsIncluded(body: string): number | null {
  const match = body.match(/posts_included:\s*(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function isPatchWithinMarkerRange(patch: string, marker: string): { valid: boolean; detail: string } {
  const startMarker = `<!-- openslack:${marker}:start -->`;
  const endMarker = `<!-- openslack:${marker}:end -->`;

  const lines = patch.split('\n');
  const hunkLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('@@')) continue;
    hunkLines.push(line);
  }

  // Find marker positions by comparing content (stripping +/- / space prefix)
  let startIdx = -1;
  let endIdx = -1;
  for (let i = 0; i < hunkLines.length; i++) {
    const content = hunkLines[i].replace(/^[+\- ]/, '').trim();
    if (content === startMarker) startIdx = i;
    if (content === endMarker) endIdx = i;
  }

  if (startIdx === -1 || endIdx === -1) {
    return { valid: false, detail: `Marker block not found in patch (marker: ${marker})` };
  }

  for (let i = 0; i < hunkLines.length; i++) {
    const line = hunkLines[i];
    if ((line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
      const content = line.slice(1).trim();

      // Marker itself must not be modified
      if (content === startMarker || content === endMarker) {
        return { valid: false, detail: 'Marker comment itself was modified' };
      }

      // Change must be between start and end markers
      if (i < startIdx) {
        return { valid: false, detail: 'Change detected before marker start block' };
      }
      if (i > endIdx) {
        return { valid: false, detail: 'Change detected after marker end block' };
      }
    }
  }

  return { valid: true, detail: `All changes within openslack:${marker} marker block` };
}

export function evaluateProfileSyncGate(
  changedFiles: string[],
  body: string,
  branchName: string,
  filePatches?: Array<{ filename: string; patch: string }>,
): ProfileSyncGateResult {
  const isProfileSync = isProfileSyncPR(changedFiles, branchName, body);

  if (!isProfileSync) {
    return {
      touchedProfileSyncFiles: false,
      overall: 'N/A',
      criteria: [
        { name: 'Profile-sync PR', status: 'N/A', detail: 'Not a profile-sync PR' },
        { name: 'Only modifies profile/README.md', status: 'N/A' },
        { name: 'Marker block present', status: 'N/A' },
        { name: 'Required metadata present', status: 'N/A' },
        { name: 'Not direct-main write', status: 'N/A' },
        { name: 'Marker-only patch', status: 'N/A' },
      ],
    };
  }

  const criteria: ProfileSyncGateCriterion[] = [];

  // Criterion 1: Is a profile-sync PR
  criteria.push({
    name: 'Profile-sync PR',
    status: 'PASS',
    detail: `Branch: ${branchName || '(unknown)'}`,
  });

  // Criterion 2: Only modifies profile/README.md
  const onlyTargetFile = changedFiles.length === 1 && changedFiles[0] === PROFILE_SYNC_TARGET_PATH;
  criteria.push({
    name: 'Only modifies profile/README.md',
    status: onlyTargetFile ? 'PASS' : 'FAIL',
    detail: onlyTargetFile
      ? 'Only profile/README.md modified'
      : `Modified ${changedFiles.length} file(s): ${changedFiles.join(', ')}`,
  });

  // Criterion 3: Marker block present in body
  const marker = extractMarkerFromBody(body);
  criteria.push({
    name: 'Marker block present',
    status: marker ? 'PASS' : 'FAIL',
    detail: marker ? `Marker: openslack:${marker}` : 'No marker found in PR body metadata',
  });

  // Criterion 4: Required metadata present
  const sourceCommit = extractSourceCommit(body);
  const runId = extractRunId(body);
  const postsIncluded = extractPostsIncluded(body);
  const hasAllMetadata = !!sourceCommit && !!runId && postsIncluded !== null && postsIncluded >= 0;

  const missingMetadata: string[] = [];
  if (!sourceCommit) missingMetadata.push('source_commit');
  if (!runId) missingMetadata.push('workflow_run_id');
  if (postsIncluded === null) missingMetadata.push('posts_included');

  criteria.push({
    name: 'Required metadata present',
    status: hasAllMetadata ? 'PASS' : 'FAIL',
    detail: hasAllMetadata
      ? `source_commit=${sourceCommit}, workflow_run_id=${runId}, posts_included=${postsIncluded}`
      : `Missing: ${missingMetadata.join(', ')}`,
  });

  // Criterion 5: Not direct-main write
  if (!branchName) {
    criteria.push({
      name: 'Not direct-main write',
      status: 'FAIL',
      detail: 'Missing branch information (headRef not available)',
    });
  } else {
    const isDirectMain = branchName === 'main' || branchName === 'master';
    criteria.push({
      name: 'Not direct-main write',
      status: isDirectMain ? 'FAIL' : 'PASS',
      detail: isDirectMain ? 'PR is from main/master branch' : `Branch: ${branchName}`,
    });
  }

  // Criterion 6: Marker-only patch
  if (!marker) {
    criteria.push({
      name: 'Marker-only patch',
      status: 'FAIL',
      detail: 'Cannot verify marker-only patch without marker metadata',
    });
  } else if (!filePatches || filePatches.length === 0) {
    criteria.push({
      name: 'Marker-only patch',
      status: 'FAIL',
      detail: 'Patch data unavailable; marker range not verified',
    });
  } else {
    const targetPatch = filePatches.find((f) => f.filename === PROFILE_SYNC_TARGET_PATH);
    if (targetPatch) {
      const patchResult = isPatchWithinMarkerRange(targetPatch.patch, marker);
      criteria.push({
        name: 'Marker-only patch',
        status: patchResult.valid ? 'PASS' : 'FAIL',
        detail: patchResult.detail,
      });
    } else {
      criteria.push({
        name: 'Marker-only patch',
        status: 'FAIL',
        detail: 'Expected patch for profile/README.md not found',
      });
    }
  }

  const allPass = criteria.every((c) => c.status === 'PASS' || c.status === 'N/A');

  return {
    touchedProfileSyncFiles: true,
    overall: allPass ? 'PASS' : 'FAIL',
    criteria,
  };
}

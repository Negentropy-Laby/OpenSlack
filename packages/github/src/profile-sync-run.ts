import type { ProfileSyncConfig } from './profile-sync-config.js';
import { publishProfileSyncFailure } from './profile-sync-issue-publisher.js';
import type { ProfileSyncFailureIssue } from './profile-sync-issues.js';
import { listOpenPRs } from './pr.js';
import { assertCanonicalPRBase } from './pr-base-policy.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProfileSyncRunOptions {
  config: ProfileSyncConfig;
  runId?: string;
  sourceSha?: string;
  dryRun?: boolean;
  /** Optional callback to record collaboration events. Keeps @openslack/github free of @openslack/collaboration dependency. */
  recordEvent?: (event: {
    type: string;
    actor: { id: string; kind: string; provider: string };
    object: { kind: string; id: string; url?: string };
    source: { kind: string; ref: string };
    summary: string;
    visibility: string;
    redacted: boolean;
    containsSensitiveData: boolean;
    metadata?: Record<string, unknown>;
  }) => Promise<unknown> | unknown;
}

export interface ProfileSyncRunResult {
  status: 'completed' | 'failed' | 'skipped';
  prUrl?: string;
  prNumber?: number;
  branchName?: string;
  issueUrl?: string;
  issueNumber?: number;
  reason?: string;
  error?: string;
}

// ── Run ───────────────────────────────────────────────────────────────────────

export async function runProfileSync(
  options: ProfileSyncRunOptions,
): Promise<ProfileSyncRunResult> {
  const { config, runId = `local-${Date.now()}`, sourceSha = 'unknown' } = options;
  assertCanonicalPRBase(config.target.branch);

  const source = parseRepoString(config.source.repo);
  const target = parseRepoString(config.target.repo);

  const {
    readRepoDirectory,
    readRepoFile,
    parseFrontmatter,
    validatePost,
    sortPostsByDate,
    renderLatestInsightsSection,
    patchMarkerSection,
    MarkerNotFoundError,
    createBranch,
    commitFileToBranch,
    createProfileSyncPR,
  } = await import('./profile-sync.js');

  // ── Phase 1: Collect ────────────────────────────────────────────────────────
  let entries: Array<{ name: string; path: string; type: string }> = [];
  try {
    entries = await readRepoDirectory(
      source.owner,
      source.repo,
      config.source.path,
      config.source.branch,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return handleFailure(
      config,
      'collect',
      `Failed to read source directory: ${msg}`,
      runId,
      options.recordEvent,
      options.dryRun,
    );
  }

  const mdFiles = entries.filter((e) => e.type === 'file' && e.name.endsWith('.md'));

  const posts: Array<{
    title: string;
    date: string;
    tags: string[];
    summary: string;
    status: string;
    slug: string;
    sourcePath: string;
  }> = [];

  for (const file of mdFiles) {
    let fileData: { content: string; sha: string } | null = null;
    try {
      fileData = await readRepoFile(source.owner, source.repo, file.path, config.source.branch);
    } catch {
      continue;
    }
    if (!fileData) continue;

    const frontmatter = parseFrontmatter(fileData.content);
    if (!frontmatter) continue;

    const validation = validatePost(frontmatter);
    if (!validation.valid) continue;

    posts.push({
      title: String(frontmatter.title),
      date: String(frontmatter.date),
      tags: Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : [],
      summary: String(frontmatter.summary),
      status: String(frontmatter.status ?? 'draft'),
      slug: file.name.replace(/\.md$/, ''),
      sourcePath: file.path,
    });
  }

  // ── Phase 2: Validate ───────────────────────────────────────────────────────
  const published = posts.filter((p) => p.status === 'published');
  if (published.length === 0) {
    return handleFailure(
      config,
      'validate',
      'No published posts found. Nothing to sync.',
      runId,
      options.recordEvent,
      options.dryRun,
    );
  }

  // ── Phase 3: Render ─────────────────────────────────────────────────────────
  const sorted = sortPostsByDate(published);
  const selected = sorted.slice(0, config.max_posts);
  const rendered = renderLatestInsightsSection(selected, config.source.repo);

  if (rendered.length > 10240) {
    return handleFailure(
      config,
      'render',
      `Rendered section exceeds 10KB limit (${rendered.length} bytes)`,
      runId,
      options.recordEvent,
      options.dryRun,
    );
  }

  // ── Phase 4: Patch ──────────────────────────────────────────────────────────
  let targetFile: { content: string; sha: string } | null = null;
  try {
    targetFile = await readRepoFile(
      target.owner,
      target.repo,
      config.target.path,
      config.target.branch,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return handleFailure(
      config,
      'patch',
      `Failed to read target file: ${msg}`,
      runId,
      options.recordEvent,
      options.dryRun,
    );
  }

  if (!targetFile) {
    return handleFailure(
      config,
      'patch',
      `Target file ${config.target.path} not found in ${config.target.repo}`,
      runId,
      options.recordEvent,
      options.dryRun,
    );
  }

  let patchedContent: string;
  try {
    patchedContent = patchMarkerSection(targetFile.content, config.target.marker, rendered);
  } catch (err: unknown) {
    if (err instanceof MarkerNotFoundError) {
      return handleFailure(
        config,
        'patch',
        `Marker "openslack:${config.target.marker}" not found in ${config.target.repo}/${config.target.path}. ` +
          'Refusing to overwrite. Add the marker comments and retry.',
        runId,
        options.recordEvent,
        options.dryRun,
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    return handleFailure(
      config,
      'patch',
      `Patch failed: ${msg}`,
      runId,
      options.recordEvent,
      options.dryRun,
    );
  }

  // ── Phase 5: PR ─────────────────────────────────────────────────────────────
  const branchName = buildBranchName(config, sourceSha, runId);

  // Dry-run: simulate PR creation without side effects
  if (options.dryRun) {
    return {
      status: 'completed',
      prUrl: `[DRY-RUN] would create PR from branch ${branchName}`,
      branchName,
      reason: `Dry-run: ${selected.length} posts ready to sync. Would create branch ${branchName} and open PR.`,
    };
  }

  // Check for existing open profile-sync PRs
  const existingPR = await findExistingProfileSyncPR(
    target.owner,
    target.repo,
    config.target.marker,
  );
  if (existingPR) {
    const onExisting = config.on_existing_pr ?? 'skip';
    if (onExisting === 'skip') {
      return {
        status: 'skipped',
        reason: `Open profile-sync PR already exists: ${existingPR.url}`,
        prUrl: existingPR.url,
        prNumber: existingPR.number,
        branchName: existingPR.branch,
      };
    }
    // 'update' and 'create_new' handled below
  }

  // If update mode and existing PR, reuse branch
  const actualBranchName =
    existingPR && config.on_existing_pr === 'update' ? existingPR.branch : branchName;

  // Skip createBranch when reusing existing branch in update mode
  if (!(existingPR && config.on_existing_pr === 'update')) {
    try {
      await createBranch(target.owner, target.repo, actualBranchName, config.target.branch);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return handleFailure(
        config,
        'pr',
        `Failed to create branch: ${msg}`,
        runId,
        options.recordEvent,
        options.dryRun,
      );
    }
  }

  try {
    await commitFileToBranch(
      target.owner,
      target.repo,
      actualBranchName,
      config.target.path,
      patchedContent,
      `profile: sync latest ${config.target.marker}`,
      targetFile.sha,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return handleFailure(
      config,
      'pr',
      `Failed to commit file: ${msg}`,
      runId,
      options.recordEvent,
      options.dryRun,
    );
  }

  const validationSummary = `${posts.length} valid, ${published.length} published, ${selected.length} selected`;
  const prBody = [
    '## Profile Sync',
    '',
    '```openslack-profile-sync-metadata',
    `source_repo: ${config.source.repo}`,
    `source_commit: ${sourceSha}`,
    `target_repo: ${config.target.repo}`,
    `target_path: ${config.target.path}`,
    `marker: openslack:${config.target.marker}`,
    `workflow_run_id: ${runId}`,
    `posts_included: ${selected.length}`,
    `validation_summary: ${validationSummary}`,
    '```',
    '',
    '---',
    '',
    `- **Source repo:** ${config.source.repo}`,
    `- **Target repo:** ${config.target.repo}`,
    `- **Target path:** ${config.target.path}`,
    `- **Marker:** openslack:${config.target.marker}`,
    `- **Posts included:**`,
    ...selected.map(
      (p) =>
        `  - [${p.title}](https://github.com/${config.source.repo}/blob/main/${p.sourcePath}) — ${p.date}`,
    ),
    '',
    '---',
    '*Generated by OpenSlack `profile-sync` workflow*',
  ].join('\n');

  // Update mode: reuse existing PR, do not create a new one
  if (existingPR && config.on_existing_pr === 'update') {
    // ── Phase 6: Audit (update) ───────────────────────────────────────────────
    if (options.recordEvent) {
      try {
        await options.recordEvent({
          type: 'profile_sync.completed',
          actor: { id: 'profile-sync', kind: 'system', provider: 'github' },
          object: {
            kind: 'pr',
            id: `${target.owner}/${target.repo}#${existingPR.number}`,
            url: existingPR.url,
          },
          source: { kind: 'github', ref: 'profile-sync.run' },
          summary: `Profile sync updated existing PR: ${selected.length} posts synced to ${existingPR.url}`,
          visibility: 'local',
          redacted: false,
          containsSensitiveData: false,
          metadata: {
            sourceRepo: config.source.repo,
            targetRepo: config.target.repo,
            targetPath: config.target.path,
            marker: config.target.marker,
            postsIncluded: selected.map((p) => ({ title: p.title, slug: p.slug, date: p.date })),
            prUrl: existingPR.url,
            prNumber: existingPR.number,
            branchName: actualBranchName,
            runId,
            sourceSha,
            updatedExisting: true,
          },
        });
      } catch {
        // best-effort event recording
      }
    }

    return {
      status: 'completed',
      prUrl: existingPR.url,
      prNumber: existingPR.number,
      branchName: actualBranchName,
      reason: `Updated existing PR #${existingPR.number}`,
    };
  }

  let prResult: { url: string; number: number };
  try {
    prResult = await createProfileSyncPR(
      target.owner,
      target.repo,
      actualBranchName,
      `profile: sync latest ${config.target.marker}`,
      prBody,
      config.target.branch,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return handleFailure(
      config,
      'pr',
      `Failed to create PR: ${msg}`,
      runId,
      options.recordEvent,
      options.dryRun,
    );
  }

  // ── Phase 6: Audit ──────────────────────────────────────────────────────────
  if (options.recordEvent) {
    try {
      await options.recordEvent({
        type: 'profile_sync.completed',
        actor: { id: 'profile-sync', kind: 'system', provider: 'github' },
        object: {
          kind: 'pr',
          id: `${target.owner}/${target.repo}#${prResult.number}`,
          url: prResult.url,
        },
        source: { kind: 'github', ref: 'profile-sync.run' },
        summary: `Profile sync completed: ${selected.length} posts synced to ${prResult.url}`,
        visibility: 'local',
        redacted: false,
        containsSensitiveData: false,
        metadata: {
          sourceRepo: config.source.repo,
          targetRepo: config.target.repo,
          targetPath: config.target.path,
          marker: config.target.marker,
          postsIncluded: selected.map((p) => ({ title: p.title, slug: p.slug, date: p.date })),
          prUrl: prResult.url,
          prNumber: prResult.number,
          branchName: actualBranchName,
          runId,
          sourceSha,
        },
      });
    } catch {
      // best-effort event recording
    }
  }

  return {
    status: 'completed',
    prUrl: prResult.url,
    prNumber: prResult.number,
    branchName: actualBranchName,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseRepoString(repoString: string): { owner: string; repo: string } {
  const parts = repoString.split('/');
  if (parts.length !== 2) {
    throw new Error(`Invalid repo format: "${repoString}". Expected "owner/repo".`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function buildBranchName(config: ProfileSyncConfig, sourceSha: string, runId: string): string {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const shaShort = sourceSha.slice(0, 7);
  const runShort = runId.slice(-6);
  return `openslack/profile-sync/${config.target.marker}-${dateStr}-${shaShort}-${runShort}`;
}

async function findExistingProfileSyncPR(
  owner: string,
  repo: string,
  marker: string,
): Promise<{ number: number; url: string; branch: string } | null> {
  try {
    const openPRs = await listOpenPRs(50, owner, repo);
    const existing = openPRs.find(
      (pr) =>
        pr.title.includes(`profile: sync latest ${marker}`) || pr.title.includes('Profile Sync'),
    );
    if (existing) {
      // listOpenPRs now returns the real head.ref as branch
      return { number: existing.number, url: existing.url, branch: existing.branch };
    }
    return null;
  } catch {
    return null;
  }
}

async function handleFailure(
  config: ProfileSyncConfig,
  phase: string,
  error: string,
  runId: string,
  recordEvent?: ProfileSyncRunOptions['recordEvent'],
  dryRun?: boolean,
): Promise<ProfileSyncRunResult> {
  let issueUrl: string | undefined;
  let issueNumber: number | undefined;

  if (config.failure_issue.enabled && !dryRun) {
    try {
      const failure: ProfileSyncFailureIssue = {
        schema: 'openslack.profile_sync_failure.v1',
        sourceRepo: config.source.repo,
        targetRepo: config.target.repo,
        error,
        phase,
        runId,
      };
      const result = await publishProfileSyncFailure(failure);
      issueUrl = result.url;
      issueNumber = result.issueNumber;
    } catch {
      // best-effort issue creation
    }
  }

  // Record failure event
  if (recordEvent) {
    try {
      await recordEvent({
        type: 'profile_sync.failed',
        actor: { id: 'profile-sync', kind: 'system', provider: 'github' },
        object: { kind: 'workflow', id: `profile-sync:${runId}` },
        source: { kind: 'github', ref: 'profile-sync.run' },
        summary: `Profile sync failed in ${phase} phase: ${error.slice(0, 120)}`,
        visibility: 'local',
        redacted: false,
        containsSensitiveData: false,
        metadata: {
          sourceRepo: config.source.repo,
          targetRepo: config.target.repo,
          phase,
          error,
          runId,
          issueUrl,
          issueNumber,
        },
      });
    } catch {
      // best-effort event recording
    }
  }

  return {
    status: 'failed',
    error,
    reason: `${phase}: ${error}`,
    issueUrl,
    issueNumber,
  };
}

import type { ProfileSyncConfig } from './profile-sync-config.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProfileSyncPostFailure {
  file: string;
  errors: Array<{ field: string; message: string }>;
}

export interface ProfileSyncCheckResult {
  ok: boolean;
  source: {
    repo: string;
    branch: string;
    path: string;
    accessible: boolean;
    postCount: number;
    sourceCommit?: string;
    sourceDate?: string;
  };
  target: {
    repo: string;
    branch: string;
    path: string;
    accessible: boolean;
    markerExists: boolean;
  };
  posts: {
    total: number;
    published: number;
    failed: number;
    failures: ProfileSyncPostFailure[];
  };
  config: ProfileSyncConfig;
  errors: string[];
}

// ── Check ─────────────────────────────────────────────────────────────────────

export async function checkProfileSync(config: ProfileSyncConfig): Promise<ProfileSyncCheckResult> {
  const { readRepoDirectory, readRepoFile, parseFrontmatter, validatePost } =
    await import('./profile-sync.js');

  const errors: string[] = [];

  const { getClient } = await import('./client.js');

  // Parse repo strings
  const source = parseRepoString(config.source.repo);
  const target = parseRepoString(config.target.repo);

  // ── Source checks ───────────────────────────────────────────────────────────
  let sourceAccessible = false;
  let sourcePostCount = 0;
  let mdFiles: Array<{ name: string; path: string; type: string }> = [];
  let sourceCommit: string | undefined;
  let sourceDate: string | undefined;

  // Fetch latest commit on source branch
  try {
    const client = await getClient();
    if (!client.isDryRun) {
      const { data: commitData } = await client.octokit.repos.listCommits({
        owner: source.owner,
        repo: source.repo,
        sha: config.source.branch,
        per_page: 1,
      });
      if (commitData.length > 0) {
        sourceCommit = commitData[0].sha.slice(0, 7);
        sourceDate = commitData[0].commit?.author?.date;
      }
    }
  } catch {
    // Commit info unavailable — not a blocker
  }

  try {
    const entries = await readRepoDirectory(
      source.owner,
      source.repo,
      config.source.path,
      config.source.branch,
    );
    mdFiles = entries.filter(
      (e: { name: string; type: string }) => e.type === 'file' && e.name.endsWith('.md'),
    );
    sourceAccessible = true;
    sourcePostCount = mdFiles.length;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Source repository inaccessible: ${msg}`);
  }

  // ── Post validation ─────────────────────────────────────────────────────────
  let totalPosts = 0;
  let publishedPosts = 0;
  let failedPosts = 0;
  const failures: ProfileSyncPostFailure[] = [];

  for (const file of mdFiles) {
    try {
      const fileData = await readRepoFile(
        source.owner,
        source.repo,
        file.path,
        config.source.branch,
      );
      if (!fileData) {
        failures.push({
          file: file.name,
          errors: [{ field: 'read', message: 'Could not read file' }],
        });
        failedPosts++;
        continue;
      }

      const frontmatter = parseFrontmatter(fileData.content);
      if (!frontmatter) {
        failures.push({
          file: file.name,
          errors: [{ field: 'frontmatter', message: 'No frontmatter found' }],
        });
        failedPosts++;
        continue;
      }

      const validation = validatePost(frontmatter);
      if (!validation.valid) {
        failures.push({ file: file.name, errors: validation.errors });
        failedPosts++;
        continue;
      }

      totalPosts++;
      if (frontmatter.status === 'published') {
        publishedPosts++;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ file: file.name, errors: [{ field: 'parse', message: msg }] });
      failedPosts++;
    }
  }

  // ── Target checks ───────────────────────────────────────────────────────────
  let targetAccessible = false;
  let markerExists = false;

  try {
    const targetFile = await readRepoFile(
      target.owner,
      target.repo,
      config.target.path,
      config.target.branch,
    );
    if (targetFile) {
      targetAccessible = true;
      const { buildMarkers } = await import('./profile-sync-markers.js');
      const markers = buildMarkers(config.target.marker);
      markerExists =
        targetFile.content.includes(markers.start) && targetFile.content.includes(markers.end);
      if (!markerExists) {
        errors.push(`Marker "${markers.start}" / "${markers.end}" not found in target`);
      }
    } else {
      errors.push(`Target file ${config.target.path} not found in ${config.target.repo}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Target repository inaccessible: ${msg}`);
  }

  // ── Result ──────────────────────────────────────────────────────────────────
  const ok =
    sourceAccessible &&
    targetAccessible &&
    markerExists &&
    publishedPosts > 0 &&
    errors.length === 0;

  if (publishedPosts === 0 && sourceAccessible) {
    errors.push('No published posts found');
  }

  return {
    ok,
    source: {
      repo: config.source.repo,
      branch: config.source.branch,
      path: config.source.path,
      accessible: sourceAccessible,
      postCount: sourcePostCount,
      sourceCommit,
      sourceDate,
    },
    target: {
      repo: config.target.repo,
      branch: config.target.branch,
      path: config.target.path,
      accessible: targetAccessible,
      markerExists,
    },
    posts: {
      total: totalPosts,
      published: publishedPosts,
      failed: failedPosts,
      failures,
    },
    config,
    errors,
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

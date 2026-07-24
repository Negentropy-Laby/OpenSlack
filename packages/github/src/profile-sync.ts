import { getClient } from './client.js';
import { assertCanonicalPRBase } from './pr-base-policy.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RepoFileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  sha: string;
}

export interface RepoFileContent {
  content: string;
  sha: string;
}

export interface ProfileSyncPRResult {
  url: string;
  number: number;
}

export interface ParsedPost {
  title: string;
  date: string;
  tags: string[];
  summary: string;
  status: string;
  slug: string;
  sourcePath: string;
}

export interface PostValidationError {
  field: string;
  message: string;
}

export interface PostValidationResult {
  valid: boolean;
  errors: PostValidationError[];
}

// ── Content Reading ───────────────────────────────────────────────────────────

/**
 * List files in a repository directory.
 * Supports cross-repo reads by passing explicit owner/repo.
 */
export async function readRepoDirectory(
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<RepoFileEntry[]> {
  const client = await getClient();
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would list ${owner}/${repo}/${path}${ref ? `@${ref}` : ''}`);
    return [];
  }

  const { data } = await client.octokit.repos.getContent({
    owner,
    repo,
    path,
    ref,
  });

  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .filter(
      (item): item is typeof item & { type: 'file' | 'dir' } =>
        item.type === 'file' || item.type === 'dir',
    )
    .map((item) => ({
      name: item.name,
      path: item.path,
      type: item.type,
      sha: item.sha,
    }));
}

/**
 * Read a file's content from a repository.
 * Supports cross-repo reads by passing explicit owner/repo.
 */
export async function readRepoFile(
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<RepoFileContent | null> {
  const client = await getClient();
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would read ${owner}/${repo}/${path}${ref ? `@${ref}` : ''}`);
    return { content: `[DRY RUN] Simulated content for ${path}`, sha: 'DRY_RUN_SHA' };
  }

  try {
    const { data } = await client.octokit.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });

    if (Array.isArray(data) || !('content' in data) || typeof data.content !== 'string') {
      return null;
    }

    return {
      content: Buffer.from(data.content, 'base64').toString('utf-8'),
      sha: data.sha,
    };
  } catch {
    return null;
  }
}

import { buildMarkers, MarkerNotFoundError } from './profile-sync-markers.js';
export { MarkerNotFoundError } from './profile-sync-markers.js';

// ── Marker Patching ───────────────────────────────────────────────────────────

/**
 * Replace the content between HTML comment markers.
 *
 * Markers look like:
 *   <!-- openslack:latest-insights:start -->
 *   ... content to replace ...
 *   <!-- openslack:latest-insights:end -->
 *
 * Throws if markers are not found (fail closed).
 */
export function patchMarkerSection(
  content: string,
  markerName: string,
  newSection: string,
): string {
  const markers = buildMarkers(markerName);
  const startIdx = content.indexOf(markers.start);
  const endIdx = content.indexOf(markers.end);

  if (startIdx === -1 || endIdx === -1) {
    throw new MarkerNotFoundError(
      `Marker "openslack:${markerName}" not found in target content. ` +
        `Expected both "${markers.start}" and "${markers.end}" to be present.`,
    );
  }

  if (endIdx <= startIdx) {
    throw new MarkerNotFoundError(
      `End marker for "openslack:${markerName}" appears before start marker.`,
    );
  }

  const before = content.slice(0, startIdx + markers.start.length);
  const after = content.slice(endIdx);

  return `${before}\n${newSection}\n${after}`;
}

// ── Branch Creation ───────────────────────────────────────────────────────────

/**
 * Create a new branch in a repository from a base ref (default: main).
 */
export async function createBranch(
  owner: string,
  repo: string,
  branchName: string,
  baseRef: string = 'main',
): Promise<{ sha: string }> {
  const client = await getClient();
  if (client.isDryRun) {
    console.log(
      `[DRY RUN] Would create branch "${branchName}" in ${owner}/${repo} from ${baseRef}`,
    );
    return { sha: 'DRY_RUN_SHA' };
  }

  const { data: refData } = await client.octokit.git.getRef({
    owner,
    repo,
    ref: `heads/${baseRef}`,
  });

  const sha = refData.object.sha as string;

  await client.octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha,
  });

  return { sha };
}

// ── File Commit ───────────────────────────────────────────────────────────────

/**
 * Commit a single file to a branch using createOrUpdateFileContents.
 * If the file already exists, the current SHA must be provided for the update.
 */
export async function commitFileToBranch(
  owner: string,
  repo: string,
  branchName: string,
  path: string,
  content: string,
  message: string,
  existingSha?: string,
): Promise<{ commitSha: string }> {
  const client = await getClient();
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would commit "${path}" to ${owner}/${repo}@${branchName}`);
    return { commitSha: 'DRY_RUN_COMMIT_SHA' };
  }

  const { data } = await client.octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: branchName,
    sha: existingSha,
  });

  return { commitSha: data.commit?.sha ?? 'unknown' };
}

// ── PR Creation ───────────────────────────────────────────────────────────────

/**
 * Create a draft PR for profile sync changes.
 */
export async function createProfileSyncPR(
  owner: string,
  repo: string,
  branchName: string,
  title: string,
  body: string,
  baseRef: string = 'main',
): Promise<ProfileSyncPRResult> {
  assertCanonicalPRBase(baseRef);
  const client = await getClient();
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would create draft PR in ${owner}/${repo}: "${title}"`);
    return { url: `https://github.com/${owner}/${repo}/pull/DRY_RUN`, number: 0 };
  }

  const { data } = await client.octokit.pulls.create({
    owner,
    repo,
    title,
    body,
    head: branchName,
    base: baseRef,
    draft: true,
  });

  return {
    url: data.html_url,
    number: data.number,
  };
}

// ── Frontmatter Parsing ───────────────────────────────────────────────────────

/**
 * Lightweight YAML frontmatter parser.
 * Extracts content between `---` delimiters at the start of a markdown file.
 */
export function parseFrontmatter(source: string): Record<string, unknown> | null {
  const trimmed = source.trimStart();
  if (!trimmed.startsWith('---')) {
    return null;
  }

  const endDelimiter = trimmed.indexOf('\n---', 3);
  if (endDelimiter === -1) {
    return null;
  }

  const yamlContent = trimmed.slice(3, endDelimiter).trim();
  const result: Record<string, unknown> = {};

  // Simple key: value line parser (handles arrays like [a, b], quoted strings)
  for (const line of yamlContent.split('\n')) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) continue;

    const colonIdx = trimmedLine.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmedLine.slice(0, colonIdx).trim();
    let rawValue = trimmedLine.slice(colonIdx + 1).trim();

    // Remove surrounding quotes
    if (
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ) {
      rawValue = rawValue.slice(1, -1);
    }

    // Parse arrays like ["a", "b"] or [a, b]
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      const inner = rawValue.slice(1, -1);
      result[key] = inner
        .split(',')
        .map((s) => s.trim())
        .map((s) => {
          if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
            return s.slice(1, -1);
          }
          return s;
        })
        .filter((s) => s.length > 0);
    } else {
      result[key] = rawValue;
    }
  }

  return result;
}

/**
 * Extract the markdown body (after frontmatter).
 */
export function extractBody(source: string): string {
  const trimmed = source.trimStart();
  if (!trimmed.startsWith('---')) {
    return source;
  }

  const endDelimiter = trimmed.indexOf('\n---', 3);
  if (endDelimiter === -1) {
    return source;
  }

  return trimmed.slice(endDelimiter + 4).trimStart();
}

// ── Post Validation ───────────────────────────────────────────────────────────

/**
 * Validate a parsed post frontmatter.
 */
export function validatePost(frontmatter: Record<string, unknown>): PostValidationResult {
  const errors: PostValidationError[] = [];

  if (
    !frontmatter.title ||
    typeof frontmatter.title !== 'string' ||
    frontmatter.title.trim().length === 0
  ) {
    errors.push({ field: 'title', message: 'Title is required and must be a non-empty string' });
  }

  if (!frontmatter.date || typeof frontmatter.date !== 'string') {
    errors.push({ field: 'date', message: 'Date is required and must be a string' });
  } else {
    const dateParsed = new Date(frontmatter.date);
    if (Number.isNaN(dateParsed.getTime())) {
      errors.push({ field: 'date', message: `Invalid date: ${frontmatter.date}` });
    }
  }

  if (
    !frontmatter.summary ||
    typeof frontmatter.summary !== 'string' ||
    frontmatter.summary.trim().length === 0
  ) {
    errors.push({
      field: 'summary',
      message: 'Summary is required and must be a non-empty string',
    });
  } else if (frontmatter.summary.length > 240) {
    errors.push({
      field: 'summary',
      message: `Summary exceeds 240 characters (${frontmatter.summary.length})`,
    });
  }

  if (!Array.isArray(frontmatter.tags)) {
    errors.push({ field: 'tags', message: 'Tags must be an array of strings' });
  }

  if (frontmatter.status !== 'published') {
    errors.push({
      field: 'status',
      message: `Expected status "published", got "${frontmatter.status}"`,
    });
  }

  return { valid: errors.length === 0, errors };
}

// ── Post Sorting ──────────────────────────────────────────────────────────────

/**
 * Sort posts by date descending (newest first).
 */
export function sortPostsByDate(posts: ParsedPost[]): ParsedPost[] {
  return [...posts].sort((a, b) => {
    const dateA = new Date(a.date).getTime();
    const dateB = new Date(b.date).getTime();
    return dateB - dateA;
  });
}

// ── Section Rendering ─────────────────────────────────────────────────────────

/**
 * Render the "Latest Insights" markdown section from parsed posts.
 */
export function renderLatestInsightsSection(posts: ParsedPost[], sourceRepo: string): string {
  const lines: string[] = [];

  for (const post of posts) {
    const url = `https://github.com/${sourceRepo}/blob/main/${post.sourcePath}`;
    const dateStr = post.date;
    lines.push(`- [${escapeMarkdown(post.title)}](${url}) — *${dateStr}*`);
    lines.push(`  ${post.summary}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Escape markdown characters in a string for safe use in link text.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

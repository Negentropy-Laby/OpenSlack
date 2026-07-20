import type { ProfileSyncConfig } from './profile-sync-config.js';
import type { ProfileSyncCheckResult } from './profile-sync-check.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProfileSyncPreviewResult {
  ok: boolean;
  checkResult: ProfileSyncCheckResult;
  diff: string;
  renderedSection: string;
  wouldCreateBranch: string;
  patchedContent?: string;
}

// ── Preview ───────────────────────────────────────────────────────────────────

export async function previewProfileSync(
  config: ProfileSyncConfig,
  options?: { runId?: string; sourceSha?: string },
): Promise<ProfileSyncPreviewResult> {
  const { checkProfileSync } = await import('./profile-sync-check.js');

  // Step 1: Run check
  const checkResult = await checkProfileSync(config);

  if (!checkResult.ok) {
    return {
      ok: false,
      checkResult,
      diff: '',
      renderedSection: '',
      wouldCreateBranch: computeBranchName(config, options),
    };
  }

  // Step 2: Read posts and render
  const {
    readRepoDirectory,
    readRepoFile,
    parseFrontmatter,
    validatePost,
    sortPostsByDate,
    renderLatestInsightsSection,
  } = await import('./profile-sync.js');

  const source = parseRepoString(config.source.repo);
  const target = parseRepoString(config.target.repo);

  const entries = await readRepoDirectory(
    source.owner,
    source.repo,
    config.source.path,
    config.source.branch,
  );
  const mdFiles = entries.filter(
    (e: { name: string; type: string }) => e.type === 'file' && e.name.endsWith('.md'),
  );

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
    const fileData = await readRepoFile(source.owner, source.repo, file.path, config.source.branch);
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

  const published = posts.filter((p) => p.status === 'published');
  const sorted = sortPostsByDate(published);
  const selected = sorted.slice(0, config.max_posts);
  const rendered = renderLatestInsightsSection(selected, config.source.repo);

  // Step 3: Compute diff
  const targetFile = await readRepoFile(
    target.owner,
    target.repo,
    config.target.path,
    config.target.branch,
  );
  let diff = '';
  let patchedContent: string | undefined;

  if (targetFile) {
    const { patchMarkerSection, MarkerNotFoundError } = await import('./profile-sync.js');
    try {
      patchedContent = patchMarkerSection(targetFile.content, config.target.marker, rendered);
      diff = computeUnifiedDiff(config.target.path, targetFile.content, patchedContent);
    } catch (err: unknown) {
      if (err instanceof MarkerNotFoundError) {
        // This should have been caught in check, but handle defensively
        diff = `// Marker not found: ${err.message}`;
      }
    }
  }

  return {
    ok: true,
    checkResult,
    diff,
    renderedSection: rendered,
    wouldCreateBranch: computeBranchName(config, options),
    patchedContent,
  };
}

// ── Diff ──────────────────────────────────────────────────────────────────────

function computeUnifiedDiff(path: string, before: string, after: string): string {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  // Simple line-by-line diff
  const hunks: Array<{ start: number; lines: string[] }> = [];
  let currentHunk: { start: number; lines: string[] } | null = null;

  let i = 0;
  let j = 0;
  const lcs = computeLCS(beforeLines, afterLines);
  let lcsIdx = 0;

  while (i < beforeLines.length || j < afterLines.length) {
    const lcsLine = lcsIdx < lcs.length ? lcs[lcsIdx] : null;

    if (
      i < beforeLines.length &&
      j < afterLines.length &&
      beforeLines[i] === afterLines[j] &&
      beforeLines[i] === lcsLine
    ) {
      // Unchanged line
      if (currentHunk && currentHunk.lines.length >= 7) {
        hunks.push(currentHunk);
        currentHunk = null;
      }
      if (currentHunk) {
        currentHunk.lines.push(` ${beforeLines[i]}`);
      }
      i++;
      j++;
      lcsIdx++;
    } else if (i < beforeLines.length && (beforeLines[i] !== lcsLine || j >= afterLines.length)) {
      // Removed line
      if (!currentHunk) {
        currentHunk = { start: Math.max(1, i - 2), lines: [] };
        // Add context lines before
        for (let k = Math.max(0, i - 3); k < i; k++) {
          currentHunk.lines.push(` ${beforeLines[k]}`);
        }
      }
      currentHunk.lines.push(`-${beforeLines[i]}`);
      i++;
    } else if (j < afterLines.length) {
      // Added line
      if (!currentHunk) {
        currentHunk = { start: Math.max(1, i - 2), lines: [] };
        for (let k = Math.max(0, i - 3); k < i && k < beforeLines.length; k++) {
          currentHunk.lines.push(` ${beforeLines[k]}`);
        }
      }
      currentHunk.lines.push(`+${afterLines[j]}`);
      j++;
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  if (hunks.length === 0) {
    return `--- a/${path}\n+++ b/${path}\n// No changes`;
  }

  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];

  for (const hunk of hunks) {
    lines.push(`@@ -${hunk.start},${beforeLines.length} +${hunk.start},${afterLines.length} @@`);
    for (const line of hunk.lines) {
      lines.push(line);
    }
  }

  return lines.join('\n');
}

function computeLCS(a: string[], b: string[]): string[] {
  // Simple LCS for small files
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const lcs: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      lcs.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return lcs;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseRepoString(repoString: string): { owner: string; repo: string } {
  const parts = repoString.split('/');
  if (parts.length !== 2) {
    throw new Error(`Invalid repo format: "${repoString}". Expected "owner/repo".`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function computeBranchName(
  config: ProfileSyncConfig,
  options?: { runId?: string; sourceSha?: string },
): string {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const shaShort = options?.sourceSha ? options.sourceSha.slice(0, 7) : 'unknown';
  const runShort = options?.runId ? options.runId.slice(-6) : 'local';
  return `openslack/profile-sync/${config.target.marker}-${dateStr}-${shaShort}-${runShort}`;
}

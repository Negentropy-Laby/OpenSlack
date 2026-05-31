import type { WorkflowMeta, WorkflowRuntime, PreviewResult, RunResult } from '../types.js'

export const meta: WorkflowMeta = {
  name: 'profile-sync',
  description: 'Synchronize latest whitepapers into the organization profile README.',
  phases: [
    { title: 'Collect', detail: 'Read latest posts from whitepapers repository' },
    { title: 'Validate', detail: 'Validate front matter and publish status' },
    { title: 'Render', detail: 'Render latest insights section' },
    { title: 'Patch', detail: 'Patch .github/profile/README.md between markers' },
    { title: 'PR', detail: 'Create bot-authored PR for profile sync' },
    { title: 'Audit', detail: 'Record collaboration event and run audit issue' },
  ],
  inputs: {
    sourceRepo: {
      type: 'string',
      description: 'Source repository (e.g. Negentropy-Laby/whitepapers)',
    },
    targetRepo: {
      type: 'string',
      description: 'Target repository (e.g. Negentropy-Laby/.github)',
    },
    targetPath: {
      type: 'string',
      default: 'profile/README.md',
      description: 'Path to profile README in target repo',
    },
    sourcePostsPath: {
      type: 'string',
      default: 'posts',
      description: 'Directory containing markdown posts in source repo',
    },
    marker: {
      type: 'string',
      default: 'latest-insights',
      description: 'HTML comment marker name',
    },
    maxPosts: {
      type: 'number',
      default: 5,
      description: 'Maximum number of posts to include',
    },
  },
  permissions: {
    github: ['contents:read', 'contents:write', 'pull_requests:create'],
    openslack: ['collaboration:recordEvent'],
  },
  sideEffects: ['github.pr.create', 'github.branch.create', 'github.contents.write'],
  forbidden: ['github.pr.approve', 'github.pr.merge', 'github.contents:direct-main-write'],
  risk: 'medium',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseRepoString(repoString: string): { owner: string; repo: string } {
  const parts = repoString.split('/')
  if (parts.length !== 2) {
    throw new Error(`Invalid repo format: "${repoString}". Expected "owner/repo".`)
  }
  return { owner: parts[0], repo: parts[1] }
}

interface CollectResult {
  posts: Array<{
    title: string
    date: string
    tags: string[]
    summary: string
    status: string
    slug: string
    sourcePath: string
  }>
}

// ── Preview ───────────────────────────────────────────────────────────────────

export async function preview(
  ctx: WorkflowRuntime,
  args: Record<string, unknown>,
): Promise<PreviewResult> {
  const sourceRepo = String(args.sourceRepo ?? '')
  const targetRepo = String(args.targetRepo ?? '')
  const targetPath = String(args.targetPath ?? 'profile/README.md')
  const sourcePostsPath = String(args.sourcePostsPath ?? 'posts')
  const marker = String(args.marker ?? 'latest-insights')
  const maxPosts = Number(args.maxPosts ?? 5)

  if (!sourceRepo || !targetRepo) {
    throw new Error('Both sourceRepo and targetRepo are required.')
  }

  const source = parseRepoString(sourceRepo)
  const target = parseRepoString(targetRepo)

  // Phase 1: Collect
  ctx.phase('Collect')
  const {
    readRepoDirectory,
    readRepoFile,
    parseFrontmatter,
    validatePost,
    sortPostsByDate,
    renderLatestInsightsSection,
  } = await import('@openslack/github')

  const entries = await readRepoDirectory(source.owner, source.repo, sourcePostsPath)
  const mdFiles = entries.filter((e: { name: string; type: string }) =>
    e.type === 'file' && e.name.endsWith('.md'),
  )

  ctx.log(`Found ${mdFiles.length} markdown file(s) in ${sourceRepo}/${sourcePostsPath}`)

  const posts: CollectResult['posts'] = []
  const validationFailures: Array<{ file: string; errors: Array<{ field: string; message: string }> }> = []

  for (const file of mdFiles) {
    const fileData = await readRepoFile(source.owner, source.repo, file.path)
    if (!fileData) {
      ctx.log(`  ⚠ Could not read ${file.path}`)
      continue
    }

    const frontmatter = parseFrontmatter(fileData.content)
    if (!frontmatter) {
      ctx.log(`  ⚠ No frontmatter in ${file.path}`)
      continue
    }

    const validation = validatePost(frontmatter)
    if (!validation.valid) {
      validationFailures.push({ file: file.name, errors: validation.errors })
      ctx.log(`  ✗ ${file.name} failed validation`)
      continue
    }

    posts.push({
      title: String(frontmatter.title),
      date: String(frontmatter.date),
      tags: Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : [],
      summary: String(frontmatter.summary),
      status: String(frontmatter.status ?? 'draft'),
      slug: file.name.replace(/\.md$/, ''),
      sourcePath: file.path,
    })

    ctx.log(`  ✓ ${file.name}`)
  }

  // Phase 2: Validate (preview-level)
  ctx.phase('Validate')
  ctx.log(`${posts.length} post(s) passed validation`)
  if (validationFailures.length > 0) {
    ctx.log(`${validationFailures.length} post(s) failed validation`)
  }

  const published = posts.filter((p) => p.status === 'published')
  const sorted = sortPostsByDate(published)
  const selected = sorted.slice(0, maxPosts)

  ctx.log(`Selected ${selected.length} published post(s) for rendering`)

  // Phase 3: Render
  ctx.phase('Render')
  const rendered = renderLatestInsightsSection(selected, sourceRepo)

  ctx.log('Rendered section preview:')
  ctx.log('---')
  for (const line of rendered.split('\n').slice(0, 6)) {
    ctx.log(line)
  }
  if (rendered.split('\n').length > 6) {
    ctx.log('...')
  }
  ctx.log('---')

  // Phase 4: Patch (read-only check)
  ctx.phase('Patch')
  const targetFile = await readRepoFile(target.owner, target.repo, targetPath)
  if (!targetFile) {
    ctx.log(`⚠ Target file ${targetPath} not found in ${targetRepo}`)
  } else {
    const { patchMarkerSection } = await import('@openslack/github')
    try {
      // Simulate patch to verify marker exists
      patchMarkerSection(targetFile.content, marker, rendered)
      ctx.log(`✓ Marker "openslack:${marker}" found in target`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      ctx.log(`✗ ${msg}`)
    }
  }

  // Phase 5: PR (preview)
  ctx.phase('PR')
  ctx.log(`Would create draft PR in ${targetRepo} with ${rendered.length} character(s)`)

  return {
    preview: true,
    postsFound: posts.length,
    postsSelected: selected.length,
    publishedCount: published.length,
    validationFailures: validationFailures.length,
    renderedLength: rendered.length,
    targetRepo,
    targetPath,
    marker,
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────

export async function run(
  ctx: WorkflowRuntime,
  args: Record<string, unknown>,
): Promise<RunResult> {
  const sourceRepo = String(args.sourceRepo ?? '')
  const targetRepo = String(args.targetRepo ?? '')
  const targetPath = String(args.targetPath ?? 'profile/README.md')
  const sourcePostsPath = String(args.sourcePostsPath ?? 'posts')
  const marker = String(args.marker ?? 'latest-insights')
  const maxPosts = Number(args.maxPosts ?? 5)

  if (!sourceRepo || !targetRepo) {
    throw new Error('Both sourceRepo and targetRepo are required.')
  }

  const { runProfileSync, loadProfileSyncConfig } = await import('@openslack/github')

  // Build config from args
  const config = loadProfileSyncConfig()
  config.source.repo = sourceRepo
  config.target.repo = targetRepo
  config.target.path = targetPath
  config.source.path = sourcePostsPath
  config.target.marker = marker
  config.max_posts = maxPosts

  ctx.phase('Collect')
  ctx.log('Collecting posts...')

  ctx.phase('Validate')
  ctx.log('Validating posts...')

  ctx.phase('Render')
  ctx.log('Rendering section...')

  ctx.phase('Patch')
  ctx.log('Patching target...')

  ctx.phase('PR')
  ctx.log('Creating PR...')

  const result = await runProfileSync({
    config,
    runId: ctx.runId,
  })

  ctx.phase('Audit')

  if (result.status === 'completed') {
    ctx.log(`Created PR: ${result.prUrl}`)
    ctx.log('Recorded collaboration event')
    return {
      status: 'completed',
      postsSynced: 0, // populated by caller from metadata
      prUrl: result.prUrl,
      prNumber: result.prNumber,
      branchName: result.branchName,
    }
  }

  if (result.status === 'skipped') {
    ctx.log(`Skipped: ${result.reason}`)
    return {
      status: 'completed',
      postsSynced: 0,
      prUrl: result.prUrl,
      prNumber: result.prNumber,
      branchName: result.branchName,
    }
  }

  throw new Error(result.error || 'Profile sync failed')
}

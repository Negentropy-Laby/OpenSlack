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

  const source = parseRepoString(sourceRepo)
  const target = parseRepoString(targetRepo)

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
  } = await import('@openslack/github')

  // Phase 1: Collect
  ctx.phase('Collect')
  const entries = await readRepoDirectory(source.owner, source.repo, sourcePostsPath)
  const mdFiles = entries.filter((e: { name: string; type: string }) =>
    e.type === 'file' && e.name.endsWith('.md'),
  )

  const posts: CollectResult['posts'] = []
  for (const file of mdFiles) {
    const fileData = await readRepoFile(source.owner, source.repo, file.path)
    if (!fileData) continue

    const frontmatter = parseFrontmatter(fileData.content)
    if (!frontmatter) continue

    const validation = validatePost(frontmatter)
    if (!validation.valid) continue

    posts.push({
      title: String(frontmatter.title),
      date: String(frontmatter.date),
      tags: Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : [],
      summary: String(frontmatter.summary),
      status: String(frontmatter.status ?? 'draft'),
      slug: file.name.replace(/\.md$/, ''),
      sourcePath: file.path,
    })
  }

  ctx.log(`Collected ${posts.length} valid post(s)`)

  // Phase 2: Validate
  ctx.phase('Validate')
  const published = posts.filter((p) => p.status === 'published')
  if (published.length === 0) {
    throw new Error('No published posts found. Nothing to sync.')
  }

  ctx.log(`${published.length} published post(s) available`)

  // Phase 3: Render
  ctx.phase('Render')
  const sorted = sortPostsByDate(published)
  const selected = sorted.slice(0, maxPosts)
  const rendered = renderLatestInsightsSection(selected, sourceRepo)

  if (rendered.length > 10240) {
    throw new Error(`Rendered section exceeds 10KB limit (${rendered.length} bytes)`)
  }

  ctx.log(`Rendered ${selected.length} post(s), ${rendered.length} character(s)`)

  // Phase 4: Patch
  ctx.phase('Patch')
  const targetFile = await readRepoFile(target.owner, target.repo, targetPath)
  if (!targetFile) {
    throw new Error(`Target file ${targetPath} not found in ${targetRepo}`)
  }

  let patchedContent: string
  try {
    patchedContent = patchMarkerSection(targetFile.content, marker, rendered)
  } catch (err: unknown) {
    if (err instanceof MarkerNotFoundError) {
      throw new Error(
        `Marker "openslack:${marker}" not found in ${targetRepo}/${targetPath}. ` +
        'Refusing to overwrite. Add the marker comments and retry.',
      )
    }
    throw err
  }

  ctx.log(`Patched content between markers (delta: ${patchedContent.length - targetFile.content.length} chars)`)

  // Phase 5: PR
  ctx.phase('PR')
  const branchName = `openslack/profile-sync/${marker}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`

  await createBranch(target.owner, target.repo, branchName)
  ctx.log(`Created branch ${branchName}`)

  await commitFileToBranch(
    target.owner,
    target.repo,
    branchName,
    targetPath,
    patchedContent,
    `profile: sync latest ${marker}`,
    targetFile.sha,
  )
  ctx.log(`Committed patched ${targetPath}`)

  const prBody = [
    '## Profile Sync',
    '',
    `- **Source repo:** ${sourceRepo}`,
    `- **Target repo:** ${targetRepo}`,
    `- **Target path:** ${targetPath}`,
    `- **Marker:** openslack:${marker}`,
    `- **Posts included:**`,
    ...selected.map((p) => `  - [${p.title}](https://github.com/${sourceRepo}/blob/main/${p.sourcePath}) — ${p.date}`),
    '',
    '---',
    '*Generated by OpenSlack `profile-sync` workflow*',
  ].join('\n')

  const prResult = await createProfileSyncPR(
    target.owner,
    target.repo,
    branchName,
    `profile: sync latest ${marker}`,
    prBody,
  )

  ctx.log(`Created PR: ${prResult.url}`)

  // Phase 6: Audit
  ctx.phase('Audit')
  await ctx.openslack.collaboration.recordEvent({
    type: 'profile_sync.completed',
    workflow: meta.name,
    sourceRepo,
    targetRepo,
    targetPath,
    marker,
    postsIncluded: selected.map((p) => ({ title: p.title, slug: p.slug, date: p.date })),
    prUrl: prResult.url,
    prNumber: prResult.number,
  })

  ctx.log('Recorded collaboration event')

  return {
    status: 'completed',
    postsSynced: selected.length,
    prUrl: prResult.url,
    prNumber: prResult.number,
    branchName,
  }
}

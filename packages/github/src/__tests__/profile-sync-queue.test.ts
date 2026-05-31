import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  enqueueProfileSyncJob,
  dequeueProfileSyncJob,
  listPendingJobs,
  markJobComplete,
  markJobFailed,
  isDuplicate,
  recordDedupe,
} from '../profile-sync-queue.js'
import type { ProfileSyncConfig } from '../profile-sync-config.js'

describe('profile-sync-queue', () => {
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
    const tempDir = mkdtempSync(join(tmpdir(), 'psq-test-'))
    process.chdir(tempDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
  })

  const mockConfig: ProfileSyncConfig = {
    schema: 'openslack.profile_sync.v1',
    source: { repo: 'owner/whitepapers', branch: 'main', path: 'posts' },
    target: { repo: 'owner/.github', branch: 'main', path: 'profile/README.md', marker: 'latest-insights' },
    mode: 'auto-pr',
    max_posts: 5,
    pr: { draft: true, labels: ['profile:sync'] },
    failure_issue: { enabled: true },
  }

  it('enqueues and dequeues a job', () => {
    const job = enqueueProfileSyncJob({
      deliveryId: 'del-1',
      sourceRepo: 'owner/whitepapers',
      sourceSha: 'abc123',
      targetRepo: 'owner/.github',
      marker: 'latest-insights',
      config: mockConfig,
    })

    expect(job).not.toBeNull()
    expect(job?.status).toBe('pending')
    expect(job?.deliveryId).toBe('del-1')

    const dequeued = dequeueProfileSyncJob()
    expect(dequeued).not.toBeNull()
    expect(dequeued?.id).toBe(job?.id)
    expect(dequeued?.status).toBe('processing')
  })

  it('returns null for duplicate delivery', () => {
    enqueueProfileSyncJob({
      deliveryId: 'del-1',
      sourceRepo: 'owner/whitepapers',
      sourceSha: 'abc123',
      targetRepo: 'owner/.github',
      marker: 'latest-insights',
      config: mockConfig,
    })

    const duplicate = enqueueProfileSyncJob({
      deliveryId: 'del-1',
      sourceRepo: 'owner/whitepapers',
      sourceSha: 'abc123',
      targetRepo: 'owner/.github',
      marker: 'latest-insights',
      config: mockConfig,
    })

    expect(duplicate).toBeNull()
  })

  it('lists only pending jobs', () => {
    enqueueProfileSyncJob({
      deliveryId: 'del-1',
      sourceRepo: 'owner/whitepapers',
      sourceSha: 'abc123',
      targetRepo: 'owner/.github',
      marker: 'latest-insights',
      config: mockConfig,
    })

    enqueueProfileSyncJob({
      deliveryId: 'del-2',
      sourceRepo: 'owner/whitepapers',
      sourceSha: 'def456',
      targetRepo: 'owner/.github',
      marker: 'latest-insights',
      config: mockConfig,
    })

    // Dequeue first job
    const first = dequeueProfileSyncJob()
    expect(first).not.toBeNull()

    const pending = listPendingJobs()
    expect(pending).toHaveLength(1)
    expect(pending[0].deliveryId).toBe('del-2')
  })

  it('marks job complete', () => {
    const job = enqueueProfileSyncJob({
      deliveryId: 'del-1',
      sourceRepo: 'owner/whitepapers',
      sourceSha: 'abc123',
      targetRepo: 'owner/.github',
      marker: 'latest-insights',
      config: mockConfig,
    })!

    markJobComplete(job.id)

    const pending = listPendingJobs()
    expect(pending).toHaveLength(0)
  })

  it('marks job failed', () => {
    const job = enqueueProfileSyncJob({
      deliveryId: 'del-1',
      sourceRepo: 'owner/whitepapers',
      sourceSha: 'abc123',
      targetRepo: 'owner/.github',
      marker: 'latest-insights',
      config: mockConfig,
    })!

    markJobFailed(job.id)

    const pending = listPendingJobs()
    expect(pending).toHaveLength(0)
  })
})

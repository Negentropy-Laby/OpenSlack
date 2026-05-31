import { createTaskIssue } from './issue-tasks.js'
import type {
  ProfileSyncProposalIssue,
  ProfileSyncFailureIssue,
  ProfileSyncImprovementIssue,
} from './profile-sync-issues.js'
import {
  renderProfileSyncProposalBody,
  renderProfileSyncFailureBody,
  renderProfileSyncImprovementBody,
  profileSyncProposalLabels,
  profileSyncFailureLabels,
  profileSyncImprovementLabels,
  PROFILE_SYNC_LABEL_DEFINITIONS,
} from './profile-sync-issues.js'
import { getClient } from './client.js'

// ── Publish Profile Sync Proposal ─────────────────────────────────────────────

export async function publishProfileSyncProposal(
  proposal: ProfileSyncProposalIssue,
): Promise<{ issueNumber: number; url: string }> {
  const title = `[Profile Sync] Latest insights from ${proposal.sourceRepo}`
  const body = renderProfileSyncProposalBody(proposal)
  const labels = profileSyncProposalLabels()

  const result = await createTaskIssue(title, body, labels)
  return { issueNumber: result.issueNumber, url: result.url }
}

// ── Publish Profile Sync Failure ──────────────────────────────────────────────

export async function publishProfileSyncFailure(
  failure: ProfileSyncFailureIssue,
): Promise<{ issueNumber: number; url: string }> {
  const title = `[Profile Sync Failure] ${failure.error.slice(0, 80)}`
  const body = renderProfileSyncFailureBody(failure)
  const labels = profileSyncFailureLabels(failure.phase)

  const result = await createTaskIssue(title, body, labels)
  return { issueNumber: result.issueNumber, url: result.url }
}

// ── Publish Profile Sync Improvement ──────────────────────────────────────────

export async function publishProfileSyncImprovement(
  improvement: ProfileSyncImprovementIssue,
): Promise<{ issueNumber: number; url: string }> {
  const title = `[Profile Sync Improvement] ${improvement.proposedChange.slice(0, 80)}`
  const body = renderProfileSyncImprovementBody(improvement)
  const labels = profileSyncImprovementLabels()

  const result = await createTaskIssue(title, body, labels)
  return { issueNumber: result.issueNumber, url: result.url }
}

// ── Label Bootstrap ───────────────────────────────────────────────────────────

export async function bootstrapProfileSyncLabels(): Promise<{
  created: string[]
  existing: string[]
  failed: Array<{ name: string; reason: string }>
}> {
  const client = await getClient()

  const created: string[] = []
  const existing: string[] = []
  const failed: Array<{ name: string; reason: string }> = []

  if (client.isDryRun) {
    console.log(`[DRY RUN] Would create ${PROFILE_SYNC_LABEL_DEFINITIONS.length} profile-sync labels`)
    return {
      created: PROFILE_SYNC_LABEL_DEFINITIONS.map((l) => l.name),
      existing: [],
      failed: [],
    }
  }

  for (const def of PROFILE_SYNC_LABEL_DEFINITIONS) {
    try {
      await client.octokit.issues.createLabel({
        owner: client.owner,
        repo: client.repo,
        name: def.name,
        color: def.color,
        description: def.description,
      })
      created.push(def.name)
    } catch (err) {
      const status = (err as { status?: number }).status
      if (status === 422) {
        existing.push(def.name)
      } else {
        failed.push({ name: def.name, reason: (err as Error).message })
      }
    }
  }

  return { created, existing, failed }
}

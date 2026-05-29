import { getClient } from './client.js'

export interface FinalizeWorkflowPROpts {
  proposalIssue?: number
  reviewIssue?: number
  phaseIssues?: number[]
  workflowHash?: string
  trustDecision?: 'trusted' | 'untrusted' | 'core'
}

export async function finalizeWorkflowPR(
  prNumber: number,
  opts: FinalizeWorkflowPROpts,
): Promise<{
  closedIssues: number[]
  commentedIssues: number[]
  updatedLabels: number[]
  errors: string[]
}> {
  const client = await getClient()
  const closedIssues: number[] = []
  const commentedIssues: number[] = []
  const updatedLabels: number[] = []
  const errors: string[] = []

  if (client.isDryRun) {
    console.log(`[DRY RUN] Would finalize workflow PR #${prNumber}`)
    return { closedIssues, commentedIssues, updatedLabels, errors }
  }

  // Close proposal issue
  if (opts.proposalIssue) {
    try {
      await client.octokit.issues.update({
        owner: client.owner,
        repo: client.repo,
        issue_number: opts.proposalIssue,
        state: 'closed',
        state_reason: 'completed',
      })
      await client.octokit.issues.addLabels({
        owner: client.owner,
        repo: client.repo,
        issue_number: opts.proposalIssue,
        labels: ['result:completed', 'lifecycle:accepted'],
      })
      closedIssues.push(opts.proposalIssue)
      updatedLabels.push(opts.proposalIssue)
    } catch (err) {
      errors.push(`Failed to close proposal issue #${opts.proposalIssue}: ${(err as Error).message}`)
    }
  }

  // Comment on review issue with merge info
  if (opts.reviewIssue) {
    try {
      const lines: string[] = [
        '## Workflow Merged',
        '',
        `This workflow was merged via PR #${prNumber}.`,
      ]
      if (opts.workflowHash) {
        lines.push(`- **Hash**: ${opts.workflowHash}`)
      }
      if (opts.trustDecision) {
        lines.push(`- **Trust Decision**: ${opts.trustDecision}`)
      }

      await client.octokit.issues.createComment({
        owner: client.owner,
        repo: client.repo,
        issue_number: opts.reviewIssue,
        body: lines.join('\n'),
      })

      // Update review issue labels based on trust decision
      const labels = ['lifecycle:accepted']
      if (opts.trustDecision === 'trusted') labels.push('workflow:trusted')
      else if (opts.trustDecision === 'untrusted') labels.push('workflow:untrusted')

      await client.octokit.issues.addLabels({
        owner: client.owner,
        repo: client.repo,
        issue_number: opts.reviewIssue,
        labels,
      })
      commentedIssues.push(opts.reviewIssue)
      updatedLabels.push(opts.reviewIssue)
    } catch (err) {
      errors.push(`Failed to update review issue #${opts.reviewIssue}: ${(err as Error).message}`)
    }
  }

  // Close phase issues
  if (opts.phaseIssues && opts.phaseIssues.length > 0) {
    for (const issueNum of opts.phaseIssues) {
      try {
        await client.octokit.issues.update({
          owner: client.owner,
          repo: client.repo,
          issue_number: issueNum,
          state: 'closed',
          state_reason: 'completed',
        })
        await client.octokit.issues.addLabels({
          owner: client.owner,
          repo: client.repo,
          issue_number: issueNum,
          labels: ['result:completed', 'lifecycle:completed'],
        })
        closedIssues.push(issueNum)
        updatedLabels.push(issueNum)
      } catch (err) {
        errors.push(`Failed to close phase issue #${issueNum}: ${(err as Error).message}`)
      }
    }
  }

  return { closedIssues, commentedIssues, updatedLabels, errors }
}

export async function transitionWorkflowIssue(
  issueNumber: number,
  addLabels: string[],
  removeLabels?: string[],
): Promise<{ success: boolean; error?: string }> {
  const client = await getClient()

  if (client.isDryRun) {
    console.log(`[DRY RUN] Would transition issue #${issueNumber}: +${addLabels.join(',')} ${removeLabels ? `-${removeLabels.join(',')}` : ''}`)
    return { success: true }
  }

  try {
    // Add new labels
    await client.octokit.issues.addLabels({
      owner: client.owner,
      repo: client.repo,
      issue_number: issueNumber,
      labels: addLabels,
    })

    // Remove old labels if specified
    if (removeLabels) {
      for (const label of removeLabels) {
        try {
          await client.octokit.issues.removeLabel({
            owner: client.owner,
            repo: client.repo,
            issue_number: issueNumber,
            name: label,
          })
        } catch {
          // Label may not exist; ignore removal errors
        }
      }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

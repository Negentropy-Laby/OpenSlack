import { describe, it, expect } from 'vitest'
import { Writable } from 'stream'
import React from 'react'
import { render, Box, Text } from '@openslack/tui'
import HomeView from '../views/HomeView.js'
import { mapHomeToViewModel } from '../view-models/home.js'
import { NavigationProvider } from '../navigation/context.js'

function createMockStdout(columns = 80, rows = 50) {
  const chunks: string[] = []
  const stdout = new Writable({
    write(chunk, _, cb) {
      chunks.push(String(chunk))
      cb()
    },
  }) as NodeJS.WriteStream
  Object.defineProperties(stdout, {
    columns: { value: columns, writable: true, configurable: true },
    rows: { value: rows, writable: true, configurable: true },
    isTTY: { value: false, configurable: true },
  })
  return { stdout, chunks }
}

describe('HomeView coordinate diagnostic', () => {
  it('renders with empty data and verifies line positions', async () => {
    const { stdout, chunks } = createMockStdout(80, 50)
    const model = mapHomeToViewModel()
    const instance = await render(
      React.createElement(NavigationProvider, null,
        React.createElement(HomeView, { model })
      ),
      { stdout, patchConsole: false },
    )
    await new Promise<void>((r) => setTimeout(r, 200))

    const output = chunks.join('')
    const lines = output.split('\n')

    // Verify basic structure
    expect(lines[0]).toContain('OpenSlack')
    expect(lines[1]).toContain('─')
    expect(lines[2]).toContain('Needs Attention')
    expect(lines[3]).toContain('Nothing needs attention right now')
    expect(lines[4]).toContain('─')
    expect(lines[5]).toContain('What do you want to do?')
    expect(lines[6]).toContain('Run a workflow')
    expect(lines[7]).toContain('Browse, preview, and execute workflows')
    expect(lines[8]).toContain('Review pull requests')
    expect(lines[9]).toContain('Check open PRs and merge readiness')
    expect(lines[10]).toContain('Approve pending items')
    expect(lines[11]).toContain('Resolve plans, merge requests, and effects')
    expect(lines[12]).toContain('Manage workflows')
    expect(lines[13]).toContain('Trust, dry-run, and lifecycle controls')
    expect(lines[14]).toContain('View recent activity')
    expect(lines[15]).toContain('See what happened across the system')
    expect(lines[16]).toContain('─')
    expect(lines[17]).toContain('Workflow Quick Actions')
    expect(lines[18]).toContain('Start a workflow')
    expect(lines[19]).toContain('Browse and execute a workflow')
    expect(lines[20]).toContain('Publish workflow to GitHub Issues')
    expect(lines[21]).toContain('Open the issues menu from workflows')
    expect(lines[22]).toContain('Review workflow lifecycle')
    expect(lines[23]).toContain('Inspect workflow runs and status')
    expect(lines[24]).toContain('Resolve paused workflow')
    expect(lines[25]).toContain('Resume workflows awaiting approval')
    expect(lines[26]).toContain('─')
    expect(lines[27]).toContain('Quick Navigation')
    expect(lines[28]).toContain('Dashboard')
    expect(lines[29]).toContain('PR Queue')
    expect(lines[30]).toContain('Workflows')
    expect(lines[31]).toContain('Approvals')
    expect(lines[32]).toContain('Status')
    expect(lines[33]).toContain('Activity')
    expect(lines[34]).toContain('Digest')
    expect(lines[35]).toContain('Handoffs')
    expect(lines[36]).toContain('Decisions')
    expect(lines[37]).toContain('Profile')
    expect(lines[38]).toContain('─')
    expect(lines[39]).toContain('Quit')

    // Verify total line count
    expect(lines.length).toBe(40)

    instance.unmount()
  })

  it('renders with attention items and verifies line positions', async () => {
    const { stdout, chunks } = createMockStdout(80, 50)
    const model = mapHomeToViewModel({
      shellData: {
        approvals: {
          pendingApprovals: [{ id: '1', category: 'plan', title: 'Test Plan', risk: 'low' }],
          summary: { plans: 1, mergeRequests: 0, workflowEffects: 0, githubReviews: 0 },
        },
        prQueue: { totalPRs: 0, blockedCount: 0, readyCount: 0, items: [] },
      },
    })
    const instance = await render(
      React.createElement(NavigationProvider, null,
        React.createElement(HomeView, { model })
      ),
      { stdout, patchConsole: false },
    )
    await new Promise<void>((r) => setTimeout(r, 200))

    const output = chunks.join('')
    const lines = output.split('\n')

    // Verify attention section structure
    expect(lines[0]).toContain('OpenSlack')
    expect(lines[1]).toContain('─')
    expect(lines[2]).toContain('Needs Attention')
    expect(lines[3]).toContain('Pending Approval')
    expect(lines[4]).toContain('Test Plan')
    expect(lines[5]).toContain('─')
    expect(lines[6]).toContain('What do you want to do?')

    instance.unmount()
  })
})

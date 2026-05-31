import { describe, it, expect } from 'vitest'
import { Writable } from 'stream'
import React from 'react'
import { render } from '@openslack/tui'
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
  it('renders with empty data and verifies 2-section layout', async () => {
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

    // Header
    expect(lines[0]).toContain('OpenSlack')
    expect(lines[1]).toContain('─')

    // Section 1: What do you want to do?
    expect(lines[2]).toContain('What do you want to do?')
    // Task 1: See what needs attention
    expect(lines[3]).toContain('See what needs attention')
    expect(lines[4]).toContain('View items needing immediate action')
    // Task 2: Start or continue work
    expect(lines[5]).toContain('Start or continue work')
    expect(lines[6]).toContain('Create tasks, claim issues, and work in isolated branches')
    // Task 3: Run or check a workflow
    expect(lines[7]).toContain('Run or check a workflow')
    expect(lines[8]).toContain('Browse, execute, and inspect workflow runs')
    // Task 4: Review and merge PRs
    expect(lines[9]).toContain('Review and merge PRs')
    expect(lines[10]).toContain('Check open PRs, run doctor, and merge when ready')
    // Task 5: Approve pending items
    expect(lines[11]).toContain('Approve pending items')
    expect(lines[12]).toContain('Approve plans, merge requests, and workflow effects')
    // Task 6: Maintain organization profile
    expect(lines[13]).toContain('Maintain organization profile')
    expect(lines[14]).toContain('Check, preview, and sync your organization profile')

    expect(lines[15]).toContain('─')

    // Section 2: Quick Navigation
    expect(lines[16]).toContain('Quick Navigation')
    // Nav items: Dashboard, Status, Activity, Digest, Workflows, Profile
    expect(lines[17]).toContain('Dashboard')
    expect(lines[18]).toContain('Status')
    expect(lines[19]).toContain('Activity')
    expect(lines[20]).toContain('Digest')
    expect(lines[21]).toContain('Workflows')
    expect(lines[22]).toContain('Profile')

    // Footer
    expect(lines[23]).toContain('─')
    expect(lines[24]).toContain('Quit')

    instance.unmount()
  })

  it('renders with attention items and verifies badge on task row', async () => {
    const { stdout, chunks } = createMockStdout(80, 50)
    const model = mapHomeToViewModel({
      shellData: {
        approvals: {
          pendingApprovals: [{ id: '1', category: 'plan', title: 'Test Plan', risk: 'low' }],
          summary: { plans: 1, mergeRequests: 0, workflowEffects: 0, githubReviews: 0 },
        },
        prQueue: { totalPRs: 2, blockedCount: 1, readyCount: 1, items: [
          { prNumber: 42, title: 'Fix bug', blockerCategory: 'checks', canMerge: false },
        ] },
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

    // Verify the output contains key structural elements
    expect(output).toContain('What do you want to do?')
    expect(output).toContain('See what needs attention')
    expect(output).toContain('Review and merge PRs')
    expect(output).toContain('Approve pending items')
    expect(output).toContain('Quick Navigation')

    // Verify attention badges are rendered
    // "See what needs attention" should have badge showing total attention items count
    expect(output).toContain('(2)') // 1 approval + 1 PR = 2 attention items
    // "Review and merge PRs" should show open PR count
    expect(output).toContain('(2)') // 2 open PRs
    // "Approve pending items" should show approval count
    expect(output).toContain('(1)') // 1 pending approval

    instance.unmount()
  })

  it('renders all 6 tasks with correct shortcuts', async () => {
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

    // Verify all 6 task labels are present
    expect(output).toContain('See what needs attention')
    expect(output).toContain('Start or continue work')
    expect(output).toContain('Run or check a workflow')
    expect(output).toContain('Review and merge PRs')
    expect(output).toContain('Approve pending items')
    expect(output).toContain('Maintain organization profile')

    // Verify shortcuts [1] through [6] for tasks
    expect(output).toContain('[1]')
    expect(output).toContain('[2]')
    expect(output).toContain('[3]')
    expect(output).toContain('[4]')
    expect(output).toContain('[5]')
    expect(output).toContain('[6]')

    instance.unmount()
  })

  it('renders nav items with correct shortcuts starting from 7', async () => {
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

    // Verify nav shortcuts [7], [8], [9], [0], [p], [r]
    expect(output).toContain('[7]')
    expect(output).toContain('[8]')
    expect(output).toContain('[9]')
    expect(output).toContain('[0]')
    expect(output).toContain('[p]')
    expect(output).toContain('[r]')

    // Verify nav labels
    expect(output).toContain('Dashboard')
    expect(output).toContain('Status')
    expect(output).toContain('Activity')
    expect(output).toContain('Digest')
    expect(output).toContain('Workflows')
    expect(output).toContain('Profile')

    instance.unmount()
  })
})

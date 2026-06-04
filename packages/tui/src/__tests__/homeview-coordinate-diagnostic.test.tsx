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
  it('renders with empty data and verifies grouped task layout', async () => {
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
    const indexOfLine = (text: string) => lines.findIndex((line) => line.includes(text))

    // Header
    expect(lines[0]).toContain('OpenSlack')
    expect(lines[1]).toContain('─')

    // Section 1: What do you want to do?
    expect(lines[2]).toContain('What do you want to do?')

    // Group header: Start Work (marginTop:1 adds blank line)
    // line 3: blank (marginTop)
    // line 4: ── Start Work ──
    expect(lines[4]).toContain('Start Work')
    // Task [2]: Start or continue work
    expect(lines[5]).toContain('Start or continue work')
    expect(lines[6]).toContain('Create tasks, claim issues, and work in isolated branches')
    // Dynamic workflow start/watch/reuse entries stay in the Start Work group.
    expect(lines[7]).toContain('Start a Dynamic Workflow')
    expect(lines[8]).toContain('Generate from prompt, choose a pattern, or run a saved workflow')
    expect(lines[9]).toContain('Watch workflow runs')
    expect(lines[10]).toContain('Inspect run, phase, agent, transcript, and budget evidence')
    expect(lines[11]).toContain('Reuse workflow assets')
    expect(lines[12]).toContain('Save, export as skill, or publish workflow proposals')

    const reviewHeader = indexOfLine('Review Work')
    expect(reviewHeader).toBeGreaterThan(indexOfLine('Reuse workflow assets'))
    expect(lines[reviewHeader + 1]).toContain('See what needs attention')
    expect(lines[reviewHeader + 2]).toContain('View items needing immediate action')
    expect(lines[reviewHeader + 3]).toContain('Review and merge PRs')
    expect(lines[reviewHeader + 4]).toContain('Check open PRs, run doctor, and merge when ready')
    expect(lines[reviewHeader + 5]).toContain('View active conversations')
    expect(lines[reviewHeader + 6]).toContain('Browse agent conversation threads and messages')

    const governHeader = indexOfLine('Govern Actions')
    expect(governHeader).toBeGreaterThan(reviewHeader)
    expect(lines[governHeader + 1]).toContain('Approve pending items')
    expect(lines[governHeader + 2]).toContain('Approve plans, merge requests, and workflow effects')

    const maintainHeader = indexOfLine('Maintain Profile')
    expect(maintainHeader).toBeGreaterThan(governHeader)
    expect(lines[maintainHeader + 1]).toContain('Maintain organization profile')
    expect(lines[maintainHeader + 2]).toContain('Check, preview, and sync your organization profile')

    const quickNavHeader = indexOfLine('Quick Navigation')
    expect(quickNavHeader).toBeGreaterThan(maintainHeader)

    // Section 2: Quick Navigation
    expect(lines[quickNavHeader]).toContain('Quick Navigation')
    // Nav items: Dashboard, Status, Activity, Digest, Workflows, Workflow Runs, Profile, Conversations
    expect(lines[quickNavHeader + 1]).toContain('Dashboard')
    expect(lines[quickNavHeader + 2]).toContain('Status')
    expect(lines[quickNavHeader + 3]).toContain('Activity')
    expect(lines[quickNavHeader + 4]).toContain('Digest')
    expect(lines[quickNavHeader + 5]).toContain('Workflows')
    expect(lines[quickNavHeader + 6]).toContain('Workflow Runs')
    expect(lines[quickNavHeader + 7]).toContain('Profile')
    expect(lines[quickNavHeader + 8]).toContain('Conversations')

    // Footer
    const footer = indexOfLine('Quit')
    expect(footer).toBeGreaterThan(quickNavHeader)
    expect(lines[footer]).toContain('Quit')

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

  it('renders all 9 tasks with correct shortcuts', async () => {
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

    // Verify all 9 task labels are present
    expect(output).toContain('See what needs attention')
    expect(output).toContain('Start or continue work')
    expect(output).toContain('Start a Dynamic Workflow')
    expect(output).toContain('Watch workflow runs')
    expect(output).toContain('Reuse workflow assets')
    expect(output).toContain('Review and merge PRs')
    expect(output).toContain('Approve pending items')
    expect(output).toContain('Maintain organization profile')
    expect(output).toContain('View active conversations')

    // Verify shortcuts [1] through [6] for tasks, plus workflow [w]/[s] and [c] for conversations
    expect(output).toContain('[1]')
    expect(output).toContain('[2]')
    expect(output).toContain('[3]')
    expect(output).toContain('[w]')
    expect(output).toContain('[s]')
    expect(output).toContain('[4]')
    expect(output).toContain('[5]')
    expect(output).toContain('[6]')
    expect(output).toContain('[c]')

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

    // Verify nav shortcuts [7], [8], [9], [0], [p], [w], [r], [c]
    expect(output).toContain('[7]')
    expect(output).toContain('[8]')
    expect(output).toContain('[9]')
    expect(output).toContain('[0]')
    expect(output).toContain('[p]')
    expect(output).toContain('[w]')
    expect(output).toContain('[r]')
    expect(output).toContain('[c]')

    // Verify nav labels
    expect(output).toContain('Dashboard')
    expect(output).toContain('Status')
    expect(output).toContain('Activity')
    expect(output).toContain('Digest')
    expect(output).toContain('Workflows')
    expect(output).toContain('Workflow Runs')
    expect(output).toContain('Profile')
    expect(output).toContain('Conversations')

    instance.unmount()
  })
})

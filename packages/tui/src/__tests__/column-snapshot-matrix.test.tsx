/**
 * column-snapshot-matrix.test.tsx -- Column snapshot matrix tests.
 *
 * Renders all 7 key TUI views at 80, 100, and 120 columns, then asserts:
 * 1. Output contains expected key markers (view-specific content).
 * 2. No rendered line exceeds the column width (using stringWidth for accurate CJK/emoji).
 *
 * These tests guard against layout regressions when terminal width changes.
 */
import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from '@openslack/tui'
import { NavigationProvider } from '../navigation/context.js'

import HomeView from '../views/HomeView.js'
import DoctorView from '../views/DoctorView.js'
import PrQueueView from '../views/PrQueueView.js'
import ProfileView from '../views/ProfileView.js'
import WorkflowLifecycleView from '../views/WorkflowLifecycleView.js'
import WorkflowWorkbenchView from '../views/WorkflowWorkbenchView.js'
import DashboardView from '../views/DashboardView.js'

import {
  createHomeViewModel,
  createDoctorViewModel,
  createPrQueueViewModel,
  createProfileViewModel,
  createWorkflowLifecycleViewModel,
  createWorkflowWorkbenchViewModel,
  createDashboardViewModel,
} from './helpers/view-model-factories.js'
import { assertNoLineExceedsWidth } from './helpers/render-at-columns.js'

import { Writable } from 'stream'
import stripAnsi from 'strip-ansi'
import { stringWidth } from '../ink/stringWidth.js'

function createMockStdout(columns: number, rows = 50) {
  const chunks: string[] = []
  const stdout = new Writable({
    write(chunk: Buffer | string, _encoding: string, cb: () => void) {
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

/**
 * Render a React element at the given column width and return the output string.
 */
async function renderAt(element: React.ReactElement, cols: number): Promise<string> {
  const { stdout, chunks } = createMockStdout(cols)
  const instance = await render(element, { stdout, patchConsole: false })
  await new Promise((r) => setTimeout(r, 200))
  const output = chunks.join('')
  instance.unmount()
  return output
}

/**
 * Wrap an element in NavigationProvider (needed by views that call useNavigation).
 */
function withNav(element: React.ReactElement): React.ReactElement {
  return React.createElement(NavigationProvider, null, element)
}

// ── Column widths under test ──
const COLUMN_WIDTHS = [80, 100, 120] as const

// ── Snapshot matrix ──

describe.each(COLUMN_WIDTHS)('at %d columns', (cols) => {
  it('HomeView renders within width and contains key markers', async () => {
    const model = createHomeViewModel()
    const output = await renderAt(
      withNav(React.createElement(HomeView, { model })),
      cols,
    )

    expect(output).toContain('OpenSlack')
    expect(output).toContain('ready')
    expect(output).toContain('What do you want to do?')
    expect(output).toContain('See what needs attention')
    expect(output).toContain('Start or continue work')
    expect(output).toContain('Review and merge PRs')
    expect(output).toContain('Quick Navigation')
    expect(output).toContain('Dashboard')
    assertNoLineExceedsWidth(output, cols)
  })

  it('DoctorView renders within width and contains key markers', async () => {
    const model = createDoctorViewModel()
    const output = await renderAt(
      React.createElement(DoctorView, { model }),
      cols,
    )

    expect(output).toContain('Doctor Report')
    expect(output).toContain('#42')
    expect(output).toContain('Gates')
    expect(output).toContain('READY_TO_MERGE')
    expect(output).toContain('All gates passed')
    expect(output).toContain('Checks')
    expect(output).toContain('Reviews')
    assertNoLineExceedsWidth(output, cols)
  })

  it('PrQueueView renders within width and contains key markers', async () => {
    const model = createPrQueueViewModel()
    const output = await renderAt(
      React.createElement(PrQueueView, { model }),
      cols,
    )

    expect(output).toContain('PR Queue')
    expect(output).toContain('Total: 2')
    expect(output).toContain('Ready: 1')
    expect(output).toContain('Blocked: 1')
    expect(output).toContain('#127')
    expect(output).toContain('#130')
    expect(output).toContain('Pull Requests')
    assertNoLineExceedsWidth(output, cols)
  })

  it('ProfileView renders within width and contains key markers', async () => {
    const model = createProfileViewModel()
    const output = await renderAt(
      React.createElement(ProfileView, { model }),
      cols,
    )

    expect(output).toContain('Organization Profile')
    expect(output).toContain('Sync Status')
    expect(output).toContain('synced')
    expect(output).toContain('Validation')
    expect(output).toContain('Actions')
    assertNoLineExceedsWidth(output, cols)
  })

  it('WorkflowLifecycleView renders within width and contains key markers', async () => {
    const model = createWorkflowLifecycleViewModel()
    const output = await renderAt(
      withNav(React.createElement(WorkflowLifecycleView, { model })),
      cols,
    )

    expect(output).toContain('Lifecycle')
    expect(output).toContain('test-workflow')
    expect(output).toContain('Lifecycle Stages')
    expect(output).toContain('Proposal')
    expect(output).toContain('Review')
    expect(output).toContain('Run')
    expect(output).toContain('PR')
    expect(output).toContain('Merged')
    assertNoLineExceedsWidth(output, cols)
  })

  it('WorkflowWorkbenchView renders within width and contains key markers', async () => {
    const model = createWorkflowWorkbenchViewModel()
    const output = await renderAt(
      withNav(React.createElement(WorkflowWorkbenchView, { galleryModel: model })),
      cols,
    )

    expect(output).toContain('Workflows')
    expect(output).toContain('Workflow Gallery')
    expect(output).toContain('test-workflow')
    expect(output).toContain('deploy-workflow')
    expect(output).toContain('2 workflows')
    assertNoLineExceedsWidth(output, cols)
  })

  it('DashboardView renders within width and contains key markers', async () => {
    const model = createDashboardViewModel()
    const output = await renderAt(
      React.createElement(DashboardView, { model }),
      cols,
    )

    expect(output).toContain('Team Dashboard')
    expect(output).toContain('Blockers: 1')
    expect(output).toContain('Handoffs: 1')
    expect(output).toContain('Decisions: 1')
    expect(output).toContain('PR #130')
    expect(output).toContain('Recent Activity')
    assertNoLineExceedsWidth(output, cols)
  })
})

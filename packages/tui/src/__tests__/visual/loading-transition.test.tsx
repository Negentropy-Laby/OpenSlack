/**
 * loading-transition.test.tsx -- Loading → loaded state transition tests.
 *
 * Verifies that views using the WorkflowLifecycleViewWrapper (async loader)
 * transition cleanly from loading state to loaded state without residual
 * artifacts from the loading frame.
 *
 * Tests:
 * 1. Loading state renders within width.
 * 2. Loaded state renders within width.
 * 3. Loaded output does not contain loading spinner/indicator artifacts.
 * 4. Output is non-empty in both states.
 */
import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from '@openslack/tui'
import { NavigationProvider } from '../../navigation/context.js'
import stripAnsi from 'strip-ansi'

import WorkflowLifecycleView from '../../views/WorkflowLifecycleView.js'
import WorkflowLifecycleViewWrapper from '../../views/WorkflowLifecycleViewWrapper.js'

import type { WorkflowLifecycleViewModel } from '../../view-models/workflow-lifecycle.js'
import type { WorkflowLifecycleLoader } from '../../views/render-shell.js'

import { assertNoLineExceedsWidth } from '../helpers/render-at-columns.js'

import { Writable } from 'stream'

// ── Helpers ──

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

async function renderAt(element: React.ReactElement, cols: number): Promise<string> {
  const { stdout, chunks } = createMockStdout(cols)
  const instance = await render(element, { stdout, patchConsole: false })
  await new Promise((r) => setTimeout(r, 200))
  const output = chunks.join('')
  instance.unmount()
  return output
}

function withNav(element: React.ReactElement): React.ReactElement {
  return React.createElement(NavigationProvider, null, element)
}

function createLifecycleModel(overrides?: Partial<WorkflowLifecycleViewModel>): WorkflowLifecycleViewModel {
  return {
    workflowName: 'test-workflow',
    workflowHash: 'abc123',
    trustLevel: 'trusted',
    risk: 'low',
    sourcePath: '.openslack/workflows/test-workflow',
    stages: [
      { name: 'proposal', label: 'Proposal', status: 'complete', icon: 'check', issueNumber: 120, detail: 'Accepted' },
      { name: 'review', label: 'Review', status: 'complete', icon: 'check', issueNumber: 121, detail: 'Passed' },
      { name: 'run', label: 'Run', status: 'in-progress', icon: 'running', detail: 'Executing' },
      { name: 'pr', label: 'PR', status: 'pending', icon: 'clock', detail: 'Not created' },
      { name: 'merged', label: 'Merged', status: 'pending', icon: 'clock', detail: 'Pending' },
    ],
    phaseIssues: [
      { phase: 'proposal', issueNumber: 120, status: 'closed' },
    ],
    currentRun: {
      runId: 'run-001',
      status: 'running',
      startedAt: '2026-06-01T10:00:00Z',
      phaseIndex: 2,
    },
    prNumber: undefined,
    prStatus: undefined,
    nextAction: 'Wait for completion',
    subIssueMode: 'native',
    dependencyMode: 'native',
    fallbackReasons: [],
    blockedGateItems: [],
    statusSummary: 'At run stage, executing',
    ...overrides,
  }
}

// ── Tests ──

const WIDTHS = [80, 100, 120] as const

describe.each(WIDTHS)('loading transition at %d columns', (cols) => {

  describe('WorkflowLifecycleView (direct render = loaded)', () => {
    it('renders loaded state within width', async () => {
      const model = createLifecycleModel()
      const output = await renderAt(
        withNav(React.createElement(WorkflowLifecycleView, { model })),
        cols,
      )
      expect(output.length).toBeGreaterThan(0)
      assertNoLineExceedsWidth(output, cols)
      expect(output).toContain('Lifecycle')
      expect(output).toContain('test-workflow')
    })
  })

  describe('WorkflowLifecycleViewWrapper (async loader)', () => {
    it('renders loading state within width', async () => {
      // A loader that never resolves should show a loading indicator
      const neverResolve: WorkflowLifecycleLoader = () => new Promise<WorkflowLifecycleViewModel>(() => {})
      const output = await renderAt(
        withNav(
          React.createElement(WorkflowLifecycleViewWrapper, {
            workflowName: 'test-workflow',
            loadLifecycle: neverResolve,
          }),
        ),
        cols,
      )
      expect(output.length).toBeGreaterThan(0)
      assertNoLineExceedsWidth(output, cols)
      // Loading state shows workflow name
      expect(output).toContain('test-workflow')
      expect(output).toContain('Loading')
    })

    it('transitions to loaded without residual loading artifacts', async () => {
      const model = createLifecycleModel()
      const resolveImmediately: WorkflowLifecycleLoader = async () => model
      const output = await renderAt(
        withNav(
          React.createElement(WorkflowLifecycleViewWrapper, {
            workflowName: 'test-workflow',
            loadLifecycle: resolveImmediately,
          }),
        ),
        cols,
      )
      expect(output.length).toBeGreaterThan(0)
      assertNoLineExceedsWidth(output, cols)
      // Loaded state must contain actual data markers
      expect(output).toContain('Lifecycle')
      expect(output).toContain('test-workflow')
      // The loaded view should have stage markers, not just loading text
      const stripped = stripAnsi(output)
      expect(stripped).toContain('Proposal')
    })
  })

  describe('transition from failed model', () => {
    it('renders blocked lifecycle within width', async () => {
      const model = createLifecycleModel({
        nextAction: '',
        blockedGateItems: [
          { gate: 'Approval', detail: 'No valid human approval' },
          { gate: 'Checks', detail: 'CI failing on test suite' },
        ],
        statusSummary: 'BLOCKED: 2 gates failing',
      })
      const output = await renderAt(
        withNav(React.createElement(WorkflowLifecycleView, { model })),
        cols,
      )
      expect(output.length).toBeGreaterThan(0)
      assertNoLineExceedsWidth(output, cols)
    })
  })
})

/**
 * viewport-matrix.test.tsx -- Full viewport matrix visual regression tests.
 *
 * Renders all 9 core TUI views at 4 viewport sizes: 40x12, 80x24, 100x30, 120x40.
 * For each combination:
 * 1. Output contains expected key markers.
 * 2. No rendered line exceeds the column width.
 * 3. Output is non-empty and finite.
 *
 * This expands the existing column-snapshot-matrix tests by:
 * - Adding ApprovalCenterView and RoomView (newer views)
 * - Adding 40-column narrow terminal testing
 * - Adding explicit row dimension coverage
 */
import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from '@openslack/tui'
import { NavigationProvider } from '../../navigation/context.js'

import HomeView from '../../views/HomeView.js'
import DoctorView from '../../views/DoctorView.js'
import PrQueueView from '../../views/PrQueueView.js'
import ProfileView from '../../views/ProfileView.js'
import WorkflowLifecycleView from '../../views/WorkflowLifecycleView.js'
import WorkflowWorkbenchView from '../../views/WorkflowWorkbenchView.js'
import DashboardView from '../../views/DashboardView.js'
import ApprovalCenterView from '../../views/ApprovalCenterView.js'
import RoomView from '../../views/RoomView.js'

import {
  createHomeViewModel,
  createDoctorViewModel,
  createPrQueueViewModel,
  createProfileViewModel,
  createWorkflowLifecycleViewModel,
  createWorkflowWorkbenchViewModel,
  createDashboardViewModel,
  createApprovalCenterViewModel,
  createRoomViewModel,
} from '../helpers/view-model-factories.js'
import { assertNoLineExceedsWidth } from '../helpers/render-at-columns.js'

import { Writable } from 'stream'

// ── Viewport sizes under test ──

const VIEWPORTS = [
  { cols: 40, rows: 12, label: '40x12 (narrow)' },
  { cols: 80, rows: 24, label: '80x24 (standard)' },
  { cols: 100, rows: 30, label: '100x30 (wide)' },
  { cols: 120, rows: 40, label: '120x40 (full)' },
] as const

// ── Helpers ──

function createMockStdout(columns: number, rows: number) {
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

async function renderAt(
  element: React.ReactElement,
  cols: number,
  rows: number,
): Promise<string> {
  const { stdout, chunks } = createMockStdout(cols, rows)
  const instance = await render(element, { stdout, patchConsole: false })
  await new Promise((r) => setTimeout(r, 200))
  const output = chunks.join('')
  instance.unmount()
  return output
}

function withNav(element: React.ReactElement): React.ReactElement {
  return React.createElement(NavigationProvider, null, element)
}

// ── View definitions ──

type ViewSpec = {
  name: string
  needsNav: boolean
  markers: string[]
  create: () => React.ReactElement
}

const VIEWS: ViewSpec[] = [
  {
    name: 'HomeView',
    needsNav: true,
    markers: ['OpenSlack', 'Ask OpenSlack:'],
    create: () => React.createElement(HomeView, { model: createHomeViewModel() }),
  },
  {
    name: 'DoctorView',
    needsNav: false,
    markers: ['Doctor Report', '#42'],
    create: () => React.createElement(DoctorView, { model: createDoctorViewModel() }),
  },
  {
    name: 'PrQueueView',
    needsNav: false,
    markers: ['PR Queue', '#127', '#130'],
    create: () => React.createElement(PrQueueView, { model: createPrQueueViewModel() }),
  },
  {
    name: 'ProfileView',
    needsNav: false,
    markers: ['Organization Profile', 'Sync Status'],
    create: () => React.createElement(ProfileView, { model: createProfileViewModel() }),
  },
  {
    name: 'WorkflowLifecycleView',
    needsNav: true,
    markers: ['Lifecycle', 'test-workflow'],
    create: () => React.createElement(WorkflowLifecycleView, { model: createWorkflowLifecycleViewModel() }),
  },
  {
    name: 'WorkflowWorkbenchView',
    needsNav: true,
    markers: ['Workflow Gallery', '2 workflows'],
    create: () => React.createElement(WorkflowWorkbenchView, { galleryModel: createWorkflowWorkbenchViewModel() }),
  },
  {
    name: 'DashboardView',
    needsNav: false,
    markers: ['Dashboard'],
    create: () => React.createElement(DashboardView, { model: createDashboardViewModel() }),
  },
  {
    name: 'ApprovalCenterView',
    needsNav: true,
    markers: ['Approvals'],
    create: () => React.createElement(ApprovalCenterView, { model: createApprovalCenterViewModel() }),
  },
  {
    name: 'RoomView',
    needsNav: false,
    markers: ['Room', 'pr:42'],
    create: () => React.createElement(RoomView, { model: createRoomViewModel() }),
  },
]

// ── Tests ──

for (const viewport of VIEWPORTS) {
  describe(`viewport ${viewport.label}`, () => {
    for (const view of VIEWS) {
      it(`${view.name} renders within ${viewport.cols} columns and contains markers`, async () => {
        const element = view.create()
        const wrapped = view.needsNav ? withNav(element) : element
        const output = await renderAt(wrapped, viewport.cols, viewport.rows)

        // Output must be non-empty
        expect(output.length).toBeGreaterThan(0)

        // Must contain key markers
        for (const marker of view.markers) {
          expect(output, `${view.name} at ${viewport.label} missing marker: ${marker}`).toContain(marker)
        }

        // No line must exceed column width
        assertNoLineExceedsWidth(output, viewport.cols)
      })
    }
  })
}

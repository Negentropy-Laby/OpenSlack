import { describe, expect, it } from 'vitest'
import { Writable } from 'stream'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { render } from '@openslack/tui'
import { NavigationProvider } from '../navigation/context.js'
import WorkflowLifecycleViewWrapper from '../views/WorkflowLifecycleViewWrapper.js'
import DigestView from '../views/DigestView.js'
import { mapWorkflowLifecycleToViewModel } from '../view-models/workflow-lifecycle.js'
import sliceAnsi from '../utils/slice-ansi.js'
import { stringWidth } from '../ink/stringWidth.js'
import wrapText from '../ink/wrap-text.js'
import { LogUpdate } from '../ink/log-update.js'
import type { Frame } from '../ink/frame.js'
import {
  CharPool,
  HyperlinkPool,
  StylePool,
  createScreen,
  setCellAt,
} from '../ink/screen.js'
import type { CellWidth } from '../ink/screen.js'

function createMockStdout(columns = 80, rows = 24) {
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

function makeFrame(lines: string[], width = 40, rows = 12): { frame: Frame; stylePool: StylePool } {
  const stylePool = new StylePool()
  const screen = createScreen(
    width,
    lines.length,
    stylePool,
    new CharPool(),
    new HyperlinkPool(),
  )

  for (let y = 0; y < lines.length; y++) {
    let x = 0
    for (const char of lines[y]!) {
      const width = stringWidth(char)
      setCellAt(screen, x, y, {
        char,
        styleId: stylePool.none,
        width: (width === 2 ? 1 : 0) as CellWidth,
        hyperlink: undefined,
      })
      x += width
    }
  }

  return {
    stylePool,
    frame: {
      screen,
      viewport: { width, height: rows },
      cursor: { x: 0, y: Math.max(0, lines.length - 1), visible: true },
    },
  }
}

describe('terminal layout regressions', () => {
  it('measures ambiguous symbols, emoji, and CJK using terminal cell width', () => {
    expect(stringWidth('warning ⚠')).toBe(10)
    expect(stringWidth('ok ✅')).toBe(5)
    expect(stringWidth('阶段A')).toBe(5)
    expect(stringWidth('PR #125')).toBe(7)
  })

  it('does not slice a wide character across a visual cell boundary', () => {
    expect(sliceAnsi('A你B', 0, 2)).toBe('A')
    expect(sliceAnsi('你B', 0, 1)).toBe('')
    expect(stringWidth(sliceAnsi('\x1b[31m你\x1b[0mB', 0, 2))).toBe(2)
  })

  it('wraps mixed ANSI, emoji, and CJK lines within the requested width', () => {
    const wrapped = wrapText('Issue \x1b[32m标题\x1b[0m mixed ✅ text', 10, 'wrap')
    for (const line of wrapped.split('\n')) {
      expect(stringWidth(line)).toBeLessThanOrEqual(10)
    }
  })

  it('clears trailing rows when append-only output shrinks', () => {
    const { frame: longFrame, stylePool } = makeFrame(['Header', 'Old tail', 'Stale row'])
    const { frame: shortFrame } = makeFrame(['Header'])
    const logUpdate = new LogUpdate({ isTTY: false, stylePool })

    logUpdate.render(longFrame, longFrame)
    const diff = logUpdate.render(longFrame, shortFrame)
    const content = diff.map(op => ('content' in op ? op.content : '')).join('')

    expect(content).toContain('Header')
    expect(content).toContain('\x1b[K')
    expect(stripAnsi(content)).not.toContain('Stale row')
  })

  it('clears stale same-line suffix when append-only output shrinks within a row', () => {
    const { frame: longFrame, stylePool } = makeFrame(['Review pull requests', 'Check open PRs and merge readiness'])
    const { frame: shortFrame } = makeFrame(['Review pull requests', 'Check open PRs'])
    const logUpdate = new LogUpdate({ isTTY: false, stylePool })

    logUpdate.render(longFrame, longFrame)
    const diff = logUpdate.render(longFrame, shortFrame)
    const content = diff.map(op => ('content' in op ? op.content : '')).join('')

    expect(content).toContain('Check open PRs')
    expect(content).toContain('\x1b[K')
    expect(stripAnsi(content)).not.toContain('merge readiness')
  })

  it('renders digest groups without React key warnings', async () => {
    const { stdout } = createMockStdout(100, 30)
    const errors: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    }
    try {
      const instance = await render(
        React.createElement(DigestView, {
          model: {
            title: 'OpenSlack Digest',
            periodHours: 24,
            totalEvents: 2,
            groups: [
              {
                label: 'Needs Human',
                count: 1,
                status: 'warn',
                events: [
                  {
                    time: '12:00',
                    type: 'pr.merge.requested',
                    summary: 'Request review from an independent human reviewer.',
                    objectKind: 'pr',
                    objectId: '127',
                  },
                ],
              },
              {
                label: 'Blocked',
                count: 1,
                status: 'fail',
                events: [
                  {
                    time: '12:01',
                    type: 'task.blocked',
                    summary: 'Needs attention',
                    objectKind: 'issue',
                    objectId: '12',
                  },
                ],
              },
            ],
            recommendedNext: [],
          },
        }),
        { stdout, patchConsole: false },
      )
      instance.unmount()
    } finally {
      console.error = originalError
    }
    expect(errors.join('\n')).not.toContain('unique "key" prop')
  })

  it('redraws workflow lifecycle after async loader data arrives', async () => {
    let resolveLoader: ((value: ReturnType<typeof mapWorkflowLifecycleToViewModel>) => void) | undefined
    const loader = new Promise<ReturnType<typeof mapWorkflowLifecycleToViewModel>>(resolve => {
      resolveLoader = resolve
    })
    const { stdout, chunks } = createMockStdout(100, 30)
    const instance = await render(
      React.createElement(
        NavigationProvider,
        null,
        React.createElement(WorkflowLifecycleViewWrapper, {
          workflowName: 'unicode-workflow',
          baseData: {
            workflowHash: 'abc123',
            trustLevel: 'trusted',
            risk: 'medium',
            sourcePath: '.openslack/workflows/unicode-workflow',
          },
          loadLifecycle: async () => loader,
        }),
      ),
      { stdout, patchConsole: false },
    )

    await new Promise<void>(r => setTimeout(r, 50))
    expect(chunks.join('')).toContain('Loading lifecycle data')

    resolveLoader?.(
      mapWorkflowLifecycleToViewModel({
        workflowName: 'unicode-workflow',
        workflowHash: 'abc123',
        trustLevel: 'trusted',
        risk: 'medium',
        sourcePath: '.openslack/workflows/unicode-workflow',
        stages: [
          {
            name: 'proposal',
            label: 'Proposal',
            status: 'complete',
            icon: '✓',
            issueNumber: 125,
            detail: 'Proposal issue #125',
          },
        ],
        phaseIssues: [],
        nextAction: 'Lifecycle complete',
      }),
    )

    await new Promise<void>(r => setTimeout(r, 200))
    const output = chunks.join('')
    expect(output).toContain('Proposal issue #125')
    expect(output).toContain('Lifecycle complete')
    instance.unmount()
  })
})

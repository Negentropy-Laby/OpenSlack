import { describe, it, expect, afterEach } from 'vitest'
import { Writable } from 'stream'
import React from 'react'
import { render } from '@openslack/tui'
import { ThemeProvider } from '../design-system/ThemeProvider.js'
import WorkflowPreviewView from '../views/WorkflowPreviewView.js'
import type { WorkflowPreviewViewModel } from '../view-models/workflow-preview.js'

function makeModel(overrides?: Partial<WorkflowPreviewViewModel>): WorkflowPreviewViewModel {
  return {
    templateId: 'test-workflow',
    name: 'Test Workflow',
    correlationId: 'WF-test-20260528-ABC123',
    steps: [
      { phase: 'Setup', type: 'action', title: 'Run setup', actionId: 'setup-action', sideEffects: false, requiresConfirmation: false, requiredRole: '' },
      { phase: 'Execute', type: 'action', title: 'Execute task', actionId: 'exec-action', sideEffects: true, requiresConfirmation: true, requiredRole: 'admin' },
    ],
    phases: ['Setup', 'Execute'],
    phaseCount: 2,
    stepCount: 2,
    hasSideEffects: true,
    requiresConfirmation: true,
    errors: [],
    hasErrors: false,
    ...overrides,
  }
}

describe('WorkflowPreviewView', () => {
  let instance: { unmount: () => void } | null = null

  afterEach(() => {
    instance?.unmount()
    instance = null
  })

  async function renderView(model: WorkflowPreviewViewModel): Promise<string> {
    const chunks: string[] = []
    const stdout = new Writable({ write(chunk, _, cb) { chunks.push(String(chunk)); cb() } }) as NodeJS.WriteStream
    Object.defineProperties(stdout, {
      columns: { value: 80, configurable: true },
      rows: { value: 24, configurable: true },
      isTTY: { value: false, configurable: true },
    })

    instance = await render(
      React.createElement(ThemeProvider, { mode: 'dark' },
        React.createElement(WorkflowPreviewView, { model }),
      ),
      { stdout, patchConsole: false },
    )

    await new Promise(r => setTimeout(r, 150))
    return chunks.join('')
  }

  it('renders header with workflow name', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('Workflow: Test Workflow')
  })

  it('renders template ID and correlation ID', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('test-workflow')
    expect(output).toContain('WF-test-20260528-ABC123')
  })

  it('renders step count and phase count in summary', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('2 steps')
    expect(output).toContain('2 phases')
  })

  it('renders phase headers', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('Setup')
    expect(output).toContain('Execute')
  })

  it('renders step titles', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('Run setup')
    expect(output).toContain('Execute task')
  })

  it('renders side effects indicator', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('side effect')
  })

  it('renders confirmation indicator', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('confirmation')
  })

  it('renders role requirement', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('role:admin')
  })

  it('renders with empty steps without crashing', async () => {
    const output = await renderView(makeModel({
      steps: [],
      phases: [],
      phaseCount: 0,
      stepCount: 0,
      hasSideEffects: false,
      requiresConfirmation: false,
    }))
    expect(output).toContain('Workflow: Test Workflow')
    expect(output).toContain('0 steps')
    expect(output).toContain('No steps')
  })

  it('renders with errors', async () => {
    const output = await renderView(makeModel({
      errors: ['Missing required input: repo', 'Invalid action ID'],
      hasErrors: true,
    }))
    expect(output).toContain('Missing required input: repo')
    expect(output).toContain('Invalid action ID')
  })

  it('renders read-only badge when no side effects', async () => {
    const output = await renderView(makeModel({
      steps: [
        { phase: 'Plan', type: 'action', title: 'Preview plan', actionId: 'plan-action', sideEffects: false, requiresConfirmation: false, requiredRole: '' },
      ],
      phases: ['Plan'],
      phaseCount: 1,
      stepCount: 1,
      hasSideEffects: false,
      requiresConfirmation: false,
    }))
    expect(output).toContain('Read-only')
  })

  it('renders exit keyboard shortcut in footer', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('q')
    expect(output).toContain('exit')
  })

  it('renders with single phase containing many steps', async () => {
    const steps = Array.from({ length: 5 }, (_, i) => ({
      phase: 'Build',
      type: 'action',
      title: `Step ${i + 1}`,
      actionId: `step-${i}`,
      sideEffects: false,
      requiresConfirmation: false,
      requiredRole: '',
    }))
    const output = await renderView(makeModel({
      steps,
      phases: ['Build'],
      phaseCount: 1,
      stepCount: 5,
      hasSideEffects: false,
      requiresConfirmation: false,
    }))
    expect(output).toContain('5 steps')
    expect(output).toContain('1 phases')
    for (let i = 1; i <= 5; i++) {
      expect(output).toContain(`Step ${i}`)
    }
  })

  it('renders with decision-gate step type', async () => {
    const output = await renderView(makeModel({
      steps: [
        { phase: 'Review', type: 'decision-gate', title: 'Require human approval', actionId: '', sideEffects: false, requiresConfirmation: true, requiredRole: 'reviewer' },
      ],
      phases: ['Review'],
      phaseCount: 1,
      stepCount: 1,
      hasSideEffects: false,
      requiresConfirmation: true,
    }))
    expect(output).toContain('Require human approval')
    expect(output).toContain('confirmation')
    expect(output).toContain('role:reviewer')
  })

  it('renders with handoff step type', async () => {
    const output = await renderView(makeModel({
      steps: [
        { phase: 'Handoff', type: 'handoff', title: 'Handoff from agent-1 to agent-2', actionId: '', sideEffects: true, requiresConfirmation: false, requiredRole: '' },
      ],
      phases: ['Handoff'],
      phaseCount: 1,
      stepCount: 1,
      hasSideEffects: true,
      requiresConfirmation: false,
    }))
    expect(output).toContain('Handoff from agent-1 to agent-2')
  })

  it('renders with wait step type', async () => {
    const output = await renderView(makeModel({
      steps: [
        { phase: 'Wait', type: 'wait', title: 'Wait for CI', actionId: '', sideEffects: false, requiresConfirmation: false, requiredRole: '' },
      ],
      phases: ['Wait'],
      phaseCount: 1,
      stepCount: 1,
      hasSideEffects: false,
      requiresConfirmation: false,
    }))
    expect(output).toContain('Wait for CI')
  })
})

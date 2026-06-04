import { describe, it, expect } from 'vitest'

describe('navigation and shell source exports', () => {
  it('exports renderShellTui from render-shell', async () => {
    const mod = await import('../views/render-shell.js')
    expect(mod.renderShellTui).toBeDefined()
    expect(typeof mod.renderShellTui).toBe('function')
  })

  it('exports NavigationProvider and useNavigation from context', async () => {
    const mod = await import('../navigation/context.js')
    expect(mod.NavigationProvider).toBeDefined()
    expect(mod.useNavigation).toBeDefined()
    expect(typeof mod.useNavigation).toBe('function')
  })

  it('exports HOME_ROUTE from context', async () => {
    const mod = await import('../navigation/context.js')
    expect(mod.HOME_ROUTE).toBeDefined()
    expect(mod.HOME_ROUTE.view).toBe('home')
  })

  it('exports Route and RouterState types from router', async () => {
    const mod = await import('../navigation/router.js')
    // Runtime values, not types
    expect(mod.HOME_ROUTE).toBeDefined()
    expect(mod.createInitialRouterState).toBeDefined()
    expect(typeof mod.createInitialRouterState).toBe('function')
  })

  it('exports SelectableList from design system', async () => {
    const mod = await import('../design-system/SelectableList.js')
    expect(mod.default).toBeDefined()
  })

  it('exports mapHomeToViewModel from view models', async () => {
    const mod = await import('../view-models/home.js')
    expect(mod.mapHomeToViewModel).toBeDefined()
    expect(typeof mod.mapHomeToViewModel).toBe('function')
  })
})

describe('mapHomeToViewModel', () => {
  it('returns nav items with correct keys', async () => {
    const { mapHomeToViewModel } = await import('../view-models/home.js')
    const model = mapHomeToViewModel()
    expect(model.navItems).toBeInstanceOf(Array)
    expect(model.navItems.length).toBeGreaterThan(0)

    const navKeys = model.navItems.map(i => i.key)
    expect(navKeys).toContain('dashboard')
    expect(navKeys).toContain('status')
    expect(navKeys).toContain('activity')

    // Task-oriented items are in tasks, not navItems
    const taskRoutes = model.tasks.map(t => t.route)
    expect(taskRoutes).toContain('pr-queue')
    expect(taskRoutes).toContain('profile')
    expect(taskRoutes).toContain('workflow-runs')

    const taskLabels = model.tasks.map(t => t.label)
    expect(taskLabels).toContain('Start a workflow')
    expect(taskLabels).toContain('Watch running workflows')
    expect(taskLabels).toContain('Handle paused workflow approvals')
    expect(taskLabels).toContain('Save/share workflow')
    expect(taskLabels).toContain('Publish workflow to GitHub Issues')
  })

  it('returns default systemStatus when no data provided', async () => {
    const { mapHomeToViewModel } = await import('../view-models/home.js')
    const model = mapHomeToViewModel()
    expect(model.systemStatus).toBe('ready')
  })

  it('returns custom systemStatus', async () => {
    const { mapHomeToViewModel } = await import('../view-models/home.js')
    const model = mapHomeToViewModel({ systemStatus: 'degraded' })
    expect(model.systemStatus).toBe('degraded')
  })

  it('sanitizes terminal escape sequences from systemStatus', async () => {
    const { mapHomeToViewModel } = await import('../view-models/home.js')
    const model = mapHomeToViewModel({ systemStatus: 'ok\x1b[31m evil' })
    expect(model.systemStatus).toBe('ok evil')
  })
})

describe('mapWorkflowRunsToViewModel', () => {
  it('summarizes run progress for workflow run drilldown', async () => {
    const { mapWorkflowRunsToViewModel } = await import('../view-models/workflow-runs.js')
    const model = mapWorkflowRunsToViewModel([
      {
        runId: 'run-1',
        workflowName: 'audit',
        mode: 'execute',
        status: 'running',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:01:00.000Z',
        currentPhase: 'Scan',
        args: {},
        phaseCount: 1,
        agentCount: 1,
        pendingApprovalCount: 1,
        budget: {
          tokenBudget: 100,
          tokensUsed: 12,
          tokensRemaining: 88,
          agentCalls: 1,
          source: 'manifest',
        },
        phases: [{
          phase: 'Scan',
          status: 'running',
          agentCount: 1,
          tokenTotal: 12,
          cachedCount: 1,
          liveCount: 0,
          failedCount: 0,
          agents: [{
            id: 'agent-1',
            label: 'scan-api',
            phase: 'Scan',
            status: 'completed',
            cached: true,
            promptSummary: 'scan api',
            tokensUsed: 12,
            tokensRemaining: 88,
            recentTools: [],
            warnings: [],
          }],
          warnings: [],
        }],
        logTail: [],
        warnings: [],
      },
    ])

    expect(model.summary.running).toBe(1)
    expect(model.summary.pendingApprovals).toBe(1)
    expect(model.selectedRun?.phases[0].agents[0].label).toBe('scan-api')
  })
})

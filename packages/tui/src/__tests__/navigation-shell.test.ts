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
  it('returns menu items with correct keys', async () => {
    const { mapHomeToViewModel } = await import('../view-models/home.js')
    const model = mapHomeToViewModel()
    expect(model.menuItems).toBeInstanceOf(Array)
    expect(model.menuItems.length).toBeGreaterThan(0)

    const keys = model.menuItems.map(i => i.key)
    expect(keys).toContain('dashboard')
    expect(keys).toContain('pr-queue')
    expect(keys).toContain('status')
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

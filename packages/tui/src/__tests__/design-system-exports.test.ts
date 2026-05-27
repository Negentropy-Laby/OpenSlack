import { describe, it, expect } from 'vitest'

describe('@openslack/tui public API exports', () => {
  it('exports all design-system symbols', async () => {
    const mod = await import('@openslack/tui')

    // Theme utilities
    expect(mod.themes).toBeDefined()
    expect(mod.resolveTheme).toBeDefined()
    expect(mod.ThemeProvider).toBeDefined()
    expect(mod.useTheme).toBeDefined()

    // Themed components
    expect(mod.ThemedBox).toBeDefined()
    expect(mod.ThemedText).toBeDefined()
    expect(mod.StatusIcon).toBeDefined()
    expect(mod.categorizeStatus).toBeDefined()

    // Design-system components
    expect(mod.ProgressBar).toBeDefined()
    expect(mod.Divider).toBeDefined()
    expect(mod.ListItem).toBeDefined()
    expect(mod.Pane).toBeDefined()
    expect(mod.KeyboardShortcutHint).toBeDefined()
  })
})

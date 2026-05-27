import React from 'react'
import render from './ink/root.js'
import { ThemeProvider } from './design-system/ThemeProvider.js'
import { isTuiSupported } from './capabilities.js'
import type { ThemeMode } from './design-system/theme.js'

export interface RenderTuiOptions {
  mode?: ThemeMode
  stdout?: NodeJS.WriteStream
}

export async function renderTui(
  node: React.ReactElement,
  options?: RenderTuiOptions,
): Promise<{ unmount: () => void }> {
  if (!isTuiSupported() && !options?.stdout) {
    throw new Error(
      'TUI is not supported in this terminal. Use --format standard for text output.',
    )
  }

  const wrapped = React.createElement(
    ThemeProvider,
    { mode: options?.mode },
    node,
  )

  const instance = await render(wrapped, {
    stdout: options?.stdout,
    patchConsole: false,
  })

  return { unmount: () => instance.unmount() }
}

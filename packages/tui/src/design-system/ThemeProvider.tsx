import React, { createContext, useContext } from 'react'
import { resolveTheme, themes } from './theme.js'
import type { Theme, ThemeMode } from './theme.js'

export const ThemeContext = createContext<Theme>(themes.dark)

export function ThemeProvider({
  mode,
  theme,
  children,
}: {
  mode?: ThemeMode
  theme?: Theme
  children?: React.ReactNode
}): React.JSX.Element {
  const resolved = theme ?? (mode ? themes[mode] : resolveTheme())
  return React.createElement(ThemeContext.Provider, { value: resolved }, children)
}

export function useTheme(): Theme {
  return useContext(ThemeContext)
}

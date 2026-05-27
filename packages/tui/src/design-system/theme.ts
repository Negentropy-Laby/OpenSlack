import type { Color } from '../ink/styles.js'

export type ThemeMode = 'light' | 'dark'

export type ThemeColorKey =
  | 'success'
  | 'error'
  | 'warning'
  | 'info'
  | 'muted'
  | 'accent'
  | 'border'
  | 'pass'
  | 'blocker'
  | 'foreground'
  | 'background'

export interface Theme {
  readonly mode: ThemeMode
  readonly success: Color
  readonly error: Color
  readonly warning: Color
  readonly info: Color
  readonly muted: Color
  readonly accent: Color
  readonly border: Color
  readonly pass: Color
  readonly blocker: Color
  readonly foreground: Color
  readonly background: Color
}

export const themes: Record<ThemeMode, Theme> = {
  dark: {
    mode: 'dark',
    success: 'ansi:green',
    error: 'ansi:red',
    warning: 'ansi:yellow',
    info: 'ansi:cyan',
    muted: 'ansi:blackBright',
    accent: 'ansi:blueBright',
    border: 'ansi:blackBright',
    pass: 'ansi:green',
    blocker: 'ansi:red',
    foreground: 'ansi:white',
    background: 'ansi:black',
  },
  light: {
    mode: 'light',
    success: 'ansi:green',
    error: 'ansi:red',
    warning: 'ansi:yellow',
    info: 'ansi:cyan',
    muted: 'ansi:blackBright',
    accent: 'ansi:blue',
    border: 'ansi:blackBright',
    pass: 'ansi:green',
    blocker: 'ansi:red',
    foreground: 'ansi:black',
    background: 'ansi:white',
  },
}

export function resolveTheme(mode?: ThemeMode): Theme {
  if (mode) return themes[mode]

  const autoDisabled = process.env.OPENSLACK_AUTO_THEME === 'false'
  if (!autoDisabled) {
    const scheme = process.env.COLORSCHEME
    if (scheme === 'light' || scheme === '0') return themes.light
  }

  return themes.dark
}

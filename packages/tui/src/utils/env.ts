/**
 * Platform and environment detection for the OpenSlack TUI.
 *
 * Adapted from Aby's env.ts — keeps platform detection and terminal
 * identification; removes Aby-specific config paths, package-manager
 * detection, deployment-environment detection, and analytics helpers.
 */

import { isEnvTruthy } from './env-utils.js'

type Platform = 'win32' | 'darwin' | 'linux'

// ---------------------------------------------------------------------------
// Terminal detection
// ---------------------------------------------------------------------------

export const JETBRAINS_IDES = [
  'pycharm',
  'intellij',
  'webstorm',
  'phpstorm',
  'rubymine',
  'clion',
  'goland',
  'rider',
  'datagrip',
  'appcode',
  'dataspell',
  'aqua',
  'gateway',
  'fleet',
  'jetbrains',
  'androidstudio',
]

function detectTerminal(): string | null {
  if (process.env.CURSOR_TRACE_ID) return 'cursor'
  if (process.env.VSCODE_GIT_ASKPASS_MAIN?.includes('cursor')) return 'cursor'
  if (process.env.VSCODE_GIT_ASKPASS_MAIN?.includes('windsurf')) return 'windsurf'
  if (process.env.VSCODE_GIT_ASKPASS_MAIN?.includes('antigravity')) return 'antigravity'

  const bundleId = process.env.__CFBundleIdentifier?.toLowerCase()
  if (bundleId?.includes('vscodium')) return 'codium'
  if (bundleId?.includes('windsurf')) return 'windsurf'
  if (bundleId?.includes('com.google.android.studio')) return 'androidstudio'
  if (bundleId) {
    for (const ide of JETBRAINS_IDES) {
      if (bundleId.includes(ide)) return ide
    }
  }

  if (process.env.VisualStudioVersion) return 'visualstudio'

  if (process.env.TERMINAL_EMULATOR === 'JetBrains-JediTerm') {
    return 'pycharm'
  }

  if (process.env.TERM === 'xterm-ghostty') return 'ghostty'
  if (process.env.TERM?.includes('kitty')) return 'kitty'

  if (process.env.TERM_PROGRAM) return process.env.TERM_PROGRAM
  if (process.env.TMUX) return 'tmux'
  if (process.env.STY) return 'screen'

  if (process.env.KONSOLE_VERSION) return 'konsole'
  if (process.env.GNOME_TERMINAL_SERVICE) return 'gnome-terminal'
  if (process.env.XTERM_VERSION) return 'xterm'
  if (process.env.VTE_VERSION) return 'vte-based'
  if (process.env.TERMINATOR_UUID) return 'terminator'
  if (process.env.KITTY_WINDOW_ID) return 'kitty'
  if (process.env.ALACRITTY_LOG) return 'alacritty'
  if (process.env.TILIX_ID) return 'tilix'

  // Windows-specific detection
  if (process.env.WT_SESSION) return 'windows-terminal'
  if (process.env.SESSIONNAME && process.env.TERM === 'cygwin') return 'cygwin'
  if (process.env.MSYSTEM) return process.env.MSYSTEM.toLowerCase()
  if (process.env.ConEmuANSI || process.env.ConEmuPID || process.env.ConEmuTask) {
    return 'conemu'
  }

  // WSL detection
  if (process.env.WSL_DISTRO_NAME) return `wsl-${process.env.WSL_DISTRO_NAME}`

  // SSH session detection
  if (isSSHSession()) return 'ssh-session'

  if (process.env.TERM) {
    const term = process.env.TERM
    if (term.includes('alacritty')) return 'alacritty'
    if (term.includes('rxvt')) return 'rxvt'
    if (term.includes('termite')) return 'termite'
    return process.env.TERM ?? null
  }

  if (!process.stdout.isTTY) return 'non-interactive'

  return null
}

function isSSHSession(): boolean {
  return !!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY)
}

// ---------------------------------------------------------------------------
// Exported env object
// ---------------------------------------------------------------------------

export const env = {
  isCI: isEnvTruthy(process.env.CI),
  platform: (['win32', 'darwin'].includes(process.platform)
    ? process.platform
    : 'linux') as Platform,
  arch: process.arch,
  nodeVersion: process.version,
  terminal: detectTerminal(),
  isSSH: isSSHSession,
} as const

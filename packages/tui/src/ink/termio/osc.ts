/**
 * OSC (Operating System Command) Types and Parser
 *
 * Inert shim for OpenSlack TUI. All output-generating functions are no-ops.
 * Retains read-only terminal capability parsing (parseOSC, parseOscColor).
 * Does NOT port execFileNoThrow usage, clipboard native-copy, or getClipboardPath.
 */

import { ESC, ESC_TYPE } from './ansi.js'
import type { Action, Color, TabStatusAction } from './types.js'

export const OSC_PREFIX = ESC + String.fromCharCode(ESC_TYPE.OSC)

/** String Terminator (ESC \) - alternative to BEL for terminating OSC */
export const ST = ESC + '\\'

// ---------------------------------------------------------------------------
// Inert output generators — all return empty strings or no-op
// ---------------------------------------------------------------------------

/** Inert: returns empty string */
export function osc(..._parts: (string | number)[]): string {
  return ''
}

/** Inert: strips OSC sequences from input for safety */
export function wrapForMultiplexer(_sequence: string): string {
  return ''
}

// ---------------------------------------------------------------------------
// Clipboard — fully inert
// ---------------------------------------------------------------------------

/** Inert clipboard path type (retained for type compatibility) */
export type ClipboardPath = 'native' | 'tmux-buffer' | 'osc52'

/** Inert: returns osc52 (no native clipboard access) */
export function getClipboardPath(): ClipboardPath {
  return 'osc52'
}

/** Inert: resolves immediately with empty string */
export async function setClipboard(_text: string): Promise<string> {
  return ''
}

// ---------------------------------------------------------------------------
// OSC command numbers (read-only constants, retained)
// ---------------------------------------------------------------------------

export const OSC = {
  SET_TITLE_AND_ICON: 0,
  SET_ICON: 1,
  SET_TITLE: 2,
  SET_COLOR: 4,
  SET_CWD: 7,
  HYPERLINK: 8,
  ITERM2: 9,
  SET_FG_COLOR: 10,
  SET_BG_COLOR: 11,
  SET_CURSOR_COLOR: 12,
  CLIPBOARD: 52,
  KITTY: 99,
  RESET_COLOR: 104,
  RESET_FG_COLOR: 110,
  RESET_BG_COLOR: 111,
  RESET_CURSOR_COLOR: 112,
  SEMANTIC_PROMPT: 133,
  GHOSTTY: 777,
  TAB_STATUS: 21337,
} as const

// ---------------------------------------------------------------------------
// Read-only parsing (retained — does not output sequences)
// ---------------------------------------------------------------------------

/**
 * Parse an OSC sequence into an action
 *
 * @param content - The sequence content (without ESC ] and terminator)
 */
export function parseOSC(content: string): Action | null {
  const semicolonIdx = content.indexOf(';')
  const command = semicolonIdx >= 0 ? content.slice(0, semicolonIdx) : content
  const data = semicolonIdx >= 0 ? content.slice(semicolonIdx + 1) : ''

  const commandNum = parseInt(command, 10)

  // Window/icon title
  if (commandNum === OSC.SET_TITLE_AND_ICON) {
    return { type: 'title', action: { type: 'both', title: data } }
  }
  if (commandNum === OSC.SET_ICON) {
    return { type: 'title', action: { type: 'iconName', name: data } }
  }
  if (commandNum === OSC.SET_TITLE) {
    return { type: 'title', action: { type: 'windowTitle', title: data } }
  }

  // Hyperlinks (OSC 8)
  if (commandNum === OSC.HYPERLINK) {
    const parts = data.split(';')
    const paramsStr = parts[0] ?? ''
    const url = parts.slice(1).join(';')

    if (url === '') {
      return { type: 'link', action: { type: 'end' } }
    }

    const params: Record<string, string> = {}
    if (paramsStr) {
      for (const pair of paramsStr.split(':')) {
        const eqIdx = pair.indexOf('=')
        if (eqIdx >= 0) {
          params[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1)
        }
      }
    }

    return {
      type: 'link',
      action: {
        type: 'start',
        url,
        params: Object.keys(params).length > 0 ? params : undefined,
      },
    }
  }

  // Tab status (OSC 21337)
  if (commandNum === OSC.TAB_STATUS) {
    return { type: 'tabStatus', action: parseTabStatus(data) }
  }

  return { type: 'unknown', sequence: `\x1b]${content}` }
}

/**
 * Parse an XParseColor-style color spec into an RGB Color.
 * Accepts `#RRGGBB` and `rgb:R/G/B` (1-4 hex digits per component, scaled
 * to 8-bit). Returns null on parse failure.
 */
export function parseOscColor(spec: string): Color | null {
  const hex = spec.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (hex) {
    return {
      type: 'rgb',
      r: parseInt(hex[1]!, 16),
      g: parseInt(hex[2]!, 16),
      b: parseInt(hex[3]!, 16),
    }
  }
  const rgb = spec.match(/^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i)
  if (rgb) {
    const scale = (s: string) => Math.round((parseInt(s, 16) / (16 ** s.length - 1)) * 255)
    return {
      type: 'rgb',
      r: scale(rgb[1]!),
      g: scale(rgb[2]!),
      b: scale(rgb[3]!),
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Internal helpers (retained for parseOSC)
// ---------------------------------------------------------------------------

/** Parse OSC 21337 payload */
function parseTabStatus(data: string): TabStatusAction {
  const action: TabStatusAction = {}
  for (const [key, value] of splitTabStatusPairs(data)) {
    switch (key) {
      case 'indicator':
        action.indicator = value === '' ? null : parseOscColor(value)
        break
      case 'status':
        action.status = value === '' ? null : value
        break
      case 'status-color':
        action.statusColor = value === '' ? null : parseOscColor(value)
        break
    }
  }
  return action
}

/** Split `k=v;k=v` honoring `\;` and `\\` escapes. Yields [key, unescapedValue]. */
function* splitTabStatusPairs(data: string): Generator<[string, string]> {
  let key = ''
  let val = ''
  let inVal = false
  let esc = false
  for (const c of data) {
    if (esc) {
      if (inVal) val += c
      else key += c
      esc = false
    } else if (c === '\\') {
      esc = true
    } else if (c === ';') {
      yield [key, val]
      key = ''
      val = ''
      inVal = false
    } else if (c === '=' && !inVal) {
      inVal = true
    } else if (inVal) {
      val += c
    } else {
      key += c
    }
  }
  if (key || inVal) yield [key, val]
}

// ---------------------------------------------------------------------------
// Inert output constants — empty strings
// ---------------------------------------------------------------------------

/** Inert: returns empty string (OSC 8 disabled) */
export function link(_url: string, _params?: Record<string, string>): string {
  return ''
}

/** Inert: empty string */
export const LINK_END = ''

// iTerm2 OSC 9 subcommands — retained constants
export const ITERM2 = {
  NOTIFY: 0,
  BADGE: 2,
  PROGRESS: 4,
} as const

/** Progress operation codes */
export const PROGRESS = {
  CLEAR: 0,
  SET: 1,
  ERROR: 2,
  INDETERMINATE: 3,
} as const

/** Inert: empty string */
export const CLEAR_ITERM2_PROGRESS = ''

/** Inert: empty string */
export const CLEAR_TERMINAL_TITLE = ''

/** Inert: empty string */
export const CLEAR_TAB_STATUS = ''

/** Inert: always returns false (tab status not supported) */
export function supportsTabStatus(): boolean {
  return false
}

/** Inert: no-op, returns empty string */
export function tabStatus(_fields: TabStatusAction): string {
  return ''
}

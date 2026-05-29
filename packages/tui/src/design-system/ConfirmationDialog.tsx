// @openslack/tui — Confirmation dialog component

import React from 'react'
import Box from '../ink/components/Box.js'
import ThemedBox from './ThemedBox.js'
import ThemedText from './ThemedText.js'
import useInput from '../ink/hooks/use-input.js'
import { sanitizeTerminalText } from '../sanitize.js'
import type { ThemeColorKey } from './theme.js'
import type { TuiAction, TuiRiskLevel } from '../actions/types.js'

const RISK_THEME_KEY: Record<TuiRiskLevel, ThemeColorKey> = {
  low: 'info',
  medium: 'warning',
  high: 'error',
  critical: 'blocker',
}

const RISK_LABEL: Record<TuiRiskLevel, string> = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
  critical: 'CRITICAL',
}

export interface ConfirmationDialogProps {
  /** The action awaiting confirmation. */
  action: TuiAction
  /** Called when user confirms (y). */
  onConfirm: () => void
  /** Called when user cancels (n / q / Escape). */
  onCancel: () => void
  /** Whether the dialog is active (controls useInput). */
  isActive?: boolean
}

export default function ConfirmationDialog({
  action,
  onConfirm,
  onCancel,
  isActive = true,
}: ConfirmationDialogProps): React.JSX.Element {
  useInput(
    (input, key) => {
      if (input === 'y' || input === 'Y') {
        onConfirm()
      } else if (
        input === 'n' ||
        input === 'N' ||
        input === 'q' ||
        input === 'Q' ||
        key.escape
      ) {
        onCancel()
      }
    },
    { isActive },
  )

  const riskColor: ThemeColorKey = RISK_THEME_KEY[action.risk]
  const riskLabel = RISK_LABEL[action.risk]
  const safeLabel = sanitizeTerminalText(action.label)
  const safeDescription = sanitizeTerminalText(action.description)

  return React.createElement(
    ThemedBox,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderTheme: action.risk === 'critical' || action.risk === 'high' ? 'error' : 'border',
      paddingX: 1,
    },
    // Header line: risk badge + label
    React.createElement(
      ThemedBox,
      { flexDirection: 'row', marginBottom: 1 },
      React.createElement(ThemedText, { colorTheme: riskColor, bold: true }, `[${riskLabel}]`),
      React.createElement(ThemedText, null, ' '),
      React.createElement(ThemedText, { colorTheme: 'foreground', bold: true }, safeLabel),
    ),
    // Description
    React.createElement(
      ThemedText,
      { colorTheme: 'muted' },
      safeDescription,
    ),
    // Separator
    React.createElement(ThemedText, { colorTheme: 'border' }, '---'),
    // Prompt
    React.createElement(
      ThemedBox,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'foreground' }, 'Confirm? '),
      React.createElement(
        Box,
        { onClick: () => onConfirm() },
        React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, '[y]'),
      ),
      React.createElement(ThemedText, null, '/'),
      React.createElement(
        Box,
        { onClick: () => onCancel() },
        React.createElement(ThemedText, { colorTheme: 'muted' }, '[N]'),
      ),
    ),
  )
}

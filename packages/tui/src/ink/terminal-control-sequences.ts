const TERMINAL_CONTROL_SEQUENCE_RE =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\))/

export function hasTerminalControlSequence(text: string): boolean {
  return TERMINAL_CONTROL_SEQUENCE_RE.test(text)
}

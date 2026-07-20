export function sanitizeTerminalText(input: string): string {
  return (
    input
      // 1. CSI sequences: ESC [ <parameter bytes 0x30-0x3F>* <intermediate bytes 0x20-0x2F>* <final byte 0x40-0x7E>
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // 2. OSC sequences: ESC ] ... terminated by BEL (0x07) or ST (ESC \)
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
      // 3. C0 controls except LF (0x0A) and TAB (0x09)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  );
}

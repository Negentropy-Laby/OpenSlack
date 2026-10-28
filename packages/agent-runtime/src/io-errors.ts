/** Inspect an ownable OS error code without treating arbitrary failures as absence. */
export function isCode(value: unknown, code: string): boolean {
  return !!value && typeof value === 'object' && 'code' in value && value.code === code;
}

import { describe, expect, it } from 'vitest';
import { resolveTestMaxWorkers } from '../../../vitest.config.js';

describe('qualification test runtime', () => {
  it('bounds Windows workers without changing other platform defaults', () => {
    expect(resolveTestMaxWorkers('win32')).toBe(4);
    expect(resolveTestMaxWorkers('linux')).toBeUndefined();
    expect(resolveTestMaxWorkers('darwin')).toBeUndefined();
  });
});

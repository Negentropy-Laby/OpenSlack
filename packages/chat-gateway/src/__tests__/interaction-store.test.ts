import { describe, it, expect, beforeEach } from 'vitest';
import { isDuplicate, markProcessed, clearStore, getProcessedCount } from '../interaction-store.js';

describe('interaction-store', () => {
  beforeEach(() => {
    clearStore();
  });

  it('detects duplicate by message ID', () => {
    expect(isDuplicate('m1', 'hello', 'u1', 'c1')).toBe(false);
    markProcessed('m1', 'hello', 'u1', 'c1');
    expect(isDuplicate('m1', 'hello', 'u1', 'c1')).toBe(true);
  });

  it('detects duplicate by content hash', () => {
    markProcessed('m1', 'hello', 'u1', 'c1');
    expect(isDuplicate('m2', 'hello', 'u1', 'c1')).toBe(true);
  });

  it('allows different messages', () => {
    markProcessed('m1', 'hello', 'u1', 'c1');
    expect(isDuplicate('m2', 'world', 'u1', 'c1')).toBe(false);
  });

  it('tracks processed count', () => {
    expect(getProcessedCount()).toBe(0);
    markProcessed('m1', 'a', 'u1', 'c1');
    expect(getProcessedCount()).toBe(1);
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashHarnessInput } from '../harness-admission.js';

const digest = (json: string) => createHash('sha256').update(json).digest('hex');

describe('Harness inert canonical input compatibility', () => {
  it.each([
    [{ b: 2, a: 1 }, '{"a":1,"b":2}'],
    [{ missing: undefined, a: [1, null, true, 'text'] }, '{"a":[1,null,true,"text"]}'],
    [{ request: { correlationId: undefined, worktreePath: undefined, prompt: 'task' } }, '{"request":{"prompt":"task"}}'],
    [JSON.parse('{"__proto__":{"b":2,"a":1}}'), '{"__proto__":{"a":1,"b":2}}'],
  ])('retains the existing canonical digest for legitimate JSON %#', (input, json) => {
    expect(hashHarnessInput(input)).toBe(digest(json as string));
  });

  it.each([
    ['NaN', { x: NaN }], ['Infinity', { x: Infinity }], ['negative infinity', { x: -Infinity }],
    ['array undefined', [undefined]], ['sparse array', new Array(1)],
    ['function', { x: () => 1 }], ['bigint', { x: 1n }], ['symbol', { x: Symbol('fixture') }],
    ['date', { x: new Date(0) }], ['map', new Map([['x', 1]])],
  ])('rejects non-JSON %s instead of aliasing an admitted input', (_label, input) => {
    expect(() => hashHarnessInput(input)).toThrowError(expect.objectContaining({ code: 'HARNESS_INPUT_INVALID' }));
  });

  it('does not invoke getters or normalize cycles and symbol keys into another task', () => {
    let observed = 0;
    const accessor = Object.defineProperty({}, 'x', { enumerable: true, get() { observed++; return 1; } });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const input of [accessor, cycle, { [Symbol('hidden')]: 1 }]) {
      expect(() => hashHarnessInput(input)).toThrowError(expect.objectContaining({ code: 'HARNESS_INPUT_INVALID' }));
    }
    expect(observed).toBe(0);
  });

  it('permits repeated inert references without treating them as a cycle', () => {
    const value = { text: 'fixture' };
    expect(hashHarnessInput([value, value])).toBe(digest('[{"text":"fixture"},{"text":"fixture"}]'));
    expect(hashHarnessInput({ x: null })).toBe(digest('{"x":null}'));
  });
});

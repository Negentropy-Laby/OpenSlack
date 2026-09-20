import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTaskLinkMarker } from '../task-link.js';

// Independent golden bytes matching the public runtime renderer contract.
const marker = readFileSync(
  new URL('../../../runtime/src/__tests__/fixtures/task-link-golden.txt', import.meta.url),
  'utf8',
).trimEnd();

describe('cleanup task-link evidence', () => {
  it('distinguishes absent from valid', () => {
    expect(parseTaskLinkMarker('Ordinary PR')).toEqual({ state: 'ABSENT' });
    expect(parseTaskLinkMarker(marker)).toMatchObject({
      state: 'VALID',
      metadata: { issue_number: 42 },
    });
  });
  it.each([
    '<!-- openslack-task-link {broken} -->',
    marker + marker,
    marker.replace('"issue_number": 42', '"issue_number": "42"'),
    marker.replace('issue-42', 'issue-43'),
    marker.replace('RUN-42', '../secret'),
    marker.replace('openslack.task_link.v1', 'wrong'),
    marker.slice(0, -3),
    marker.replace('"agent_id": "repair"', '"agent_id": ""'),
  ])('rejects invalid evidence rather than treating it as human work', (body) => {
    expect(parseTaskLinkMarker(body).state).toBe('INVALID');
  });
});

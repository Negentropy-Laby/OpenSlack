import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateWorkflowLocalShadowConfig } from '../internal/workflow-local-shadow-config.js';

const workspaceRoot = resolve('workflow-local-shadow-config-workspace');
const route = '/v1/shadow/workflow-control/effect-events';
const protectedRelativeRoots = [
  join('workflows', 'effect-approvals'),
  join('workflows', 'effect-authority'),
];

function validate(endpoint: string, journalRoot: string) {
  return validateWorkflowLocalShadowConfig({
    workspaceRoot,
    journalRoot,
    endpoint,
    routes: [route],
    protectedRelativeRoots,
  });
}

describe('Workflow local shadow configuration', () => {
  it.each([
    'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
    'http://[::1]:8084/v1/shadow/workflow-control/effect-events',
  ])('accepts an exact loopback route at %s', (endpoint) => {
    expect(
      validate(endpoint, join(workspaceRoot, '.openslack.local', 'workflow-effect-shadow')),
    ).toMatchObject({ endpoint: new URL(endpoint) });
  });

  it('preserves the checkpoint origin form while allowing its exact route', () => {
    for (const endpoint of [
      'http://127.0.0.1:8085',
      'http://127.0.0.1:8085/v1/shadow/workflow-control/checkpoints',
    ]) {
      expect(() =>
        validateWorkflowLocalShadowConfig({
          workspaceRoot,
          journalRoot: join(workspaceRoot, '.openslack.local', 'checkpoint-shadow'),
          endpoint,
          routes: ['/', '/v1/shadow/workflow-control/checkpoints'],
        }),
      ).not.toThrow();
    }
  });

  it.each([
    'http://localhost:8084/v1/shadow/workflow-control/effect-events',
    'http://127.0.0.1:8084\\v1\\shadow\\workflow-control\\effect-events',
    'http://127.0.0.01:8084/v1/shadow/workflow-control/effect-events',
    'http://user@127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
    'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events?retry=1',
    'http://127.0.0.1:8084/v1/shadow/workflow-control/checkpoints',
  ])('rejects a non-exact endpoint at %s', (endpoint) => {
    expect(() =>
      validate(endpoint, join(workspaceRoot, '.openslack.local', 'workflow-effect-shadow')),
    ).toThrow(/exact loopback/u);
  });

  it.each([
    join(workspaceRoot, '.openslack.local'),
    workspaceRoot,
    join(workspaceRoot, '.openslack.local', 'workflows'),
    join(workspaceRoot, '.openslack.local', 'workflows', 'effect-approvals', 'shadow'),
    join(workspaceRoot, '.openslack.local', 'workflows', 'effect-authority'),
  ])('rejects a root or protected overlap at %s', (journalRoot) => {
    expect(() =>
      validate('http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events', journalRoot),
    ).toThrow();
  });
});

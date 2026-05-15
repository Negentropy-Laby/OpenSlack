import { describe, it, expect } from 'vitest';
import { classifyPaths } from '../zones.js';

describe('classifyPaths', () => {
  it('classifies docs changes as green', () => {
    expect(classifyPaths(['docs/product.md'])).toBe('green');
  });

  it('classifies template changes as green', () => {
    expect(classifyPaths(['templates/new-agent/START_HERE.md'])).toBe('green');
  });

  it('classifies task state as green', () => {
    expect(classifyPaths(['.openslack/tasks/open/TASK-001.yaml'])).toBe('green');
  });

  it('classifies package core changes as yellow', () => {
    expect(classifyPaths(['packages/core/src/claim-broker.ts'])).toBe('yellow');
  });

  it('classifies workspace-engine changes as yellow', () => {
    expect(classifyPaths(['packages/workspace-engine/src/validate.ts'])).toBe('yellow');
  });

  it('classifies evals changes as yellow', () => {
    expect(classifyPaths(['packages/evals/src/runner.ts'])).toBe('yellow');
  });

  it('classifies self-evolution ops changes as yellow', () => {
    expect(classifyPaths(['packages/self-evolution/src/ops/observe.ts'])).toBe('yellow');
  });

  it('classifies GitHub workflow changes as red', () => {
    expect(classifyPaths(['.github/workflows/test.yml'])).toBe('red');
  });

  it('classifies policy source changes as red', () => {
    expect(classifyPaths(['packages/policy/src/zones.ts'])).toBe('red');
  });

  it('classifies agent prompt changes as red', () => {
    expect(classifyPaths(['.openslack/agents/prompts/codex_agent.md'])).toBe('red');
  });

  it('classifies agent registry changes as red', () => {
    expect(classifyPaths(['.openslack/agents/registry/codex_agent.yaml'])).toBe('red');
  });

  it('classifies constitution.md change as red', () => {
    expect(classifyPaths(['.openslack/self/constitution.md'])).toBe('red');
  });

  it('classifies invariants.yaml change as red', () => {
    expect(classifyPaths(['.openslack/self/invariants.yaml'])).toBe('red');
  });

  it('classifies self-evolution core changes as red', () => {
    expect(classifyPaths(['packages/self-evolution/src/core/classify-pr.ts'])).toBe('red');
  });

  it('classifies .env as black', () => {
    expect(classifyPaths(['.env'])).toBe('black');
  });

  it('classifies private key as black', () => {
    expect(classifyPaths(['certs/server.key'])).toBe('black');
  });

  it('classifies pem file as black', () => {
    expect(classifyPaths(['ca.pem'])).toBe('black');
  });

  it('classifies secrets directory as black', () => {
    expect(classifyPaths(['secrets/token.txt'])).toBe('black');
  });

  it('returns most restrictive zone for mixed paths (red + green → red)', () => {
    expect(classifyPaths(['docs/readme.md', '.github/workflows/test.yml'])).toBe('red');
  });

  it('returns black for any black path mixed with others', () => {
    expect(classifyPaths(['docs/readme.md', '.env'])).toBe('black');
  });

  it('returns red for yellow + red mixed', () => {
    expect(classifyPaths(['packages/core/src/foo.ts', '.github/workflows/test.yml'])).toBe('red');
  });
});

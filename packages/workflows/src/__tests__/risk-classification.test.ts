import { describe, expect, it } from 'vitest';
import { classifyPathGroups, classifyPathGroupsExact } from '../risk-classification.js';

const mixedPaths = [
  'docs/readme.md',
  '.env',
  '.github/workflows/validate.yml',
  'secrets/token.txt',
  'new-root-config.yaml',
];

describe('workflow risk classification', () => {
  it('preserves the legacy three-bucket contract and input order', () => {
    expect(classifyPathGroups(mixedPaths)).toEqual({
      green: ['docs/readme.md'],
      yellow: ['new-root-config.yaml'],
      red: ['.env', '.github/workflows/validate.yml', 'secrets/token.txt'],
    });
  });

  it('exposes an exact four-bucket result for callers that must distinguish Black', () => {
    expect(classifyPathGroupsExact(mixedPaths)).toEqual({
      green: ['docs/readme.md'],
      yellow: ['new-root-config.yaml'],
      red: ['.github/workflows/validate.yml'],
      black: ['.env', 'secrets/token.txt'],
    });
  });
});

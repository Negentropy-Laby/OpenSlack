import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      '**/dist/**',
      '**/*.d.ts',
      '**/*.d.ts.map',
      'node_modules/**',
      '.aby/**',
      '.openslack.local/**',
      '.worktrees/**',
      '.claude/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
    },
  },
  {
    files: ['packages/tui/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          property: 'padEnd',
          message:
            'Use stringWidth-aware padding from packages/tui/src/ink/stringWidth.ts instead of padEnd(). padEnd counts UTF-16 code units, not terminal cells.',
        },
        {
          property: 'padStart',
          message:
            'Use stringWidth-aware padding from packages/tui/src/ink/stringWidth.ts instead of padStart(). padStart counts UTF-16 code units, not terminal cells.',
        },
      ],
    },
  },
);

import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', '**/dist/**', '**/*.d.ts', '**/*.d.ts.map', 'node_modules/**', '.aby/**', '.openslack.local/**', '.worktrees/**', '.claude/**'],
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
);

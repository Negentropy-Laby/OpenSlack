import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'qualification-capstone',
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'live-capstone',
    root: import.meta.dirname,
  },
});

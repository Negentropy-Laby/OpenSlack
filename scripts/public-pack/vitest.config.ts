import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'public-pack',
    root: import.meta.dirname,
  },
});

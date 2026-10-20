import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/live.integration.ts'],
    testTimeout: 120000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});

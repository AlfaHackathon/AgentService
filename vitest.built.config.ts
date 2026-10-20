import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/built.integration.ts'],
    testTimeout: 90000,
    hookTimeout: 30000,
    setupFiles: ['./tests/setup.ts'],
    fileParallelism: false,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/src/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['{apps,packages}/*/src/**/*.int.test.ts'],
          environment: 'node',
          globalSetup: ['packages/db/test/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
          // Integration suites share one Postgres/Valkey; run files serially for isolation.
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/{api,worker}/src/**'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});

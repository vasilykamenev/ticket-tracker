import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration tests share one database.
    fileParallelism: false,
    // In CI: annotations on the pull request, and a JUnit file for the test report (see ci.yml).
    reporters: process.env.CI ? ['default', 'github-actions', 'junit'] : ['default'],
    outputFile: { junit: 'test-results/junit.xml' },
    // `npm run test:coverage`; CI runs it too and shows the table on the pull request.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Components are bundled for the browser and the CLI entry points are exercised by smoke checks.
      exclude: ['src/admin/components/**', 'src/cli/**'],
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: 'coverage',
    },
  },
});

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
  },
});

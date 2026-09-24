import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: 'extension.spec.ts', workers: 1, fullyParallel: false,
  timeout: 30_000, expect: { timeout: 8_000 }, reporter: 'list',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});

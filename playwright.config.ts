import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end smoke tests against a running stack:
 *   - locally: `pnpm dev` (web on :5173) or the compose `app` profile (:8080)
 *   - CI: the compose `app` profile with LLM_PROVIDER=mock
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

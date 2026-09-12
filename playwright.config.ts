/*
  Playwright e2e configuration (docs/spec/05-TEST-STRATEGY.md §1.2, adapted to the real build):
    - one Next dev server on the firewall-allowed port 3005 (reused when already running),
    - one chromium project on swiftshader GL (no GPU on the box), 1600x950 css px at dpr 1,
    - the sim is deterministic per page (no RAF in test mode), so tests are independent and
      may run 2 abreast; files themselves stay serial (fullyParallel: false).
  Run: `bash scripts/e2e.sh smoke` / `npm run test:e2e`.
*/
import { defineConfig } from '@playwright/test';

export const E2E_PORT = Number(process.env.E2E_PORT ?? 3005);
export const E2E_BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${E2E_PORT}`;
const CI = !!process.env.CI;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: Number(process.env.E2E_WORKERS ?? 2),
  retries: Number(process.env.E2E_RETRIES ?? 1),
  timeout: 90_000,
  expect: { timeout: 10_000 },
  forbidOnly: CI,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  outputDir: 'test-results',
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}',

  use: {
    baseURL: E2E_BASE_URL,
    headless: true,
    viewport: { width: 1600, height: 950 },
    deviceScaleFactor: 1,
    trace: 'on-first-retry',
    video: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
    // The seeded sim clock never moves on its own in test mode; wall-clock animations are the only source of motion.
    reducedMotion: 'reduce',
    launchOptions: {
      args: [
        '--use-gl=swiftshader',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        '--disable-gpu-sandbox',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--mute-audio',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },

  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],

  webServer: {
    command: `npx next dev -p ${E2E_PORT} -H 0.0.0.0`,
    url: `${E2E_BASE_URL}/`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_ATC_TEST: '1' },
  },
});

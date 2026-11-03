// Playwright smoke tests (e2e/*.spec.ts). Run with `npm run test:e2e`.
//
// Kept apart from `npm test`: those are tsx files in tests/, these drive a real browser against the
// static pages with every function stubbed (e2e/fixtures.ts), so they need no database or secrets.
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT || 4173);

export default defineConfig({
    testDir: 'e2e',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    // Locally the html report is always kept and live progress is written for SwanJira's
    // "Automated tests" tab (e2e/live-progress-reporter.ts).
    reporter: process.env.CI
        ? [['list'], ['html', { open: 'never' }]]
        : [['list'], ['html', { open: 'never' }], ['./e2e/live-progress-reporter.ts']],
    use: {
        baseURL: `http://127.0.0.1:${port}`,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [
        { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /phone\.spec\.ts/ },
        { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: /phone\.spec\.ts/ },
    ],
    webServer: {
        command: 'node e2e/static-server.mjs',
        url: `http://127.0.0.1:${port}/login.html`,
        reuseExistingServer: !process.env.CI,
        env: { E2E_PORT: String(port) },
    },
});

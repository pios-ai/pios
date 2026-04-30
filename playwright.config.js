// @ts-check
'use strict';
/**
 * Playwright config — PiOS Mobile M1 responsive smoke tests
 *
 * Tests: tests/mobile-responsive.spec.js
 * Viewports: iPhone SE (375x812), iPhone 16 Pro Max (430x932), Z Fold展开 (768x1024)
 *
 * Requires:
 *   npm install --save-dev @playwright/test
 *   npx playwright install --with-deps chromium webkit
 *
 * CI: .github/workflows/mobile-m1.yml (playwright-tests job)
 */

const { defineConfig, devices } = require('@playwright/test');

const BACKEND = process.env.PIOS_BACKEND_URL || 'http://localhost:17892';

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BACKEND,
    // No auth header in base — tests set it individually via page.setExtraHTTPHeaders
  },
  projects: [
    {
      name: 'iPhone SE',
      use: {
        ...devices['iPhone SE'],
        viewport: { width: 375, height: 812 },
      },
    },
    {
      name: 'iPhone 16 Pro Max',
      use: {
        ...devices['iPhone 14 Pro Max'],  // closest Playwright device
        viewport: { width: 430, height: 932 },
      },
    },
    {
      name: 'Z Fold Unfolded (tablet)',
      use: {
        ...devices['iPad Mini'],  // approximate tablet viewport
        viewport: { width: 768, height: 1024 },
      },
    },
  ],
});

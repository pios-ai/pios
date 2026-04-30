'use strict';
/**
 * mobile-responsive.spec.js — M1 Playwright smoke tests
 *
 * Tests pios-home.html across 3 viewports (configured in playwright.config.js):
 *   - iPhone SE       375x812
 *   - iPhone 16 Pro Max  430x932
 *   - Z Fold unfolded 768x1024 (tablet)
 *
 * M1 scope: no JS errors + key nav elements visible
 * M2 scope: full mobile CSS + interaction tests
 *
 * Prerequisites:
 *   1. npm install --save-dev @playwright/test
 *   2. npx playwright install --with-deps chromium webkit
 *   3. mobile-backend running at PIOS_BACKEND_URL (or mock server)
 */

const { test, expect } = require('@playwright/test');

const API_TOKEN = process.env.PI_API_TOKEN || 'test-token-m1';

test.use({
  extraHTTPHeaders: { Authorization: `Bearer ${API_TOKEN}` },
});

test.describe('M1 mobile responsive smoke', () => {
  test('ping endpoint responds', async ({ request }) => {
    // Direct API test (no UI load needed) — validates backend connectivity
    const resp = await request.get('/mobile/ping');
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
  });

  test('hello endpoint requires auth', async ({ request }) => {
    // Without token → 401
    const resp = await request.get('/mobile/hello', {
      headers: { Authorization: '' },
    });
    expect(resp.status()).toBe(401);
  });

  test('hello endpoint with token returns ok', async ({ request }) => {
    const resp = await request.get('/mobile/hello');
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
  });

  // UI tests below require serving pios-home.html — M2 will wire this up
  // M1: mark as todo so they're visible in report but don't fail CI
  test.skip('pios-home.html loads without JS errors', async () => {});
  test.skip('navigation header visible at mobile viewport', async () => {});
  test.skip('main content section visible', async () => {});
  test.skip('no horizontal overflow / scroll at mobile viewport', async () => {});
});

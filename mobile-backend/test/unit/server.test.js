'use strict';
/**
 * server.test.js — M1 mobile-backend node --test unit tests
 *
 * Runs against a test instance on port 17893 (avoids clashing with prod :17892)
 * Auth token forced to 'test-token-m1' via env.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// Set env before requiring server module
process.env.MOBILE_API_TOKEN = 'test-token-m1';
process.env.PORT = '17893';
process.env.LOG_PATH = '/tmp/pios-mobile-backend-test.log';

const { server } = require('../../server.js');

// ── HTTP helper ───────────────────────────────────────────────────────────────

function req(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: 17893,
      path: urlPath,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };
    const r = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

const AUTH = { Authorization: 'Bearer test-token-m1' };

// ── Lifecycle ─────────────────────────────────────────────────────────────────

before(() => new Promise((resolve) => server.listen(17893, '127.0.0.1', resolve)));
after(() => new Promise((resolve) => server.close(resolve)));

// ── Tests ─────────────────────────────────────────────────────────────────────

test('GET /mobile/ping — 200 without auth', async () => {
  const { status, body } = await req('/mobile/ping');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(typeof body.ts === 'number', 'ts should be a number');
  assert.ok(body.service, 'service field present');
});

test('GET / — 200 HTML hello page (no auth)', async () => {
  const { status, body } = await req('/');
  assert.equal(status, 200);
  assert.equal(typeof body, 'string', 'body should be raw HTML string');
  assert.ok(body.includes('<!DOCTYPE html>'), 'is HTML doctype');
  // owner_name resolves via ~/.pios/config.json or PIOS_OWNER_NAME env;
  // we just assert the greeting wraps a non-empty owner string
  assert.match(body, /<h1>Hello, [^<]+<\/h1>/, 'greets owner');
  assert.ok(body.includes('pios-mobile-backend'), 'shows service name');
});

test('GET /mobile/hello — 401 without token', async () => {
  const { status, body } = await req('/mobile/hello');
  assert.equal(status, 401);
  assert.ok(body.error, 'error field present');
});

test('GET /mobile/hello — 401 with wrong token', async () => {
  const { status } = await req('/mobile/hello', {
    headers: { Authorization: 'Bearer wrong-token' },
  });
  assert.equal(status, 401);
});

test('GET /mobile/hello — 200 with correct token', async () => {
  const { status, body } = await req('/mobile/hello', { headers: AUTH });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.message.includes('PiOS'), 'message mentions PiOS');
  assert.ok(body.version, 'version field present');
});

test('POST /mobile/register-push-token — 200 with valid body', async () => {
  const payload = JSON.stringify({ device_type: 'ios', token: 'apns-xyz-123', device_id: 'iphone-test' });
  const { status, body } = await req('/mobile/register-push-token', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: payload,
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test('POST /mobile/register-push-token — 400 missing token field', async () => {
  const payload = JSON.stringify({ device_type: 'ios' });  // missing token
  const { status, body } = await req('/mobile/register-push-token', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: payload,
  });
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('POST /mobile/register-push-token — 400 invalid JSON', async () => {
  const { status, body } = await req('/mobile/register-push-token', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: 'not-json',
  });
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('GET /mobile/unknown — 404', async () => {
  const { status, body } = await req('/mobile/unknown', { headers: AUTH });
  assert.equal(status, 404);
  assert.ok(body.error);
});

test('OPTIONS preflight — 204 (CORS)', async () => {
  const { status } = await req('/mobile/hello', { method: 'OPTIONS' });
  assert.equal(status, 204);
});

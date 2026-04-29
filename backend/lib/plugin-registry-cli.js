#!/usr/bin/env node
/**
 * plugin-registry-cli.js — CLI entry-point for plugin-registry.
 *
 * Invoked by pi-triage-pregate.sh and core triage prompt to run plugin hooks
 * without starting a full Node server.
 *
 * Usage:
 *   node plugin-registry-cli.js gate-all
 *       Runs runAllGates({host}), atomically writes results to
 *       PLUGIN_TRIAGE_STATE_FILE, exits 0 if any plugin fired, 1 otherwise.
 *
 *   node plugin-registry-cli.js ingest <pluginId>
 *       Runs runIngest(pluginId, gatePayload) where gatePayload is read from
 *       PIOS_PLUGIN_GATE_PAYLOAD env var (JSON string).
 *       Prints JSON result to stdout, exits 0 on success.
 *
 * Environment variables:
 *   PIOS_VAULT                  — vault root (required)
 *   PIOS_HOST                   — hostname key (optional, defaults to os.hostname)
 *   PIOS_OWNER                  — owner key (optional, defaults to 'owner')
 *   PLUGIN_TRIAGE_STATE_FILE    — output path for gate-all results (gate-all only)
 *   PIOS_PLUGIN_GATE_PAYLOAD    — JSON gate payload for ingest command
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const registry = require('./plugin-registry');

async function main() {
  const [, , cmd, ...args] = process.argv;
  const host = process.env.PIOS_HOST || os.hostname().split('.')[0];

  // ── gate-all ──────────────────────────────────────────────────────────────
  if (cmd === 'gate-all') {
    let results;
    try {
      results = await registry.runAllGates({ host });
    } catch (err) {
      process.stderr.write(`[plugin-registry-cli] gate-all error: ${err.message}\n`);
      process.exit(1);
    }

    const stateFile = process.env.PLUGIN_TRIAGE_STATE_FILE;
    if (stateFile) {
      try {
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        const tmp = `${stateFile}.tmp.${process.pid}.${Date.now()}`;
        fs.writeFileSync(
          tmp,
          JSON.stringify({ host, results, updated_at: new Date().toISOString() }, null, 2) + '\n'
        );
        fs.renameSync(tmp, stateFile);
      } catch (err) {
        process.stderr.write(`[plugin-registry-cli] state write error: ${err.message}\n`);
        // Non-fatal — still exit based on fire result.
      }
    }

    const anyFire = Object.values(results).some(r => r && r.fire);
    process.exit(anyFire ? 0 : 1);

  // ── ingest ────────────────────────────────────────────────────────────────
  } else if (cmd === 'ingest') {
    const pluginId = args[0];
    if (!pluginId) {
      process.stderr.write('[plugin-registry-cli] ingest requires <pluginId>\n');
      process.exit(1);
    }

    let gatePayload = {};
    try {
      gatePayload = JSON.parse(process.env.PIOS_PLUGIN_GATE_PAYLOAD || '{}');
    } catch {
      process.stderr.write('[plugin-registry-cli] PIOS_PLUGIN_GATE_PAYLOAD is not valid JSON; using {}\n');
    }

    let result;
    try {
      result = await registry.runIngest(pluginId, gatePayload, { host });
    } catch (err) {
      process.stderr.write(`[plugin-registry-cli] ingest error: ${err.message}\n`);
      process.exit(1);
    }

    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);

  // ── unknown ───────────────────────────────────────────────────────────────
  } else {
    process.stderr.write(
      `[plugin-registry-cli] unknown command: ${cmd || '(none)'}\n` +
      'Usage: gate-all | ingest <pluginId>\n'
    );
    process.exit(1);
  }
}

main().catch(err => {
  process.stderr.write(`[plugin-registry-cli] unhandled error: ${err.message}\n`);
  process.exit(1);
});
